import { z } from 'zod';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { AppDispatch } from '../store';
import { connectionActions } from '../store/connectionSlice';
import { devActions } from '../store/devSlice';
import { transferActions } from '../store/transferSlice';
import { SignalingClient } from './signaling/SignalingClient';
import { PeerConnection } from './webrtc/PeerConnection';
import { generateWords, splitWords } from './words/words';
import { init as cpaceInit, finish as cpaceFinish, type CPaceState } from './crypto/cpace';
import {
  makeConfirmation,
  verifyConfirmation,
  CPACE_CONFIRM_DOMAIN,
  LINK_CONFIRM_DOMAIN,
  type ConfirmationRole,
  type ConfirmationDomain,
} from './crypto/keyConfirmation';
import { generateLinkSecret, buildLinkUrl } from './link/link';
import { generateNonce, sasCommit, verifySasCommit, computeSasWords, NONCE_BYTES } from './crypto/sas';
import {
  getOrCreateIdentity,
  generateStoredIdentity,
  restoreIdentity,
  type IdentityKey,
} from './crypto/identity';
import {
  signEnrollment,
  verifyEnrollment,
  enrollFrameSchema,
  PAIRING_ID_BYTES,
  type EnrollFrame,
} from './crypto/enrollment';
import {
  generateChallenge,
  signReconnect,
  verifyReconnect,
  presentedKeyMatchesPin,
  reconnectFrameSchema,
  type ReconnectFrame,
} from './crypto/reconnect';
import { defaultKeystore, type Keystore } from './keystore';
import {
  sendFiles as startSend,
  openReceive,
  parseControl,
  canStreamToDisk,
  receiveMaxBytes,
  formatBytes,
  type TransferWire,
  type ControlMessage,
  type SendEvent,
  type ReceiveEvent,
  type ActiveSend,
  type ActiveReceive,
} from './transfer/fileTransfer';

const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Resolve the signaling URL. A DEV-only `?signalingUrl=` query override lets an e2e tab target
 * an isolated signaling server (e.g. one with a short word-room TTL) without touching the
 * build-time default. The signaling server is untrusted by design (all confidentiality/auth is
 * client-side), so this widens no trust boundary; it is gated to DEV solely to keep it out of
 * production builds.
 */
function resolveSignalingUrl(): string {
  if (import.meta.env.DEV) {
    try {
      const override = new URLSearchParams(window.location.search).get('signalingUrl');
      if (override) return override;
    } catch {
      /* no window — fall through */
    }
  }
  return import.meta.env.VITE_SIGNALING_URL || DEFAULT_SIGNALING_URL;
}

/** Session-id length for CPace (bytes). Public; the initiator picks it fresh per session. */
const CPACE_SID_BYTES = 16;

/**
 * Online-guessing cap for the words method: A invalidates its rendezvous after this many FAILED
 * pairing attempts, bounding an attacker to ≤N guesses of the 4 secret words (vs 2^41). Default
 * 10 (the threat-model ceiling). Overridable in dev/tests via `?maxAttempts=N` or
 * `window.__HUSHSEND_MAX_ATTEMPTS__` so the cap can be exercised without 10 real handshakes.
 */
const DEFAULT_MAX_PAIRING_ATTEMPTS = 10;
function maxPairingAttempts(): number {
  try {
    const w = window as unknown as { __HUSHSEND_MAX_ATTEMPTS__?: unknown };
    if (typeof w.__HUSHSEND_MAX_ATTEMPTS__ === 'number' && w.__HUSHSEND_MAX_ATTEMPTS__ > 0) {
      return w.__HUSHSEND_MAX_ATTEMPTS__;
    }
    const q = new URLSearchParams(window.location.search).get('maxAttempts');
    const n = q ? Number(q) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* no window (non-browser) — use the default */
  }
  return DEFAULT_MAX_PAIRING_ATTEMPTS;
}

// The relay is UNTRUSTED, so the "words"-method payloads are validated before use, exactly
// like the SDP/ICE signal payloads. Even-length lowercase/uppercase hex.
const HEX = /^(?:[0-9a-fA-F]{2})*$/;
/** CPace message over signaling: `{ kind:'cpace', sid?, msg }`. `sid` is present only on the
 *  initiator's FIRST message (it chooses the public session id); the responder echoes none. */
const cpaceFrameSchema = z.object({
  kind: z.literal('cpace'),
  sid: z.string().regex(HEX).optional(),
  msg: z.string().regex(HEX),
});
/** Key-confirmation tag over the DataChannel: `{ kind:'confirm', tag }`. The `role` is NOT
 *  trusted from the wire — the verifier derives the expected peer role itself (reflection
 *  defense lives in keyConfirmation); it's carried only for human-readable debugging. */
const confirmMsgSchema = z.object({
  kind: z.literal('confirm'),
  role: z.enum(['initiator', 'responder']).optional(),
  tag: z.string().regex(HEX),
});
/**
 * SAS commit/reveal over signaling (room method). The relay is UNTRUSTED, so these are validated
 * before use exactly like cpace/SDP — and not merely as "some hex string": the EXACT decoded
 * length is pinned, so a short / truncated / oversized commit or nonce (a MITM trying to grind a
 * smaller space, or to slip a malformed value through) is REJECTED here, before it reaches the
 * crypto. `sas-commit` (B→A) carries SHA-256(domain||nonceB) = 32 bytes; `sas-nonce` carries a
 * revealed NONCE_BYTES (16-byte) nonce. Encoded hex ⇒ exactly 2× those byte counts of [0-9a-f].
 */
const SAS_COMMIT_HEX_LEN = 32 * 2; // SHA-256 digest, hex-encoded
const SAS_NONCE_HEX_LEN = NONCE_BYTES * 2; // 16-byte nonce, hex-encoded
export const sasSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sas-commit'), c: z.string().regex(HEX).length(SAS_COMMIT_HEX_LEN) }),
  z.object({ kind: z.literal('sas-nonce'), nonce: z.string().regex(HEX).length(SAS_NONCE_HEX_LEN) }),
]);
type SasSignal = z.infer<typeof sasSignalSchema>;
/** Mutual SAS confirmation over the DataChannel (room method). NOT a crypto boundary — the SAS
 *  already authenticated the channel — but it gates `connected`: both humans must confirm match. */
const sasConfirmSchema = z.object({ kind: z.literal('sas-confirm'), ok: z.boolean() });

/**
 * How long the SAS window may stay open before we give up. Two phases share this budget, both
 * ending on the SAME failSas → `failed` + close path as every other SAS failure:
 *   - the pre-SAS PAIRING window (peer-joined → SAS shown): a peer that joins but never completes
 *     the commit-reveal (e.g. commits, then withholds its nonce reveal) must not leave us hanging
 *     in `pairing` forever. The 4-digit room has NO server-side TTL yet (deferred), unlike the
 *     words room — so this client-side deadline is the only backstop. Uses the fixed default.
 *   - the human COMPARISON window (awaitingSas → confirming): a stalled comparison (peer walked
 *     away, one side never confirms) must not hang either. Generous (humans read 3 words aloud).
 *
 * The comparison phase reads the value through sasConfirmTimeoutMs() so DEV/tests can shrink it
 * (exercising the timeout branch in ~hundreds of ms instead of a real 120 s wait); the pairing
 * backstop keeps the fixed default so that shrink can't pre-empt the awaitingSas state under test.
 */
const DEFAULT_SAS_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Resolve the SAS comparison timeout. A DEV-only `?sasTimeoutMs=N` query override (or a
 * `window.__HUSHSEND_SAS_TIMEOUT_MS__` global) lets an e2e tab drive the comparison-timeout branch
 * with a tiny value instead of a real 120 s wait. Mirrors resolveSignalingUrl's DEV gate: the SAS
 * already authenticated the channel (this window is only a coordination gate, not a crypto
 * boundary), but keeping the override DEV-only means production always uses the 120 s default and
 * the override is dead-code-eliminated from prod builds.
 */
function sasConfirmTimeoutMs(): number {
  if (import.meta.env.DEV) {
    try {
      const w = window as unknown as { __HUSHSEND_SAS_TIMEOUT_MS__?: unknown };
      if (typeof w.__HUSHSEND_SAS_TIMEOUT_MS__ === 'number' && w.__HUSHSEND_SAS_TIMEOUT_MS__ > 0) {
        return w.__HUSHSEND_SAS_TIMEOUT_MS__;
      }
      const q = new URLSearchParams(window.location.search).get('sasTimeoutMs');
      const n = q ? Number(q) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* no window (non-browser) — fall through to the default */
    }
  }
  return DEFAULT_SAS_CONFIRM_TIMEOUT_MS;
}

/**
 * DEV/TEST knob (step 4b-ii): force the reconnect path to PRESENT a freshly-generated identity key
 * under the real, stored pairingId — i.e. simulate "the peer under this pairingId is now using a
 * different key". Drives the key-changed hard-stop e2e without a second real device. Mirrors the
 * other DEV-only knobs (`?forgeReconnectKey=1` / `window.__HUSHSEND_FORGE_RECONNECT_KEY__`): gated
 * behind `import.meta.env.DEV` so it is dead-code-eliminated from production builds.
 */
function forgeReconnectKeyEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const w = window as unknown as { __HUSHSEND_FORGE_RECONNECT_KEY__?: unknown };
    if (w.__HUSHSEND_FORGE_RECONNECT_KEY__ === true) return true;
    return new URLSearchParams(window.location.search).get('forgeReconnectKey') === '1';
  } catch {
    return false; // no window (non-browser) — never forge
  }
}

/**
 * Per-session reconnect state for the TOFU re-auth path (step 4b-ii). Its presence
 * (`this.reconnect != null`) marks a session ATTEMPTING reconnect; it rides ON TOP of the room
 * rendezvous + SAS state (`this.sas`), which stays primed as the fallback used when a pin is
 * missing. Lives ONLY in the core. Until the attempt resolves (engaged | fell back), it HOLDS the
 * SAS words back from the human (see trySasReady) so a successful reconnect never flashes SAS UI.
 */
interface ReconnectState {
  /** initiator (A, creator) or responder (B, joiner) — fixes the challenge order in the transcript. */
  role: ConfirmationRole;
  /** The pairingId we reconnect under: initiator picks it from its pins; responder learns it from
   *  the initiator's `reconnect-init` frame. Key-INDEPENDENT (so a swapped key is detectable). */
  pairingId: Uint8Array | null;
  /** our fresh anti-replay challenge (16 CSPRNG bytes). */
  myChallenge: Uint8Array;
  /** the peer's challenge: from `reconnect-init` (responder) / `reconnect-proof` (initiator). */
  peerChallenge: Uint8Array | null;
  /** DTLS fingerprints captured at channel-open (local SDP + RECEIVED SDP) — the channel binding. */
  fps: { local: string; remote: string } | null;
  /** initiator one-shot: `reconnect-init` sent. */
  initSent: boolean;
  /** one-shot: our own `reconnect-proof` sent. */
  proofSent: boolean;
  /** resolved to the SAS fallback (a pin was missing) — from here the normal SAS path takes over. */
  fellBack: boolean;
  /** one-shot guard for the connected | failed decision (mirrors SasState.settled). */
  settled: boolean;
}

/**
 * Per-session SAS state for the room method. Its presence (`this.sas != null`) is also the flag
 * that distinguishes the SAS-authenticated room path from the step-1 UNauthenticated room path
 * (both project `method: 'room'`) and from the words path (which uses `sessionKey`). Lives ONLY
 * in the core.
 */
interface SasState {
  /** initiator (A, creator) or responder (B, joiner) — fixes the nonce order in the transcript. */
  role: ConfirmationRole;
  /** our own nonce (revealed at the right moment per the commit-reveal ordering). */
  myNonce: Uint8Array;
  /** A-side: B's commitment, verified when B reveals (anti-grinding). */
  peerCommit: Uint8Array | null;
  /** the nonce the peer revealed. */
  peerNonce: Uint8Array | null;
  /** have we already sent our own nonce reveal? (one reveal per side) */
  revealedMine: boolean;
  /** DTLS fingerprints captured at channel-open (parsed from local + RECEIVED SDP). */
  fps: { local: string; remote: string } | null;
  /** the computed SAS triple, once both nonces AND the fingerprints are known. */
  words: string[] | null;
  /** one-shot: the SAS triple has been SURFACED to the human (→ awaitingSas). On the reconnect
   *  path the words may be computed but held back (not surfaced) until the attempt resolves to the
   *  SAS fallback; on the plain SAS path it surfaces as soon as the words are ready. */
  surfaced: boolean;
  /** did our human click "matches"? */
  localApproved: boolean;
  /** the peer's mutual-confirmation result (null = not yet received). */
  peerApproved: boolean | null;
  /** one-shot guard for the connected | failed decision. */
  settled: boolean;
  /** timeout armed when the SAS is shown (awaitingSas); cleared on settle/fail. Live handle —
   *  core-only, never in the store. `number` under the DOM lib (browser setTimeout). */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Canonical CPace password (PRS) from the 4 SECRET words. Both sides MUST derive it
 * byte-identically: lowercase each word, join with '\n', UTF-8 encode. A generated the
 * words from the list; B reproduces them by selecting from the same list — so the only
 * agreed-upon, order-sensitive serialization is fixed here. The PUBLIC rendezvous word is
 * excluded (it's routing, not secret).
 */
function prsFromSecretWords(secret: string[]): Uint8Array {
  return utf8ToBytes(secret.map((w) => w.toLowerCase()).join('\n'));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fresh SAS state for the room method, with our own nonce drawn from the CSPRNG. */
function newSasState(role: ConfirmationRole): SasState {
  return {
    role,
    myNonce: generateNonce(),
    peerCommit: null,
    peerNonce: null,
    revealedMine: false,
    fps: null,
    words: null,
    surfaced: false,
    localApproved: false,
    peerApproved: null,
    settled: false,
    timer: null,
  };
}

/** Fresh reconnect state, with our own anti-replay challenge drawn from the CSPRNG. The pairingId
 *  is supplied by the initiator (chosen from its pins) and learned by the responder from the wire. */
function newReconnectState(role: ConfirmationRole, pairingId: Uint8Array | null): ReconnectState {
  return {
    role,
    pairingId,
    myChallenge: generateChallenge(),
    peerChallenge: null,
    fps: null,
    initSent: false,
    proofSent: false,
    fellBack: false,
    settled: false,
  };
}

/**
 * The imperative core. Lives OUTSIDE React and the Redux store.
 *
 * It owns every non-serializable, live object — WebSocket, RTCPeerConnection,
 * RTCDataChannel, CryptoKey — and is the ONLY place they exist. React never
 * touches them. The controller talks to the UI exclusively by dispatching
 * serializable projections into the store; the UI talks to the controller by
 * calling these methods. One-way flow:
 *
 *   UI --(method call)--> SessionController --(work + dispatch)--> store --(useSelector)--> UI
 */
export class SessionController {
  private signaling: SignalingClient | null = null;
  private peer: PeerConnection | null = null;

  // --- identity + TOFU enrollment (step 4b-i) — long-term Ed25519 key + pinned peer keys. ---
  /** Persistent keystore (own identity + pinned peer keys). Survives sessions and reloads. */
  private readonly keystore: Keystore = defaultKeystore();
  /** Memoizes the load/generate of our long-term identity so concurrent callers never generate
   *  twice. Spans sessions (the identity outlives any one connection); cleared only by resetIdentity. */
  private identityPromise: Promise<IdentityKey> | null = null;
  /** Per-pair id (16 CSPRNG bytes): the initiator generates it; the responder learns it from the
   *  enroll-init frame. Key-INDEPENDENT so 4b-ii can catch a key swap under the same pairingId. */
  private pairingId: Uint8Array | null = null;
  /** Initiator one-shot: enroll-init sent. */
  private enrollInitiated = false;
  /** One-shot: we've pinned the peer's key for this connection (both roles pin exactly once). */
  private enrollPinned = false;

  private selfId: string | null = null;
  private peerId: string | null = null;
  private isCreator = false;
  /** Which rendezvous+auth method this session is running. Drives the welcome/peer-joined
   *  branch and whether onChannelOpen runs real CPace key-confirmation or the step-1 no-op. */
  private method: 'room' | 'words' | 'link' | 'qr' | null = null;

  // --- link / qr method (step 5b) — high-entropy URL-fragment secret, NO PAKE, NO SAS.
  //     Rendezvous is a 4-digit room (same as room method); the secret S authenticates the
  //     channel via the same key-confirmation as words, under the LINK domain. Lives ONLY in
  //     the core; the encoded form is surfaced to the creator's own screen as the link to share. ---
  /** The 16-byte one-time secret S (key-confirmation IKM). Non-null iff this is a link/qr session. */
  private linkSecret: Uint8Array | null = null;
  /** base64url(S) for building the shareable link (creator side only). Never sent to the server. */
  private linkSecretEncoded: string | null = null;
  /** One-shot guard for the link/qr connected | failed decision (mirrors confirmSettled's role for
   *  the failure-teardown re-entrancy from onChannelClose / onPeerLeft). */
  private linkSettled = false;

  // --- room method (step 4a) — 4-digit rendezvous + mandatory SAS. Lives ONLY in the core. ---
  /** Non-null iff this is the SAS-authenticated room path (vs the step-1 UNauthenticated room). */
  private sas: SasState | null = null;

  // --- reconnect (step 4b-ii) — TOFU re-auth under pinned keys, NO human step. Lives ONLY in the
  // core. Rides on top of the room rendezvous + `this.sas` (the fallback when a pin is missing). ---
  /** Non-null iff this session is ATTEMPTING reconnect (set by createReconnectSession/join). */
  private reconnect: ReconnectState | null = null;
  /** A forged identity (DEV/TEST knob only) presented in place of our real key to drive the
   *  key-changed hard-stop — see forgeReconnectKeyEnabled. Lazily generated, once per session. */
  private forgedIdentityPromise: Promise<IdentityKey> | null = null;

  // --- words method (step 3b) — CPace + key-confirmation. Lives ONLY in the core. ---
  /** initiator (A, the creator) or responder (B). Same role drives CPace and confirmation. */
  private role: ConfirmationRole | null = null;
  /** A-side only: the 4 secret words generated at create, held until `welcome` brings the
   *  rendezvous word so we can show the full 5-word credential. */
  private pendingSecretWords: string[] | null = null;
  /** CPace password = the 4 secret words (canonical bytes). Never serialized, never sent. */
  private prs: Uint8Array | null = null;
  /** Our half-open CPace state between sending our point and receiving the peer's. */
  private cpaceState: CPaceState | null = null;
  /** The CPace ISK (shared session key). The one secret we MAC the DTLS fingerprints under. */
  private sessionKey: Uint8Array | null = null;
  /** The two DTLS fingerprints captured at channel-open, for the confirmation MAC transcript. */
  private confirmFps: { local: string; remote: string } | null = null;
  /** The peer's confirmation tag, if it arrived before we computed ours (order-independent). */
  private peerConfirmTag: Uint8Array | null = null;
  /** Guards the one-shot confirming → connected | failed decision. */
  private confirmSettled = false;
  /** A-side: our PUBLIC rendezvous word (room id), kept across retries so the same words are
   *  re-shown while the attempt counter climbs. */
  private rendezvous: string | null = null;
  /** A-side: failed pairing attempts against `rendezvous` (online-guessing bound). */
  private attemptCount = 0;
  /** Per-attempt guard so a single failed attempt (mismatch OR abort OR disconnect OR bad frame)
   *  is counted at most once, no matter which signal observes it first. */
  private attemptResolved = false;
  /** true once we've reached `connected`; after that a signaling drop is harmless (P2P is live). */
  private established = false;
  private readonly signalingUrl: string;

  // --- file transfer (step 2) — one transfer at a time over the live DataChannel ---
  /** Active outbound transfer, awaiting accept or streaming bytes. */
  private sender: ActiveSend | null = null;
  /** Active inbound transfer, sinking chunks to disk/RAM. */
  private receiver: ActiveReceive | null = null;
  /** An inbound offer surfaced to the UI, awaiting the human's accept/reject. */
  private pendingOffer: { name: string; size: number; isZip: boolean; canStream: boolean; maxBytes: number } | null =
    null;

  constructor(private readonly dispatch: AppDispatch) {
    this.signalingUrl = resolveSignalingUrl();
    // Load (or generate) our long-term identity eagerly so the harness can show it at idle and
    // it's ready by the time a connection reaches `connected`. Non-fatal if the keystore is
    // unavailable (e.g. no IndexedDB) — enrollment just won't run.
    void this.publishIdentity();
  }

  // ===========================================================================
  // STEP 1 — TRANSPORT. The "room" method here is rendezvous ONLY: no crypto, no
  // SAS, no authentication. It exists to prove the WebRTC DataChannel comes up
  // through the signaling server. The real room method (4-digit code + MANDATORY
  // SAS) is step 3; the words/CPace path is step 2/3. See `connected` note below.
  // ===========================================================================

  /** A-side: allocate a room and wait for a peer to join (then we initiate). */
  async createRoom(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'room' }));
    this.isCreator = true;
    this.method = 'room';
    try {
      this.openSignaling();
      await this.signaling!.connect({ create: true });
      // `welcome` -> roomReady (shows the allocated code); `peer-joined` -> we initiate.
    } catch (err) {
      this.fail(err);
    }
  }

  /** B-side: join an existing room by its allocated code (we answer the offer). */
  async joinRoom(code: string): Promise<void> {
    this.dispatch(connectionActions.joinStarted({ method: 'room', room: code }));
    this.isCreator = false;
    this.method = 'room';
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: code });
      // `welcome` (peers non-empty) -> we're the responder and await the offer.
    } catch (err) {
      this.fail(err);
    }
  }

  /** Step-1 transport smoke test: send a ping over the DataChannel; the peer echoes it. */
  async sendPing(): Promise<void> {
    if (!this.peer) return;
    const text = `ping from ${this.selfId ?? '?'} @ ${new Date().toISOString()}`;
    this.dispatch(devActions.appendLog(`→ ${text}`));
    await this.peer.send(JSON.stringify({ kind: 'ping', text }));
  }

  // ---- signaling wiring ----

  private openSignaling(): void {
    this.signaling = new SignalingClient(this.signalingUrl, {
      onWelcome: (selfId, room, peers) => this.onWelcome(selfId, room, peers),
      onPeerJoined: (peerId) => this.onPeerJoined(peerId),
      onPeerLeft: (peerId) => this.onPeerLeft(peerId),
      onSignal: (from, data) => this.onSignal(from, data),
      onRoomClosed: (reason) => this.onRoomClosed(reason),
      onClose: (code, reason) => this.onSignalingClose(code, reason),
    });
  }

  private onWelcome(selfId: string, room: string, peers: string[]): void {
    this.selfId = selfId;
    this.dispatch(devActions.setSelfId(selfId));
    if (this.isCreator) {
      // A: rendezvous allocated. For words it IS the rendezvous word; show the full 5-word
      // credential (rendezvous + 4 secret) so A can read it aloud. For room, credential=null.
      this.rendezvous = room;
      this.dispatch(connectionActions.roomReady({ room, credential: this.fullCredential() }));
      // We engage when a peer joins (words: begin CPace; room: begin WebRTC) — see onPeerJoined.
    } else if (peers.length > 0) {
      // B: someone is already here -> we are the newcomer -> RESPONDER (await the offer).
      const other = peers[0];
      this.peerId = other;
      if (this.method === 'words') {
        this.role = 'responder';
        this.attemptResolved = false; // B's single shot
      } else if (this.method === 'link' || this.method === 'qr') {
        // link/qr: B is the responder. No PAKE, no SAS — the DataChannel comes up and the
        // key-confirmation runs over the URL-fragment secret S at channel-open.
        this.role = 'responder';
      } else if (this.sas) {
        // room + SAS: B is the responder. COMMIT to nonceB now — before A reveals nonceA — so B
        // is locked to its nonce and cannot grind it against A's. The reveal of nonceB waits
        // until A's nonce arrives (onSasSignal). Runs in parallel with the WebRTC bring-up below.
        this.sendSas({ kind: 'sas-commit', c: bytesToHex(sasCommit(this.sas.myNonce)) });
        // Bound the pre-SAS pairing window (symmetric with A — see onPeerJoined / armSasTimeout):
        // a 4-digit room has no server TTL yet, so without this a peer that joins then stalls the
        // commit-reveal would leave us hanging in `pairing` indefinitely.
        this.armSasTimeout('SAS pairing timed out', DEFAULT_SAS_CONFIRM_TIMEOUT_MS);
      }
      // Bring up the responder PeerConnection now; for words, CPace runs in parallel over
      // signaling and the ISK is ready before A's offer arrives.
      this.startPeer(other, /* initiator */ false);
      this.dispatch(connectionActions.pairingStarted({ peerId: other }));
    }
    // else (joined an existing-but-empty room): stay put; we'll initiate on peer-joined.
  }

  private onPeerJoined(peerId: string): void {
    if (this.peer || this.role === 'initiator') return; // 1:1 — already engaged with a peer
    // We were already in the room -> we are the INITIATOR toward the newcomer.
    this.peerId = peerId;
    this.dispatch(connectionActions.pairingStarted({ peerId }));
    if (this.method === 'words') {
      // Run CPace FIRST; only start WebRTC once we hold the ISK, so the DataChannel cannot
      // open before key-confirmation has a key to MAC the DTLS fingerprints under.
      this.role = 'initiator';
      this.attemptResolved = false; // a new guess attempt begins
      this.beginCpaceAsInitiator();
    } else if (this.method === 'link' || this.method === 'qr') {
      // link/qr: A is the initiator. No PAKE — bring up WebRTC straight away; the secret S is
      // already in hand, and key-confirmation over it runs once the DataChannel opens.
      this.role = 'initiator';
      this.startPeer(peerId, /* initiator */ true);
    } else {
      // room method: we initiate WebRTC. On the SAS path, also arm the pre-SAS pairing deadline
      // now — the 4-digit room has no server TTL yet, so without this a peer that joins but stalls
      // the commit-reveal would hang us in `pairing` forever (armSasTimeout no-ops off the SAS path).
      this.armSasTimeout('SAS pairing timed out', DEFAULT_SAS_CONFIRM_TIMEOUT_MS);
      this.startPeer(peerId, /* initiator */ true);
    }
  }

  private onPeerLeft(peerId: string): void {
    if (peerId !== this.peerId) return;
    if (import.meta.env.DEV) console.debug('[session] peer left', peerId);
    // words: a peer that drops BEFORE we're connected aborts this pairing attempt (counts on A;
    // a clean leave-and-fail on B). Once connected, the live DataChannel survives a signaling
    // drop, so we leave it alone (also the step-1 room behavior).
    if (this.method === 'words' && !this.established) {
      this.onWordsPairingFailure('peer left during pairing');
    }
    // link/qr: a peer dropping before connected aborts this single-use attempt (no bytes).
    if ((this.method === 'link' || this.method === 'qr') && !this.established) {
      this.failLink('peer left during pairing');
    }
    // reconnect (pre-fallback): a peer dropping mid-re-auth is a hard stop (no bytes). After
    // fallback it's the plain SAS path below; failReconnect closes out SAS so failSas can't re-fire.
    if (this.reconnect && !this.reconnect.fellBack && !this.established) {
      this.failReconnect('reconnect aborted — peer left during re-auth');
    }
    // room + SAS: a peer dropping before connected aborts the pairing (e.g. the other side
    // rejected the SAS and tore down). After connected the live channel survives — left alone.
    if (this.sas && !this.established) {
      this.failSas('peer left during SAS pairing');
    }
  }

  private startPeer(peerId: string, initiator: boolean): void {
    this.peer = new PeerConnection(
      {
        onSignal: (data) => this.signaling?.send(peerId, data),
        onOpen: () => void this.onChannelOpen(),
        onClose: () => this.onChannelClose(),
        onMessage: (data) => this.onPeerMessage(data),
      },
      { iceServers: DEFAULT_ICE_SERVERS },
    );
    this.peer.start(initiator);
  }

  private onSignal(from: string, data: unknown): void {
    if (from !== this.peerId) return; // 1:1 — ignore anyone we're not pairing with
    // The words method multiplexes CPace onto the signaling channel (kind:'cpace'); everything
    // else is WebRTC SDP/ICE for the PeerConnection. Validate (the relay is UNTRUSTED) and route.
    const cpace = cpaceFrameSchema.safeParse(data);
    if (cpace.success) {
      this.onCpaceMessage(cpace.data);
      return;
    }
    // room method: the SAS commit/reveal is multiplexed onto signaling too (kind:'sas-*').
    const sas = sasSignalSchema.safeParse(data);
    if (sas.success) {
      this.onSasSignal(sas.data);
      return;
    }
    void this.peer?.handleSignal(data);
  }

  /** Relay a CPace frame to the peer through the (untrusted) signaling server. */
  private sendCpace(frame: { kind: 'cpace'; sid?: string; msg: string }): void {
    if (this.peerId) this.signaling?.send(this.peerId, frame);
  }

  /** A (initiator): pick a fresh public sid, derive our CPace point, send it (with the sid). */
  private beginCpaceAsInitiator(): void {
    if (!this.prs) {
      this.fail(new Error('words session has no password'));
      return;
    }
    try {
      const sid = crypto.getRandomValues(new Uint8Array(CPACE_SID_BYTES));
      const { state, msg } = cpaceInit(this.prs, sid, { role: 'initiator' });
      this.cpaceState = state;
      this.sendCpace({ kind: 'cpace', sid: bytesToHex(sid), msg: bytesToHex(msg) });
    } catch (err) {
      this.onWordsPairingFailure(errText(err));
    }
  }

  /**
   * Handle a CPace frame. Responder (B) derives its point from A's public sid, computes the
   * ISK and replies; initiator (A) finishes to the ISK on B's reply and THEN starts WebRTC.
   *
   * A malformed / low-order peer point (active tampering) aborts here. A merely WRONG password
   * does NOT throw — both sides derive unrelated ISKs and the mismatch surfaces at
   * key-confirmation, never as file data.
   */
  private onCpaceMessage(frame: { kind: 'cpace'; sid?: string; msg: string }): void {
    if (this.method !== 'words' || !this.prs) return;
    if (this.sessionKey) return; // CPace already finished — ignore stray / replayed frames
    try {
      const peerMsg = hexToBytes(frame.msg);
      if (this.role === 'responder') {
        if (this.cpaceState) return; // already responded once
        if (!frame.sid) throw new Error('CPace: responder received no sid from the initiator');
        const sid = hexToBytes(frame.sid);
        const { state, msg } = cpaceInit(this.prs, sid, { role: 'responder' });
        this.cpaceState = state;
        this.sessionKey = cpaceFinish(state, peerMsg);
        this.sendCpace({ kind: 'cpace', msg: bytesToHex(msg) });
      } else {
        if (!this.cpaceState) return; // not initialised yet
        this.sessionKey = cpaceFinish(this.cpaceState, peerMsg);
        // ISK in hand → now bring up WebRTC as the initiator (offer/answer/ICE → DTLS).
        this.startPeer(this.peerId!, /* initiator */ true);
      }
    } catch (err) {
      // A malformed / low-order peer point (active tampering) or a broken cpace frame aborts the
      // attempt here. A wrong password does NOT throw — it surfaces at key-confirmation instead.
      this.onWordsPairingFailure(errText(err));
    }
  }

  private async onChannelOpen(): Promise<void> {
    // room + SAS: the channel coming up means the DTLS fingerprints are now known (local SDP +
    // RECEIVED SDP both set). Feed them into the SAS computation — these are the SAME fingerprints
    // DTLS validates against. Status stays `pairing` until the SAS words are ready (→ awaitingSas);
    // this is NOT yet `connected` (that waits for the mutual human confirmation).
    if (this.sas) {
      const local = this.peer?.localFingerprint() ?? null;
      const remote = this.peer?.remoteFingerprint() ?? null;
      console.info('[session] DTLS fingerprints — local:', local, '| remote:', remote);
      this.dispatch(devActions.setFingerprints({ local, remote }));
      // SAS commit-reveal runs in parallel; computing the SAS words is held back while a reconnect
      // attempt is pending (trySasReady), so a successful reconnect never flashes the SAS UI.
      this.onSasFingerprints(local, remote);
      // reconnect path: kick off the channel-bound re-auth over the now-open DataChannel.
      if (this.reconnect) this.onReconnectChannelOpen(local, remote);
      return;
    }

    // DataChannel is open: transport is up. Now key-confirmation (channel binding).
    this.dispatch(connectionActions.confirmStarted());
    const local = this.peer?.localFingerprint() ?? null;
    const remote = this.peer?.remoteFingerprint() ?? null;
    console.info('[session] DTLS fingerprints — local:', local, '| remote:', remote);
    this.dispatch(devActions.setFingerprints({ local, remote }));

    if (this.sessionKey) {
      // words method: MAC the negotiated DTLS fingerprints under the CPace ISK and exchange
      // tags. Match ⇒ authenticated `connected`; mismatch (wrong words / MITM) ⇒ failed, no
      // byte. These control messages are NOT file bytes, so the "connected-only" file
      // invariant is intact (sendFiles still gates on `established`, set only on a match).
      this.runKeyConfirmation(local, remote);
      return;
    }

    if (this.linkSecret) {
      // link/qr method: SAME channel-bound key-confirmation as words, but the IKM is the
      // high-entropy URL-fragment secret S (LINK domain), not a CPace ISK. Match ⇒ authenticated
      // `connected`; no S / wrong S / MITM with different certs ⇒ mismatch ⇒ failed, no byte.
      this.runKeyConfirmation(local, remote);
      return;
    }

    // ⚠️ step-1 "room" transport path: NO authentication. This `connected` is UNAUTHENTICATED
    // (anyone who reached the rendezvous is trusted). It exists only to prove the DataChannel
    // comes up; the real room method (4-digit + mandatory SAS) is a later step. The words
    // method above is the authenticated path. The no-file-bytes-before-connected invariant
    // holds regardless.
    this.established = true;
    this.dispatch(connectionActions.connectionEstablished());
  }

  /** The shared secret the key-confirmation MACs the DTLS fingerprints under: the CPace ISK for
   *  words, or the URL-fragment secret S for link/qr. Null off both confirmation paths. */
  private confirmSecret(): Uint8Array | null {
    return this.sessionKey ?? this.linkSecret;
  }

  /** Domain separation for the confirmation: link/qr use their own HKDF info + tag label so an
   *  S-derived tag can never be confused with an ISK-derived one; words use the CPace default. */
  private confirmDomain(): ConfirmationDomain {
    return this.linkSecret ? LINK_CONFIRM_DOMAIN : CPACE_CONFIRM_DOMAIN;
  }

  /**
   * Produce our confirmation tag over (secret, localFp, remoteFp, ourRole) under this method's
   * domain, send it to the peer, and verify the peer's tag. The two sides hold the same
   * fingerprint pair (labelled local/remote oppositely) — keyConfirmation canonicalises the order
   * — so a shared secret + an honest channel ⇒ both tags verify ⇒ authenticated `connected`. A
   * wrong/absent secret (wrong words / wrong S) yields divergent confirmation keys, and a MITM
   * with different certs yields divergent fingerprints ⇒ verification fails ⇒ `failed`, torn down.
   * Shared by the words (CPace ISK) and link/qr (URL-fragment S) paths.
   */
  private runKeyConfirmation(local: string | null, remote: string | null): void {
    const secret = this.confirmSecret();
    if (!secret || !this.role || !local || !remote) {
      this.onConfirmFailure('key-confirmation: missing session key or DTLS fingerprints');
      return;
    }
    this.confirmFps = { local, remote };
    const tag = makeConfirmation(secret, local, remote, this.role, this.confirmDomain());
    void this.peer
      ?.send(JSON.stringify({ kind: 'confirm', role: this.role, tag: bytesToHex(tag) }))
      .catch((err) => this.onConfirmFailure(`key-confirmation: failed to send tag (${errText(err)})`));
    this.tryVerifyConfirmation(); // the peer's tag may already be waiting (order-independent)
  }

  /** Verify the peer's tag once BOTH our fingerprints and the peer's tag are known. One-shot. */
  private tryVerifyConfirmation(): void {
    if (this.confirmSettled) return;
    const secret = this.confirmSecret();
    if (!secret || !this.role || !this.confirmFps || !this.peerConfirmTag) return;
    // Reflection defense: verify under the role we EXPECT the peer to hold (the opposite of
    // ours), never a role claimed on the wire — an echoed copy of our own tag fails here.
    const peerRole: ConfirmationRole = this.role === 'initiator' ? 'responder' : 'initiator';
    const ok = verifyConfirmation(
      secret,
      this.confirmFps.local,
      this.confirmFps.remote,
      peerRole,
      this.peerConfirmTag,
      this.confirmDomain(),
    );
    this.confirmSettled = true;
    if (ok) {
      this.attemptResolved = true; // success — no later signal should count as a failure (words)
      this.linkSettled = true; // success — link/qr teardown guards are now closed
      this.established = true;
      this.dispatch(connectionActions.connectionEstablished());
      this.startEnrollment(); // TOFU enrollment over the now-authenticated channel (does NOT gate)
    } else {
      this.onConfirmFailure(
        this.method === 'words'
          ? 'key-confirmation mismatch — wrong words or a man-in-the-middle'
          : 'key-confirmation mismatch — wrong or missing secret, or a man-in-the-middle',
      );
    }
  }

  /** Route a key-confirmation failure to the right per-method teardown: the words retry/attempt
   *  counter, or the single-use link/qr hard stop. */
  private onConfirmFailure(reason: string): void {
    if (this.method === 'words') {
      this.onWordsPairingFailure(reason);
      return;
    }
    this.failLink(reason);
  }

  /** Hard stop on the link/qr path (wrong/absent secret, MITM, channel drop, send failure): tear
   *  down the channel + signaling and fail. No file byte ever crossed (we are not yet `connected`),
   *  and the link is single-use so there is no retry. Guarded one-shot so a mismatch and the
   *  ensuing channel-close don't double-fire. No-op off the link/qr methods. */
  private failLink(reason: string): void {
    if ((this.method !== 'link' && this.method !== 'qr') || this.linkSettled) return;
    this.linkSettled = true;
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.fail(new Error(reason));
  }

  /**
   * A failed pairing attempt in the words method — confirmation mismatch, CPace/cpace-frame
   * abort, or the peer dropping mid-handshake. Counted at most ONCE per attempt (guarded), so
   * mismatch and the ensuing peer-left don't double-count.
   *
   * Creator (A): bounds online guessing of the 4 secret words. Each failure increments the
   * counter; BELOW the cap A tears down just this attempt and waits for the next joiner with the
   * SAME words (the attacker is guessing one fixed secret). At the cap A destroys the room
   * server-side (frees the word, evicts the joiner) and fails with reason 'attempts'.
   * Joiner (B): a single shot — leave the room (free A's slot) and fail.
   */
  private onWordsPairingFailure(reason: string): void {
    if (this.method !== 'words' || this.attemptResolved) return;
    this.attemptResolved = true;
    this.teardownPeerOnly(); // close the channel — NO file byte ever crossed (not yet connected)

    if (!this.isCreator) {
      this.signaling?.close(); // B leaves the room so A's 1:1 slot frees for the next attempt
      this.fail(new Error(reason));
      return;
    }

    this.attemptCount += 1;
    this.dispatch(devActions.setPairingAttempts({ attempts: this.attemptCount, max: maxPairingAttempts() }));
    if (this.attemptCount >= maxPairingAttempts()) {
      this.signaling?.destroyRoom(); // invalidate the rendezvous: free the word, evict the joiner
      this.fail(new Error('attempts'));
      return;
    }
    // Below the cap: wait for the next joiner — same rendezvous, same secret words.
    this.dispatch(connectionActions.roomReady({ room: this.rendezvous!, credential: this.fullCredential() }));
  }

  /** Close the current pairing's live objects and clear per-attempt crypto state, KEEPING the
   *  words credential + signaling so A (creator) can accept the next joiner on a retry. */
  private teardownPeerOnly(): void {
    this.peer?.close();
    this.peer = null;
    this.peerId = null;
    this.role = null;
    this.cpaceState = null;
    this.sessionKey = null;
    this.confirmFps = null;
    this.peerConfirmTag = null;
    this.confirmSettled = false;
  }

  /**
   * The credential to surface to the creator's OWN screen, or null if not yet known. For words it
   * is the full 5-word phrase (rendezvous + 4 secret) to read aloud; for link/qr it is a
   * single-element array holding the shareable link `<origin>/#<roomCode>.<S>` (the secret lives in
   * the fragment and is shown only to the creator — it never reaches the server). Consistent with
   * how the words method surfaces its secret words to the creator for display.
   */
  private fullCredential(): string[] | null {
    if (this.method === 'link' || this.method === 'qr') {
      if (!this.rendezvous || !this.linkSecretEncoded) return null;
      const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
      return [buildLinkUrl(origin, this.rendezvous, this.linkSecretEncoded)];
    }
    return this.rendezvous && this.pendingSecretWords ? [this.rendezvous, ...this.pendingSecretWords] : null;
  }

  /**
   * The server invalidated our word room (TTL expiry, or a destroy).
   *
   * The word-room TTL bounds only the PAIRING WINDOW (it caps the time an attacker has to guess
   * the secret words). Once we're `connected`, pairing is done and the live P2P DataChannel
   * outlives the signaling socket — so a TTL expiry here MUST NOT tear down the connection or an
   * in-flight transfer (the headline 10 GB transfer can easily run longer than the TTL). We just
   * note it (signaling is single-use from here on, which also lines up with future reconnect).
   *
   * BEFORE connected it's a real failure: stop with reason 'expired' (the harness offers fresh
   * words via regenerate — A makes a new room, B re-enters).
   */
  private onRoomClosed(_reason: string): void {
    if (this.method !== 'words') return;
    if (this.established) {
      // Pairing already succeeded — the TTL only freed the rendezvous word + closed signaling;
      // the authenticated P2P channel (and any transfer on it) keeps running untouched.
      this.dispatch(devActions.appendLog('signaling: word-room TTL expired — P2P connection persists'));
      return;
    }
    this.teardownPeerOnly();
    this.signaling?.close();
    this.fail(new Error('expired'));
  }

  /** Stash the peer's confirmation tag and try to settle (order-independent with our own). Used by
   *  both confirmation paths (words = CPace ISK, link/qr = URL-fragment S); the SAS/step-1 paths
   *  hold no confirmation secret, so tryVerifyConfirmation no-ops for them. */
  private onConfirmMessage(tagHex: string): void {
    if (this.confirmSettled || !this.confirmSecret()) return;
    try {
      this.peerConfirmTag = hexToBytes(tagHex);
    } catch {
      return; // not valid hex — drop
    }
    this.tryVerifyConfirmation();
  }

  private onChannelClose(): void {
    if (import.meta.env.DEV) console.debug('[session] data channel closed');
    // words method: the channel closing BEFORE we're connected means this pairing attempt
    // failed — typically the peer detected the key-confirmation mismatch and tore the channel
    // down before its tag reached us. Without this, a peer could hang in `confirming` forever
    // waiting for a tag that was never delivered. (Guarded, so it never double-counts.)
    if (this.method === 'words' && !this.established) {
      this.onWordsPairingFailure('channel closed during pairing');
    }
    // link/qr: the channel closing before connected means the peer hard-stopped its
    // key-confirmation (e.g. it detected the tag mismatch and tore down) — fail in step, no bytes.
    if ((this.method === 'link' || this.method === 'qr') && !this.established) {
      this.failLink('channel closed during pairing');
    }
    // reconnect (pre-fallback): the channel closing before connected means the peer hard-stopped
    // its re-auth (e.g. it detected OUR key changed and tore down) — fail in step, no bytes.
    if (this.reconnect && !this.reconnect.fellBack && !this.established) {
      this.failReconnect('reconnect aborted — channel closed during re-auth');
    }
    // room + SAS: the channel closing before connected means the peer rejected the SAS (or the
    // transport failed) — abort so we never hang in awaitingSas/confirming. (Guarded, one-shot.)
    if (this.sas && !this.established) {
      this.failSas('channel closed during SAS pairing');
    }
  }

  private onPeerMessage(data: string | ArrayBuffer): void {
    // Binary frame = a file chunk → straight to the active receiver's sink.
    if (typeof data !== 'string') {
      this.receiver?.handleChunk(data);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // words method: the peer's key-confirmation tag (a control message, NOT file bytes).
    const confirm = confirmMsgSchema.safeParse(msg);
    if (confirm.success) {
      this.onConfirmMessage(confirm.data.tag);
      return;
    }

    // room method: the peer's mutual SAS confirmation (a control message, NOT file bytes).
    const sasConfirm = sasConfirmSchema.safeParse(msg);
    if (sasConfirm.success) {
      this.onSasConfirm(sasConfirm.data.ok);
      return;
    }

    // reconnect (step 4b-ii): the peer's reconnect-init / proof / fallback (a control message, NOT
    // file bytes). Validated to exact lengths before any crypto. Runs over the channel-bound (but
    // not-yet-authenticated) DataChannel; the two checks inside decide connected | hard stop.
    const reconnect = reconnectFrameSchema.safeParse(msg);
    if (reconnect.success) {
      void this.onReconnectFrame(reconnect.data).catch((err) =>
        this.failReconnect(`reconnect: ${errText(err)}`),
      );
      return;
    }

    // TOFU enrollment (step 4b-i): the peer's identity key + signature (a control message, NOT
    // file bytes). Runs over the already-authenticated channel; validated to exact lengths.
    const enroll = enrollFrameSchema.safeParse(msg);
    if (enroll.success) {
      void this.onEnrollFrame(enroll.data).catch((err) =>
        this.dispatch(devActions.appendLog(`enroll: ${errText(err)}`)),
      );
      return;
    }

    // Transfer control frames carry a `t` discriminator (validated against the schema).
    const control = parseControl(msg);
    if (control) {
      this.onTransferControl(control);
      return;
    }

    // Otherwise it's the step-1 ping/echo harness (keyed by `kind`).
    const m = msg as { kind?: unknown; text?: unknown };
    if (m.kind === 'ping' && typeof m.text === 'string') {
      this.dispatch(devActions.appendLog(`← ping: ${m.text}`));
      void this.peer?.send(JSON.stringify({ kind: 'echo', text: m.text })); // echo back
    } else if (m.kind === 'echo' && typeof m.text === 'string') {
      this.dispatch(devActions.appendLog(`← echo: ${m.text}`));
    }
  }

  // ---- file transfer (step 2) ----

  /** A thin wire over the live PeerConnection — backpressure + chunk-size limit live there. */
  private wire(): TransferWire {
    const peer = this.peer!;
    return {
      send: (d) => peer.send(d),
      maxMessageSize: peer.maxMessageSize(),
    };
  }

  /**
   * Public entry: send one or more files over the connected DataChannel. >1 file is
   * packed on the fly into a single store-mode zip. No bytes flow until the peer accepts.
   */
  sendFiles(files: File[]): void {
    if (files.length === 0) return;
    if (!this.peer || !this.established) {
      this.dispatch(transferActions.failed({ reason: 'not connected' }));
      return;
    }
    if (this.sender || this.receiver || this.pendingOffer) return; // one transfer at a time
    this.dispatch(transferActions.reset());
    this.sender = startSend(this.wire(), files, (e) => this.onSendEvent(e));
  }

  /** Accept the pending inbound offer. MUST be called from a user gesture (FSA save picker). */
  async acceptIncoming(): Promise<void> {
    const offer = this.pendingOffer;
    if (!offer || this.receiver) return;
    try {
      const recv = await openReceive(this.wire(), offer, offer.canStream, offer.maxBytes, (e) =>
        this.onReceiveEvent(e),
      );
      this.receiver = recv;
      this.pendingOffer = null;
      await recv.start(); // sends `accept` — receiver ref is already stored, so chunks route
      this.dispatch(transferActions.accepted());
    } catch (err) {
      // Most commonly the user dismissed the save picker (AbortError) → treat as a decline.
      if (import.meta.env.DEV) console.debug('[session] receive setup aborted:', err);
      this.pendingOffer = null;
      this.receiver = null;
      void this.peer?.send(JSON.stringify({ t: 'reject', reason: 'recipient cancelled' }));
      this.dispatch(transferActions.cancelled());
    }
  }

  /** Reject the pending inbound offer. */
  rejectIncoming(reason = 'declined by recipient'): void {
    if (!this.pendingOffer) return;
    this.pendingOffer = null;
    void this.peer?.send(JSON.stringify({ t: 'reject', reason }));
    this.dispatch(transferActions.rejected({ reason }));
  }

  /** Cancel an in-flight transfer (either direction). */
  cancelTransfer(): void {
    this.sender?.cancel();
    this.receiver?.cancel();
  }

  private onTransferControl(msg: ControlMessage): void {
    switch (msg.t) {
      case 'offer-file':
        this.handleIncomingOffer({ name: msg.name, size: msg.size, isZip: msg.isZip });
        break;
      case 'accept':
      case 'reject':
        this.sender?.handleControl(msg);
        break;
      case 'eof':
        this.receiver?.handleControl(msg);
        break;
      case 'cancel':
        this.sender?.handleControl(msg);
        this.receiver?.handleControl(msg);
        break;
    }
  }

  private handleIncomingOffer(offer: { name: string; size: number; isZip: boolean }): void {
    if (this.sender || this.receiver || this.pendingOffer) return; // busy — ignore
    const canStream = canStreamToDisk();
    const maxBytes = receiveMaxBytes(canStream);
    // Surface the offer for display either way; auto-reject oversize on the RAM-bound path.
    this.dispatch(transferActions.offered({ direction: 'receive', fileName: offer.name, totalBytes: offer.size }));
    if (offer.size > maxBytes) {
      const reason = `This file is ${formatBytes(offer.size)} — larger than the ${formatBytes(
        maxBytes,
      )} this browser can save. Open hushsend in Chrome on desktop to receive it.`;
      void this.peer?.send(JSON.stringify({ t: 'reject', reason }));
      this.dispatch(transferActions.rejected({ reason }));
      return; // no bytes ever requested
    }
    this.pendingOffer = { ...offer, canStream, maxBytes };
  }

  private onSendEvent(e: SendEvent): void {
    switch (e.t) {
      case 'offered':
        this.dispatch(transferActions.offered({ direction: 'send', fileName: e.fileName, totalBytes: e.totalBytes }));
        break;
      case 'accepted':
        this.dispatch(transferActions.accepted());
        break;
      case 'progress':
        this.dispatch(transferActions.progress({ transferredBytes: e.transferredBytes }));
        break;
      case 'done':
        this.dispatch(transferActions.completed());
        this.sender = null;
        break;
      case 'rejected':
        this.dispatch(transferActions.rejected({ reason: e.reason }));
        this.sender = null;
        break;
      case 'cancelled':
        this.dispatch(transferActions.cancelled());
        this.sender = null;
        break;
      case 'error':
        this.dispatch(transferActions.failed({ reason: e.reason }));
        this.sender = null;
        break;
    }
  }

  private onReceiveEvent(e: ReceiveEvent): void {
    switch (e.t) {
      case 'progress':
        this.dispatch(transferActions.progress({ transferredBytes: e.transferredBytes }));
        break;
      case 'done':
        this.dispatch(transferActions.completed());
        this.receiver = null;
        break;
      case 'cancelled':
        this.dispatch(transferActions.cancelled());
        this.receiver = null;
        break;
      case 'error':
        this.dispatch(transferActions.failed({ reason: e.reason }));
        this.receiver = null;
        break;
    }
  }

  private onSignalingClose(code: number, reason: string): void {
    // A live P2P DataChannel outlives the signaling socket, so a server-side close
    // AFTER we're connected is harmless. Before that, it's a setup failure
    // (e.g. 4009 "room not found", 4002 "room full").
    if (this.established) return;
    this.fail(new Error(`signaling closed (code ${code}${reason ? `: ${reason}` : ''})`));
  }

  private fail(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    if (import.meta.env.DEV) console.error('[session] failed:', reason);
    this.dispatch(connectionActions.failed({ reason }));
  }

  // ===========================================================================
  // STEP 3b — words method (CPace + key-confirmation). The 4 connection methods
  // resolve to this same FSM and the same DataChannel transfer; words differs only
  // in how the two sides rendezvous (a public word) and authenticate (CPace + a
  // MAC over the DTLS fingerprints — no SAS).
  // ===========================================================================

  /**
   * A-side: start a "words" session. Generate the 5-word credential locally (the 4 SECRET
   * words become the CPace password and NEVER reach the server), then ask the server to
   * allocate the PUBLIC rendezvous word. On `welcome` we display all 5 (onWelcome); on
   * `peer-joined` we begin CPace as the initiator (onPeerJoined).
   */
  async createWordsSession(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'words' }));
    this.isCreator = true;
    this.method = 'words';
    this.attemptCount = 0;
    this.dispatch(devActions.setPairingAttempts({ attempts: 0, max: maxPairingAttempts() }));
    try {
      // generateWords() returns a full 5-word credential (1 rendezvous + 4 secret). In this
      // method the PUBLIC rendezvous is the server-allocated word, so we keep only the 4
      // SECRET words (the CPace password); the generated rendezvous slot is discarded.
      const secret = splitWords(generateWords()).secret;
      this.prs = prsFromSecretWords(secret);
      this.openSignaling();
      await this.signaling!.connect({ create: true, codeType: 'word' });
      // `welcome` carries the allocated rendezvous word; we then show [rendezvous, ...secret].
      // It is stitched in onWelcome once we know the rendezvous, via this pending secret:
      this.pendingSecretWords = secret;
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * B-side: join a "words" session from the 5 words selected in the picker. Word 1 is the
   * PUBLIC rendezvous (routes the join); words 2–5 are the CPace password. On `welcome`
   * (A already present) we become the responder and run CPace when A's first frame arrives.
   */
  async joinWordsSession(words: string[]): Promise<void> {
    const { rendezvous, secret } = splitWords(words);
    this.dispatch(connectionActions.joinStarted({ method: 'words', room: rendezvous }));
    this.isCreator = false;
    this.method = 'words';
    this.prs = prsFromSecretWords(secret);
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: rendezvous, codeType: 'word' });
      // `welcome` (peers non-empty) → we're the responder; CPace + confirmation follow.
    } catch (err) {
      this.fail(err);
    }
  }

  // ===========================================================================
  // STEP 5b — link / qr method (high-entropy URL-fragment secret, NO PAKE, NO SAS).
  // The secret S (≥16 CSPRNG bytes) is not offline-guessable, so it authenticates the
  // channel on its own — there is no human comparison and no reader/picker. Rendezvous
  // is a 4-digit room (the SAME server allocate as the room method; the server is
  // untrusted and unchanged). The link `<origin>/#<roomCode>.<S>` carries BOTH the public
  // room code and the secret in the fragment; the joiner reads the fragment, SCRUBS it,
  // and sends only the room code to the server. qr is identical — the link is just
  // rendered/scanned as a QR. Flow: rendezvous → SDP/ICE → DTLS → key-confirmation over S
  // → connected (mapped onto creating/joining → pairing → confirming → connected|failed;
  // no new FSM states). TOFU enrollment runs after `connected` exactly as for words/room.
  // ===========================================================================

  /**
   * A-side: start a link or qr session. Generate the one-time secret S locally (it becomes the
   * key-confirmation IKM and NEVER reaches the server), then ask the server to allocate a 4-digit
   * rendezvous room. On `welcome` we surface the shareable link (rendezvous + S in the fragment);
   * on `peer-joined` we initiate WebRTC and run key-confirmation over S at channel-open. `method`
   * only tags the projection (link vs qr) — the auth/transport are identical.
   */
  async createLinkSession(method: 'link' | 'qr'): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method }));
    this.isCreator = true;
    this.method = method;
    const secret = generateLinkSecret();
    this.linkSecret = secret.bytes;
    this.linkSecretEncoded = secret.encoded;
    try {
      this.openSignaling();
      await this.signaling!.connect({ create: true }); // 4-digit allocate — unchanged server path
      // `welcome` carries the allocated room; onWelcome then shows the full link via fullCredential().
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * B-side: join a link or qr session. The roomCode + secret S come from the link fragment
   * (link: read from `location.hash` on page load; qr: decoded from a scanned/pasted link) — the
   * caller has ALREADY scrubbed the fragment from the address bar/history. Only the roomCode goes
   * to the server (`join`); S stays local. On `welcome` (A already present) we become the
   * responder and run key-confirmation over S when the DataChannel opens.
   */
  async joinLinkSession(roomCode: string, secret: Uint8Array, method: 'link' | 'qr'): Promise<void> {
    this.dispatch(connectionActions.joinStarted({ method, room: roomCode }));
    this.isCreator = false;
    this.method = method;
    this.linkSecret = secret;
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: roomCode }); // 4-digit join — S never sent
      // `welcome` (peers non-empty) → we're the responder; key-confirmation over S follows.
    } catch (err) {
      this.fail(err);
    }
  }

  // ===========================================================================
  // STEP 4a — room method (4-digit rendezvous + MANDATORY SAS). The 4-digit code
  // is PUBLIC routing only (the untrusted server sees it); the entire MITM defence
  // is the two humans comparing a SAS out-of-band. A is creator+initiator (reveals
  // its nonce after B commits); B is joiner+responder (commits first). Shares the
  // same FSM and the same DataChannel transfer as every other method.
  // ===========================================================================

  /**
   * A-side: start a SAS-authenticated room. Allocate a 4-digit code, show it, wait. On
   * `peer-joined` we initiate WebRTC; the SAS commit-reveal runs in parallel over signaling.
   * (The step-1 `createRoom()` above is the UNauthenticated transport-only path — left intact.)
   */
  async createRoomSession(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'room' }));
    this.isCreator = true;
    this.method = 'room';
    this.sas = newSasState('initiator');
    try {
      this.openSignaling();
      await this.signaling!.connect({ create: true }); // 4-digit allocate — unchanged server path
      // `welcome` -> roomReady (shows the code); `peer-joined` -> WebRTC + we await B's commit.
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * B-side: join a SAS-authenticated room by its 4-digit code. On `welcome` (A already present)
   * we are the responder: COMMIT to our nonce immediately (onWelcome), bring up the answerer
   * PeerConnection, and reveal our nonce only after A reveals theirs.
   */
  async joinRoomSession(code: string): Promise<void> {
    this.dispatch(connectionActions.joinStarted({ method: 'room', room: code }));
    this.isCreator = false;
    this.method = 'room';
    this.sas = newSasState('responder');
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: code });
    } catch (err) {
      this.fail(err);
    }
  }

  // ===========================================================================
  // STEP 4b-ii — reconnect (TOFU re-auth under pinned keys). When two peers have
  // ALREADY enrolled (each pinned the other's Ed25519 key under a shared pairingId),
  // they can reconnect with NO human step: a mutual signature under the pinned keys,
  // channel-bound to THIS session's DTLS fingerprints + fresh challenges (replay),
  // replaces SAS/words. It REUSES the 4-digit room rendezvous and rides on top of the
  // SAS state (`this.sas`) which stays primed as the fallback used when a pin is
  // missing on either side. Path selection: initiator announces the pairingId; both
  // look up their pin; both-have-pin → reconnect-auth; else → fall back to SAS +
  // enrollment. A presented key ≠ the pinned key is a KEY-CHANGED hard stop (no bytes).
  // ===========================================================================

  /**
   * A-side: start a reconnect. Allocate a 4-digit room (same rendezvous as the SAS path) and pick
   * the pairingId to reconnect under from our pins (most recently pinned). If we hold NO pin there
   * is nothing to reconnect — we degrade to a plain SAS room (the `this.reconnect == null` path),
   * exactly the normal first-connect. On `peer-joined` we initiate WebRTC; on channel-open we send
   * `reconnect-init` announcing the pairingId + our challenge.
   */
  async createReconnectSession(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'room' }));
    this.isCreator = true;
    this.method = 'room';
    this.sas = newSasState('initiator'); // primed as the fallback (no human cost unless surfaced)
    try {
      const pins = await this.keystore.listPins();
      if (pins.length > 0) {
        // Reconnect under the most-recently-pinned peer (the harness pins exactly one).
        const pin = pins.reduce((a, b) => (b.firstSeen > a.firstSeen ? b : a));
        this.reconnect = newReconnectState('initiator', hexToBytes(pin.pairingId));
        this.dispatch(devActions.setReconnect({ active: true, outcome: null }));
      } else {
        this.dispatch(devActions.appendLog('reconnect: no stored pin — falling back to a plain SAS room'));
      }
      this.openSignaling();
      await this.signaling!.connect({ create: true }); // 4-digit allocate — unchanged server path
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * B-side: join a reconnect by its 4-digit code. We arm the SAS fallback (responder) AND the
   * reconnect overlay; the pairingId is learned from the initiator's `reconnect-init`. If we hold a
   * pin for it → we prove (reconnect-auth); if not → we tell A to fall back and the normal SAS
   * comparison takes over.
   */
  async joinReconnectSession(code: string): Promise<void> {
    this.dispatch(connectionActions.joinStarted({ method: 'room', room: code }));
    this.isCreator = false;
    this.method = 'room';
    this.sas = newSasState('responder');
    this.reconnect = newReconnectState('responder', null);
    this.dispatch(devActions.setReconnect({ active: true, outcome: null }));
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: code });
    } catch (err) {
      this.fail(err);
    }
  }

  /** Relay a SAS commit/nonce frame to the peer through the (untrusted) signaling server. */
  private sendSas(frame: SasSignal): void {
    if (this.peerId) this.signaling?.send(this.peerId, frame);
  }

  /**
   * Drive the commit-reveal. Ordering is the whole point (anti-grinding):
   *   B → A: sas-commit  (B locks nonceB)
   *   A → B: sas-nonce   (A reveals nonceA, still blind to nonceB)
   *   B → A: sas-nonce   (B reveals nonceB only now that nonceA is out)
   *   A verifies the reveal against B's commit.
   * The initiator (A) ever receives only a commit (then B's reveal); the responder (B) ever
   * receives only A's reveal. Each side's role disambiguates an otherwise-identical sas-nonce.
   */
  private onSasSignal(frame: SasSignal): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;

    if (frame.kind === 'sas-commit') {
      // Only the initiator (A) consumes a commit, and only once. Store it, then reveal nonceA.
      if (sas.role !== 'initiator' || sas.peerCommit) return;
      try {
        sas.peerCommit = hexToBytes(frame.c);
      } catch {
        return; // not valid hex — drop (a malformed relay frame, not a real commit)
      }
      sas.revealedMine = true;
      this.sendSas({ kind: 'sas-nonce', nonce: bytesToHex(sas.myNonce) });
      return;
    }

    // sas-nonce — the peer's reveal.
    if (sas.peerNonce) return; // already have it
    let peerNonce: Uint8Array;
    try {
      peerNonce = hexToBytes(frame.nonce);
    } catch {
      return;
    }
    if (sas.role === 'initiator') {
      // A verifies B's reveal against the earlier commitment — a swapped nonce is rejected here.
      if (!sas.peerCommit || !verifySasCommit(sas.peerCommit, peerNonce)) {
        this.failSas('SAS commitment mismatch — possible tampering');
        return;
      }
      sas.peerNonce = peerNonce;
    } else {
      // B was LOCKED behind its commit; only now that A's nonce is out does B reveal nonceB.
      sas.peerNonce = peerNonce;
      if (!sas.revealedMine) {
        sas.revealedMine = true;
        this.sendSas({ kind: 'sas-nonce', nonce: bytesToHex(sas.myNonce) });
      }
    }
    this.trySasReady();
  }

  /** Capture the DTLS fingerprints at channel-open, then try to compute the SAS. */
  private onSasFingerprints(local: string | null, remote: string | null): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;
    if (!local || !remote) {
      this.failSas('SAS: missing DTLS fingerprints');
      return;
    }
    sas.fps = { local, remote };
    this.trySasReady();
  }

  /**
   * Arm (or re-arm) the single SAS deadline timer, all expiries routed through the SAME failSas
   * path as every other SAS failure. Used for both the pre-SAS pairing window and the human
   * comparison window — it clears any prior handle first, so trySasReady can hand the pairing
   * deadline off to the (shorter, DEV-overridable) comparison deadline without leaking a timer.
   * No-op once the SAS has settled. The live handle lives on `sas` (core-only, never in the store).
   */
  private armSasTimeout(reason: string, ms: number): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;
    if (sas.timer != null) clearTimeout(sas.timer);
    sas.timer = setTimeout(() => this.failSas(reason), ms);
  }

  /**
   * Once BOTH nonces are exchanged AND the fingerprints are known, derive the SAS triple, then
   * surface it for the human comparison (→ awaitingSas). Order-independent; the word computation is
   * one-shot. The nonces are bound in fixed role order (initiator, responder) so both sides agree;
   * the fingerprints are canonicalised inside computeSasWords.
   *
   * On the RECONNECT path the words are computed but HELD BACK (not surfaced) until the reconnect
   * attempt resolves to the SAS fallback (`reconnect.fellBack`). A successful reconnect therefore
   * never flashes the SAS UI; a fallback (a pin was missing) releases the held words via this same
   * path. On the plain SAS path (`this.reconnect == null`) the words surface as soon as ready.
   */
  private trySasReady(): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;
    if (!sas.peerNonce || !sas.fps) return;
    if (!sas.words) {
      const nonceInitiator = sas.role === 'initiator' ? sas.myNonce : sas.peerNonce;
      const nonceResponder = sas.role === 'initiator' ? sas.peerNonce : sas.myNonce;
      sas.words = computeSasWords(nonceInitiator, nonceResponder, sas.fps.local, sas.fps.remote);
    }
    if (this.reconnect && !this.reconnect.fellBack) return; // hold SAS until reconnect resolves
    this.surfaceSas();
  }

  /**
   * Reveal the computed SAS triple to the human (→ awaitingSas) and hand the pre-SAS pairing
   * deadline off to the human-comparison window. One-shot (guarded by `sas.surfaced`). Split out of
   * trySasReady so the reconnect fallback can release a pair of already-computed-but-held words.
   */
  private surfaceSas(): void {
    const sas = this.sas;
    if (!sas || sas.settled || sas.surfaced || !sas.words) return;
    sas.surfaced = true;
    this.dispatch(connectionActions.sasReady({ sas: sas.words.join(' ') }));
    // Hand the pre-SAS pairing deadline off to the human-comparison window (awaitingSas +
    // confirming): re-arm the SAME timer (armSasTimeout clears the pairing handle first) so a
    // stalled comparison — nobody settles — fails down the SAME failSas path. DEV-overridable for
    // cheap timeout tests; cleared on settle (trySasSettle) / fail (failSas).
    this.armSasTimeout('SAS confirmation timed out', sasConfirmTimeoutMs());
  }

  /**
   * The human clicked "matches" / "doesn't match". A reject (either side) is a HARD STOP: send
   * the verdict and fail. An approve records our half, advances to `confirming`, and tries to
   * settle — `connected` only once BOTH sides approved (the mutual confirmation gates the FSM;
   * the SAS itself is what authenticated the channel).
   */
  confirmSas(ok: boolean): void {
    const sas = this.sas;
    if (!sas || sas.settled || !sas.words || sas.localApproved) return;
    if (!ok) {
      void this.peer?.send(JSON.stringify({ kind: 'sas-confirm', ok: false }));
      this.failSas('SAS rejected — words did not match');
      return;
    }
    sas.localApproved = true;
    void this.peer
      ?.send(JSON.stringify({ kind: 'sas-confirm', ok: true }))
      .catch((err) => this.failSas(`SAS: failed to send confirmation (${errText(err)})`));
    this.dispatch(connectionActions.confirmStarted()); // awaitingSas → confirming
    this.trySasSettle();
  }

  /** The peer's mutual-confirmation verdict over the DataChannel. A reject is a hard stop. */
  private onSasConfirm(ok: boolean): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;
    if (!ok) {
      this.failSas('peer reported a SAS mismatch');
      return;
    }
    sas.peerApproved = true;
    this.trySasSettle();
  }

  /** `connected` iff BOTH humans confirmed the SAS matched. One-shot. */
  private trySasSettle(): void {
    const sas = this.sas;
    if (!sas || sas.settled) return;
    if (!sas.localApproved || sas.peerApproved !== true) return;
    sas.settled = true;
    if (sas.timer != null) clearTimeout(sas.timer); // comparison window closed — disarm
    sas.timer = null;
    this.established = true; // gates file bytes — set only on a mutual match
    this.dispatch(connectionActions.connectionEstablished());
    this.startEnrollment(); // TOFU enrollment over the now-authenticated channel (does NOT gate)
  }

  /** Abort the SAS pairing: disarm the timeout, tear down the channel + signaling and fail. No
   *  file byte ever crossed (we are not yet `connected`). Guarded one-shot so a reject, a
   *  channel-close, AND the timeout firing don't double-fire. */
  private failSas(reason: string): void {
    if (!this.sas || this.sas.settled) return;
    this.sas.settled = true;
    if (this.sas.timer != null) clearTimeout(this.sas.timer);
    this.sas.timer = null;
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.fail(new Error(reason));
  }

  // ---- reconnect re-auth (step 4b-ii) ----

  /** Relay a reconnect control frame to the peer over the DTLS-protected DataChannel. */
  private sendReconnect(frame: ReconnectFrame): void {
    void this.peer
      ?.send(JSON.stringify(frame))
      .catch((err) => this.failReconnect(`reconnect: send failed (${errText(err)})`));
  }

  /**
   * The identity we PRESENT in our reconnect proof. Normally our real long-term identity. Under the
   * DEV/TEST forge knob it is a fresh, throwaway Ed25519 key — simulating "the peer under this
   * pairingId is now using a different key" so the OTHER side's check (1) fires the key-changed hard
   * stop. Memoized per session so the (single) proof we send is internally consistent.
   */
  private reconnectIdentity(): Promise<IdentityKey> {
    if (forgeReconnectKeyEnabled()) {
      if (!this.forgedIdentityPromise) {
        this.forgedIdentityPromise = generateStoredIdentity().then(restoreIdentity);
      }
      return this.forgedIdentityPromise;
    }
    return this.ensureIdentity();
  }

  /**
   * Channel is open on the reconnect path: capture the DTLS fingerprints (the channel binding) and,
   * as the initiator, announce the pairingId we want to reconnect under + our fresh challenge. The
   * responder waits for that `reconnect-init` (it learns the pairingId from it). The pre-SAS pairing
   * timer armed at welcome/peer-joined doubles as the backstop bounding this re-auth window.
   */
  private onReconnectChannelOpen(local: string | null, remote: string | null): void {
    const rc = this.reconnect;
    if (!rc || rc.settled || rc.fellBack) return;
    if (!local || !remote) {
      this.failReconnect('reconnect: missing DTLS fingerprints');
      return;
    }
    rc.fps = { local, remote };
    if (rc.role === 'initiator' && !rc.initSent && rc.pairingId) {
      rc.initSent = true;
      this.sendReconnect({
        kind: 'reconnect-init',
        pairingId: bytesToHex(rc.pairingId),
        challenge: bytesToHex(rc.myChallenge),
      });
    }
  }

  /** Route an inbound reconnect frame (already zod-validated to exact lengths). */
  private async onReconnectFrame(frame: ReconnectFrame): Promise<void> {
    const rc = this.reconnect;
    if (!rc || rc.settled || rc.fellBack || !rc.fps) return; // only meaningful after channel-open
    switch (frame.kind) {
      case 'reconnect-init':
        return this.onReconnectInit(frame.pairingId, frame.challenge);
      case 'reconnect-proof':
        return this.onReconnectProof(frame.challenge, frame.pubKey, frame.sig);
      case 'reconnect-fallback':
        // The responder holds no pin for our pairingId → both fall back to the SAS comparison.
        if (rc.role === 'initiator') this.reconnectFallback(false);
        return;
    }
  }

  /**
   * Responder: the initiator announced the pairingId it wants to reconnect under. Learn it + the
   * initiator's challenge, then look up OUR pin. If we hold one → prove possession of our pinned
   * key (reconnect-auth engaged). If not → tell the initiator to fall back and let the normal SAS
   * comparison take over.
   */
  private async onReconnectInit(pairingIdHex: string, challengeHex: string): Promise<void> {
    const rc = this.reconnect;
    if (!rc || rc.role !== 'responder' || rc.peerChallenge || rc.fellBack || rc.settled || !rc.fps) return;
    rc.peerChallenge = hexToBytes(challengeHex);
    rc.pairingId = hexToBytes(pairingIdHex);
    const pin = await this.keystore.getPin(pairingIdHex);
    if (!pin) {
      this.reconnectFallback(true); // tell the initiator to fall back too
      return;
    }
    this.dispatch(connectionActions.confirmStarted()); // pairing → confirming
    await this.buildAndSendProof();
  }

  /**
   * A reconnect proof arrived. Run the TWO checks (key-change vs MITM) against OUR pin for the
   * pairingId. The initiator processes the responder's proof first (then sends its own and settles);
   * the responder processes the initiator's proof (after having sent its own) and settles.
   */
  private async onReconnectProof(challengeHex: string, pubKeyHex: string, sigHex: string): Promise<void> {
    const rc = this.reconnect;
    if (!rc || rc.fellBack || rc.settled || !rc.fps || !rc.pairingId) return;

    if (rc.role === 'initiator') {
      if (rc.peerChallenge) return; // already processed the responder's proof
      rc.peerChallenge = hexToBytes(challengeHex);
      this.dispatch(connectionActions.confirmStarted()); // pairing → confirming
      const verdict = await this.verifyPeerProof(pubKeyHex, sigHex, 'responder');
      if (verdict !== 'ok') return this.onReconnectVerdict(verdict);
      // Responder verified → present our own proof, then we are authenticated.
      await this.buildAndSendProof();
      this.settleReconnect();
    } else {
      if (!rc.proofSent || !rc.peerChallenge) return; // responder proves first, then verifies
      const verdict = await this.verifyPeerProof(pubKeyHex, sigHex, 'initiator');
      if (verdict !== 'ok') return this.onReconnectVerdict(verdict);
      this.settleReconnect();
    }
  }

  /** Build + send OUR channel-bound reconnect proof (signed under the presented identity). One-shot. */
  private async buildAndSendProof(): Promise<void> {
    const rc = this.reconnect;
    if (!rc || rc.settled || rc.fellBack || rc.proofSent) return;
    if (!rc.pairingId || !rc.peerChallenge || !rc.fps) return;
    const identity = await this.reconnectIdentity();
    // Challenges in FIXED role order (initiator's, then responder's) so both sides agree.
    const challengeInitiator = rc.role === 'initiator' ? rc.myChallenge : rc.peerChallenge;
    const challengeResponder = rc.role === 'initiator' ? rc.peerChallenge : rc.myChallenge;
    const sig = await signReconnect(
      identity,
      rc.pairingId,
      challengeInitiator,
      challengeResponder,
      rc.fps.local,
      rc.fps.remote,
      rc.role,
    );
    rc.proofSent = true;
    this.sendReconnect({
      kind: 'reconnect-proof',
      challenge: bytesToHex(rc.myChallenge),
      pubKey: bytesToHex(identity.publicKey),
      sig: bytesToHex(sig),
    });
  }

  /**
   * The two-check verdict on a peer's reconnect proof:
   *   (1) does the PRESENTED key equal the key we PINNED for this pairingId? No → 'key-changed'.
   *   (2) does the signature verify under the PINNED key, OUR fingerprints, the PEER's role? No,
   *       with a matching key → 'auth-fail' (channel-binding / MITM).
   * Both pass → 'ok'. Kept separate so the controller can render a key change distinctly from a
   * MITM (both are hard stops — no bytes — but a key change is the SSH-style "this is a different
   * peer" warning, not a transient failure).
   */
  private async verifyPeerProof(
    presentedPubKeyHex: string,
    sigHex: string,
    peerRole: ConfirmationRole,
  ): Promise<'ok' | 'key-changed' | 'auth-fail'> {
    const rc = this.reconnect;
    if (!rc || !rc.pairingId || !rc.peerChallenge || !rc.fps) return 'auth-fail';
    const pin = await this.keystore.getPin(bytesToHex(rc.pairingId));
    if (!pin) return 'auth-fail'; // the engaged path must hold a pin
    // Check (1): key-change detection.
    if (!presentedKeyMatchesPin(pin.peerPublicKey, presentedPubKeyHex)) return 'key-changed';
    // Check (2): channel-bound signature under the PINNED key.
    let sig: Uint8Array;
    try {
      sig = hexToBytes(sigHex);
    } catch {
      return 'auth-fail';
    }
    const challengeInitiator = rc.role === 'initiator' ? rc.myChallenge : rc.peerChallenge;
    const challengeResponder = rc.role === 'initiator' ? rc.peerChallenge : rc.myChallenge;
    const ok = await verifyReconnect(
      hexToBytes(pin.peerPublicKey),
      rc.pairingId,
      challengeInitiator,
      challengeResponder,
      rc.fps.local,
      rc.fps.remote,
      peerRole,
      sig,
    );
    return ok ? 'ok' : 'auth-fail';
  }

  /** Map a failing verdict to the right hard stop (both are terminal — no file byte crosses). */
  private onReconnectVerdict(verdict: 'key-changed' | 'auth-fail'): void {
    if (verdict === 'key-changed') {
      // SSH-style: the peer under this pairingId presented a DIFFERENT key. A deliberate, visible
      // hard stop — never a dismissable toast — and not a single byte flows.
      this.dispatch(devActions.setReconnect({ active: true, outcome: 'key-changed' }));
      this.dispatch(devActions.appendLog('reconnect: KEY CHANGED — presented key ≠ pinned key (hard stop)'));
      this.failReconnect('key changed — the peer under this pairingId presented a different identity key');
    } else {
      this.failReconnect('reconnect signature invalid — possible man-in-the-middle (channel binding failed)');
    }
  }

  /**
   * Reconnect authenticated: both proofs verified under the pinned keys, channel-bound. Settle to
   * `connected` with NO human step and NO re-enrollment (the pins already stand). Marks the parallel
   * SAS state settled so its (unused) commit-reveal can never also surface or fire a timeout.
   */
  private settleReconnect(): void {
    const rc = this.reconnect;
    if (!rc || rc.settled) return;
    rc.settled = true;
    if (this.sas) {
      this.sas.settled = true; // the fallback SAS never surfaced — close it out
      if (this.sas.timer != null) clearTimeout(this.sas.timer);
      this.sas.timer = null;
    }
    this.established = true; // gates file bytes — set only after both proofs verify
    this.dispatch(connectionActions.connectionEstablished());
    this.dispatch(devActions.setReconnect({ active: true, outcome: 'authenticated' }));
    this.dispatch(devActions.appendLog('reconnect: authenticated via pinned key — no SAS needed'));
  }

  /**
   * A pin was missing on at least one side → reconnect cannot run. Release the (already-primed) SAS
   * comparison: the session continues as a normal first connect (SAS + enrollment). `send=true` when
   * WE (the responder) detected the missing pin and must tell the initiator to fall back too.
   */
  private reconnectFallback(send: boolean): void {
    const rc = this.reconnect;
    if (!rc || rc.settled || rc.fellBack) return;
    rc.fellBack = true;
    if (send) this.sendReconnect({ kind: 'reconnect-fallback' });
    this.dispatch(devActions.setReconnect({ active: true, outcome: 'fell-back' }));
    this.dispatch(devActions.appendLog('reconnect: no shared pin — falling back to the SAS comparison'));
    this.trySasReady(); // release the held SAS words (fellBack is now true) → awaitingSas
  }

  /** Hard stop on the reconnect path (key change / MITM / channel drop / send failure): tear down
   *  the channel + signaling and fail. No file byte ever crossed (we are not yet `connected`).
   *  Guarded one-shot; also closes out the parallel SAS state so failSas can't double-fire. */
  private failReconnect(reason: string): void {
    if (!this.reconnect || this.reconnect.settled) return;
    this.reconnect.settled = true;
    if (this.sas) {
      this.sas.settled = true;
      if (this.sas.timer != null) clearTimeout(this.sas.timer);
      this.sas.timer = null;
    }
    this.peer?.close();
    this.peer = null;
    this.signaling?.close();
    this.fail(new Error(reason));
  }

  // ===========================================================================
  // STEP 4b-i — identity + TOFU enrollment. After (and only after) an AUTHENTICATED
  // `connected` (words: CPace + key-confirmation; room: SAS), the two sides exchange and
  // PIN their long-term Ed25519 identities over the DataChannel. The channel is already
  // MITM-free, so this key exchange is the trust-on-first-use moment. Enrollment is an
  // ACTION on entering `connected` (status stays `connected`); it does NOT gate the FSM and
  // does NOT block file transfer, and a bad signature only declines to pin — the session,
  // already human/PAKE-authenticated, is NEVER torn down by enrollment. Key-change detection
  // and reconnect-via-pin are step 4b-ii (NOT here): in 4b-i pairingId is always fresh, so a
  // new pin is always written.
  // ===========================================================================

  /** Load (or generate) our long-term identity once; memoized across sessions. */
  private ensureIdentity(): Promise<IdentityKey> {
    if (!this.identityPromise) this.identityPromise = getOrCreateIdentity(this.keystore);
    return this.identityPromise;
  }

  /** Surface our own public key (hex) into the store for the harness. Non-fatal on failure. */
  private async publishIdentity(): Promise<void> {
    try {
      const id = await this.ensureIdentity();
      this.dispatch(devActions.setOwnPublicKey(bytesToHex(id.publicKey)));
    } catch (err) {
      if (import.meta.env.DEV) console.debug('[session] identity unavailable:', errText(err));
    }
  }

  /** True on the AUTHENTICATED methods (words / link / qr key-confirmation, or SAS room) — i.e.
   *  everywhere TOFU enrollment may run. The step-1 UNauthenticated transport-only room is the
   *  sole `connected` that is not authenticated, so it never enrolls. */
  private isAuthenticatedMethod(): boolean {
    return this.method === 'words' || this.method === 'link' || this.method === 'qr' || this.sas != null;
  }

  /** Our role on the authenticated path (SAS, words, or link/qr); null off those paths. */
  private authRole(): ConfirmationRole | null {
    if (this.sas) return this.sas.role;
    return this.role;
  }

  /** The DTLS fingerprints captured for this authenticated channel (SAS or words). */
  private authFingerprints(): { local: string; remote: string } | null {
    if (this.sas?.fps) return this.sas.fps;
    return this.confirmFps;
  }

  /**
   * Kick off enrollment on entering an AUTHENTICATED `connected`. The initiator sends its
   * signed identity immediately (it owns the pairingId); the responder waits for that frame.
   * No-op off the authenticated paths (the step-1 unauthenticated room never enrolls).
   */
  private startEnrollment(): void {
    if (!this.isAuthenticatedMethod()) return; // authenticated paths only
    void this.runEnrollment().catch((err) => this.dispatch(devActions.appendLog(`enroll: ${errText(err)}`)));
  }

  private async runEnrollment(): Promise<void> {
    const role = this.authRole();
    const fps = this.authFingerprints();
    if (!role || !fps) return; // should hold on `connected`
    const identity = await this.ensureIdentity();
    if (role !== 'initiator' || this.enrollInitiated) return; // responder waits for enroll-init
    this.enrollInitiated = true;
    this.pairingId = crypto.getRandomValues(new Uint8Array(PAIRING_ID_BYTES));
    const sig = await signEnrollment(identity, this.pairingId, fps.local, fps.remote, 'initiator');
    void this.peer
      ?.send(
        JSON.stringify({
          kind: 'enroll-init',
          pairingId: bytesToHex(this.pairingId),
          pubKey: bytesToHex(identity.publicKey),
          sig: bytesToHex(sig),
        }),
      )
      .catch((err) => this.dispatch(devActions.appendLog(`enroll: send failed (${errText(err)})`)));
  }

  /**
   * Handle an inbound enrollment frame over the authenticated channel.
   *  - enroll-init (responder side): verify the initiator's sig against the SENT pubkey (TOFU —
   *    the channel is authenticated, so we trust the key), pin pairingId → initiatorPubKey, and
   *    reply with our own signed identity (role=responder, same pairingId).
   *  - enroll-ack  (initiator side): verify the responder's sig, pin pairingId → responderPubKey.
   * A signature failure does NOT tear the session down (it's already human/PAKE-authenticated):
   * we skip the pin and log a non-fatal warning. Pins exactly once per connection.
   */
  private async onEnrollFrame(frame: EnrollFrame): Promise<void> {
    if (!this.isAuthenticatedMethod()) return; // authenticated paths only
    if (this.enrollPinned) return; // one pin per connection
    const fps = this.authFingerprints();
    if (!fps) return;

    if (frame.kind === 'enroll-init') {
      const pairingId = hexToBytes(frame.pairingId);
      const peerPub = hexToBytes(frame.pubKey);
      const sig = hexToBytes(frame.sig);
      const ok = await verifyEnrollment(peerPub, pairingId, fps.local, fps.remote, 'initiator', sig);
      if (!ok) {
        this.dispatch(devActions.appendLog('enroll: initiator signature INVALID — not pinning'));
        return;
      }
      this.enrollPinned = true;
      this.pairingId = pairingId;
      await this.keystore.putPin(frame.pairingId, frame.pubKey);
      this.dispatch(devActions.setPinnedPeer({ pairingId: frame.pairingId, peerPublicKey: frame.pubKey }));
      // Reply with our own (responder) signed identity over the SAME pairingId.
      const identity = await this.ensureIdentity();
      const mySig = await signEnrollment(identity, pairingId, fps.local, fps.remote, 'responder');
      void this.peer
        ?.send(JSON.stringify({ kind: 'enroll-ack', pubKey: bytesToHex(identity.publicKey), sig: bytesToHex(mySig) }))
        .catch((err) => this.dispatch(devActions.appendLog(`enroll: ack send failed (${errText(err)})`)));
      return;
    }

    // enroll-ack — initiator side. We must already hold the pairingId we generated.
    if (!this.pairingId) return;
    const peerPub = hexToBytes(frame.pubKey);
    const sig = hexToBytes(frame.sig);
    const ok = await verifyEnrollment(peerPub, this.pairingId, fps.local, fps.remote, 'responder', sig);
    if (!ok) {
      this.dispatch(devActions.appendLog('enroll: responder signature INVALID — not pinning'));
      return;
    }
    this.enrollPinned = true;
    const pairingIdHex = bytesToHex(this.pairingId);
    await this.keystore.putPin(pairingIdHex, frame.pubKey);
    this.dispatch(devActions.setPinnedPeer({ pairingId: pairingIdHex, peerPublicKey: frame.pubKey }));
  }

  /**
   * Harness "Forget pins / reset identity": wipe the keystore (own identity + all pins) and
   * regenerate a fresh identity. The long-term identity normally SURVIVES sessions/reloads — this
   * is the explicit reset path, separate from per-session dispose().
   */
  async resetIdentity(): Promise<void> {
    await this.keystore.clearAll();
    this.identityPromise = null;
    this.pairingId = null;
    this.enrollInitiated = false;
    this.enrollPinned = false;
    this.dispatch(devActions.setPinnedPeer(null));
    await this.publishIdentity(); // generate + show a fresh identity
  }

  /**
   * Words method recovery: discard the current (failed / expired) session and start a fresh one
   * with NEW secret words and a NEW rendezvous. Surfaced as the harness "new words" button after
   * the attempt cap or a TTL expiry. dispose() resets the FSM + counter projection to zero first.
   */
  async regenerate(): Promise<void> {
    this.dispose();
    await this.createWordsSession();
  }

  /** Tear everything down and reset state (cancel / session end / failure). */
  dispose(): void {
    this.sender?.cancel();
    this.receiver?.cancel();
    this.sender = null;
    this.receiver = null;
    this.pendingOffer = null;
    this.peer?.close();
    this.signaling?.close();
    this.peer = null;
    this.signaling = null;
    this.selfId = null;
    this.peerId = null;
    this.isCreator = false;
    this.established = false;
    // words-method state
    this.method = null;
    if (this.sas?.timer != null) clearTimeout(this.sas.timer); // disarm a pending SAS timeout
    this.sas = null; // room-method (SAS) state
    this.reconnect = null; // reconnect (4b-ii) overlay state
    this.forgedIdentityPromise = null; // DEV/TEST forged key (if any) is per-session
    this.role = null;
    this.pendingSecretWords = null;
    this.prs = null;
    // link/qr (5b) state
    this.linkSecret = null;
    this.linkSecretEncoded = null;
    this.linkSettled = false;
    this.cpaceState = null;
    this.sessionKey = null;
    this.confirmFps = null;
    this.peerConfirmTag = null;
    this.confirmSettled = false;
    this.rendezvous = null;
    this.attemptCount = 0;
    this.attemptResolved = false;
    // per-session enrollment state (the long-term identity + keystore intentionally PERSIST)
    this.pairingId = null;
    this.enrollInitiated = false;
    this.enrollPinned = false;
    this.dispatch(connectionActions.reset());
    this.dispatch(transferActions.reset());
    this.dispatch(devActions.reset());
    // devActions.reset() cleared the projected own pubkey — re-surface it (identity outlives the session).
    void this.publishIdentity();
  }
}

export function createSessionController(dispatch: AppDispatch): SessionController {
  return new SessionController(dispatch);
}
