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
import { sasRoleFor } from './sasRole';
import { pairingRoleFor } from './pairingRole';
import { peerLeftAbortsPairing } from './livenessGate';
import {
  buildIceServers,
  configuredStunUrls,
  DEFAULT_PRIVACY_MODE,
  NO_TURN,
  type PrivacyMode,
  type TurnCredentials,
} from './iceServers';
import type { PeerInfo } from '../types/protocol';
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
 * Mesh-lobby pairing control frames over the (untrusted) SIGNALING relay — room method only. These
 * coordinate WHICH two peers raise a 1:1 channel; they carry NO secret and authenticate nothing (the
 * SAS does). Unlike the SDP/cpace/sas frames, these may arrive from a peer we are NOT yet paired with
 * (that is the whole point of picking), so they are handled BEFORE the 1:1 `from !== peerId` gate.
 *   - `pair-request`: "I picked you" — readies/triggers the counterpart (the responder's request
 *     prompts the initiator to offer; the initiator's request readies the responder before its offer).
 *   - `busy`: "I'm already pairing with someone else" — a clear rejection so the picker never hangs.
 */
const lobbySignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pair-request') }),
  z.object({ kind: z.literal('busy') }),
]);
type LobbySignal = z.infer<typeof lobbySignalSchema>;

/**
 * How long the SAS window may stay open before we give up. Two phases share this budget, both
 * ending on the SAME failSas → `failed` + close path as every other SAS failure:
 *   - the pre-SAS PAIRING window (peer-joined → SAS shown): a peer that joins but never completes
 *     the commit-reveal (e.g. commits, then withholds its nonce reveal) must not leave us hanging
 *     in `pairing` forever. The server's 4-digit idle-TTL only bounds the rendezvous, not a peer
 *     that joined then stalls the in-channel commit-reveal — so this client-side deadline is the
 *     real backstop. Read through preSasTimeoutMs().
 *   - the human COMPARISON window (awaitingSas → confirming): a stalled comparison (peer walked
 *     away, one side never confirms) must not hang either. Generous (humans read 3 words aloud).
 *     Read through sasConfirmTimeoutMs().
 *
 * Both phases reuse the SAME single timer (armSasTimeout clears any prior handle), and both read
 * their duration through a DEV-only override so e2e can drive each timeout branch in ~hundreds of
 * ms instead of a real 120 s wait — but through SEPARATE knobs (preSasTimeoutMs vs
 * sasConfirmTimeoutMs) so shrinking one never pre-empts the other's state under test (the
 * comparison-timeout test relies on the pre-SAS window keeping its default while it shrinks the
 * comparison one). Production always uses the fixed default for both (the overrides are
 * dead-code-eliminated from prod builds).
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
 * Resolve the pre-SAS PAIRING deadline (peer-joined → SAS shown). Production ALWAYS uses the fixed
 * DEFAULT_SAS_CONFIRM_TIMEOUT_MS — a peer that joins then withholds its commit-reveal must not hang
 * us in `pairing` forever, and that backstop is non-overridable in prod. A DEV-only
 * `?preSasTimeoutMs=N` query override (or a `window.__HUSHSEND_PRE_SAS_TIMEOUT_MS__` global) lets an
 * e2e tab drive the FIRING direction of this deadline — a stalled peer (one that withholds its
 * sas-nonce, see stallSasNonceEnabled) → the OTHER side fails here at the deadline rather than hangs
 * — with a tiny value instead of a real 120 s wait. Kept DELIBERATELY SEPARATE from
 * sasConfirmTimeoutMs() (the comparison window): the comparison-timeout test shrinks only THAT knob,
 * so the pre-SAS backstop must not be shrunk by the same one (it could pre-empt awaitingSas before
 * the comparison window even arms). DEV-gated like the other knobs → dead-code-eliminated in prod.
 */
function preSasTimeoutMs(): number {
  if (import.meta.env.DEV) {
    try {
      const w = window as unknown as { __HUSHSEND_PRE_SAS_TIMEOUT_MS__?: unknown };
      if (typeof w.__HUSHSEND_PRE_SAS_TIMEOUT_MS__ === 'number' && w.__HUSHSEND_PRE_SAS_TIMEOUT_MS__ > 0) {
        return w.__HUSHSEND_PRE_SAS_TIMEOUT_MS__;
      }
      const q = new URLSearchParams(window.location.search).get('preSasTimeoutMs');
      const n = q ? Number(q) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* no window (non-browser) — fall through to the default */
    }
  }
  return DEFAULT_SAS_CONFIRM_TIMEOUT_MS;
}

/**
 * Reconnect re-auth liveness deadline (prod-fixed, matches the pre-SAS default). The reconnect path
 * has its OWN backstop, separate from the SAS timers: the reconnect attempt keeps `this.sas` primed
 * as the fallback (so the SAS pre-timer is also armed), but that timer guards the SAS commit-reveal,
 * NOT a stalled `reconnect-init` / `reconnect-proof`. Without this deadline a MISMATCHED entry — this
 * side on the reconnect path while the peer joined via the plain-SAS lobby (a fresh SAS, never a
 * reconnect response) — would leave us waiting for a reconnect response that never comes, hanging in
 * `pairing` ("agreeing on keys") forever. See reconnectTimeoutMs() / armReconnectTimeout().
 */
const DEFAULT_RECONNECT_TIMEOUT_MS = 120_000;

/**
 * Resolve the reconnect re-auth liveness deadline. Production ALWAYS uses the fixed 120 s default
 * (same as the pre-SAS deadline — reconnect is automatic, so the exact value is not critical, only
 * that a stalled re-auth eventually FAILS CLOSED rather than hangs). This is a LIVENESS bound, not a
 * security one: it changes nothing in the two-check verify or the crypto. A DEV-only
 * `?reconnectTimeoutMs=N` query override (or a `window.__HUSHSEND_RECONNECT_TIMEOUT_MS__` global) lets
 * an e2e tab drive the FIRING direction in seconds instead of a real 120 s wait. Kept DELIBERATELY
 * SEPARATE from the SAS knobs (preSasTimeoutMs / sasConfirmTimeoutMs) so shrinking it can't pre-empt
 * the SAS pre-timer / comparison state in a test that exercises one path without the other. DEV-gated
 * like the other knobs → dead-code-eliminated in prod.
 */
function reconnectTimeoutMs(): number {
  if (import.meta.env.DEV) {
    try {
      const w = window as unknown as { __HUSHSEND_RECONNECT_TIMEOUT_MS__?: unknown };
      if (typeof w.__HUSHSEND_RECONNECT_TIMEOUT_MS__ === 'number' && w.__HUSHSEND_RECONNECT_TIMEOUT_MS__ > 0) {
        return w.__HUSHSEND_RECONNECT_TIMEOUT_MS__;
      }
      const q = new URLSearchParams(window.location.search).get('reconnectTimeoutMs');
      const n = q ? Number(q) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* no window (non-browser) — fall through to the default */
    }
  }
  return DEFAULT_RECONNECT_TIMEOUT_MS;
}

/**
 * DEV/TEST knob (reconnect liveness-deadline test): make THIS side reach the reconnect handshake but
 * NEVER send its `reconnect-proof` — i.e. simulate a peer that does not complete the re-auth. (The
 * real-world trigger is a MISMATCHED entry, where the peer joined via the plain-SAS lobby and never
 * runs the reconnect protocol at all; withholding the proof reproduces the same "no reconnect response"
 * stall deterministically.) Drives the FIRING direction of the reconnect deadline e2e: the peer (the
 * reconnect initiator) never receives this side's proof, stays in `pairing`, and must fail at the
 * (shrunk) reconnect deadline rather than hang. Mirrors stallSasNonceEnabled (`?stallReconnect=1` /
 * `window.__HUSHSEND_STALL_RECONNECT__`): gated behind `import.meta.env.DEV` so it is dead-code-
 * eliminated from production builds.
 */
function stallReconnectProofEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const w = window as unknown as { __HUSHSEND_STALL_RECONNECT__?: unknown };
    if (w.__HUSHSEND_STALL_RECONNECT__ === true) return true;
    return new URLSearchParams(window.location.search).get('stallReconnect') === '1';
  } catch {
    return false; // no window (non-browser) — never stall
  }
}

/**
 * DEV/TEST knob (pre-SAS deadline test): force THIS side to reach the SAS commit-reveal but NEVER
 * reveal its own sas-nonce — i.e. simulate a peer that joins, commits, computes + shows the SAS
 * (reaches awaitingSas), then withholds its nonce reveal. Drives the FIRING direction of the pre-SAS
 * pairing deadline e2e: the OTHER side never gets this side's nonce, stays in `pairing`, and must
 * fail at the (shrunk) pre-SAS deadline rather than hang. Mirrors the other DEV-only knobs
 * (`?stallSasNonce=1` / `window.__HUSHSEND_STALL_SAS_NONCE__`): gated behind `import.meta.env.DEV` so
 * it is dead-code-eliminated from production builds.
 */
function stallSasNonceEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const w = window as unknown as { __HUSHSEND_STALL_SAS_NONCE__?: unknown };
    if (w.__HUSHSEND_STALL_SAS_NONCE__ === true) return true;
    return new URLSearchParams(window.location.search).get('stallSasNonce') === '1';
  } catch {
    return false; // no window (non-browser) — never stall
  }
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
 * DEV/TEST knob (step 6d): force the WebRTC PeerConnection to treat ICE as FAILED (and suppress its own
 * candidates so no real path forms), so the Max-privacy-direct-failure path (→ terminal `failed` + a
 * switch-to-Reliable hint) can be driven in e2e without a real network failure. Mirrors
 * `forgeReconnectKeyEnabled` (`?forceIceFail=1` / `window.__HUSHSEND_FORCE_ICE_FAIL__`): gated behind
 * `import.meta.env.DEV` so it is dead-code-eliminated from production builds.
 */
function forceIceFailEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const w = window as unknown as { __HUSHSEND_FORCE_ICE_FAIL__?: unknown };
    if (w.__HUSHSEND_FORCE_ICE_FAIL__ === true) return true;
    return new URLSearchParams(window.location.search).get('forceIceFail') === '1';
  } catch {
    return false; // no window (non-browser) — never force
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
  /** initiator (A, creator) or responder (B, joiner) — fixes the challenge order in the transcript
   *  AND who announces the pairingId / who proves first. INTENTIONALLY create/join, NOT the
   *  per-pairing id role (`this.role`): the verifier-first side must be fixed so a key change is
   *  caught before the forger can settle (`onReconnectProof`). Reconnect is 1:1 creator↔joiner
   *  (mesh reconnect is a later step), so this is well-defined. Do NOT switch it to id order. */
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
  /** liveness deadline for the re-auth wait (reconnect-init → reconnect-proof/fallback); armed at
   *  pairing start, cleared on settle / fallback / fail. Live handle — core-only, never in the store.
   *  INDEPENDENT of the SAS timers (those guard the SAS commit-reveal, not a stalled reconnect). */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-session SAS state for the room method. Its presence (`this.sas != null`) is also the flag
 * that distinguishes the SAS-authenticated room path from the step-1 UNauthenticated room path
 * (both project `method: 'room'`) and from the words path (which uses `sessionKey`). Lives ONLY
 * in the core.
 */
interface SasState {
  /** initiator or responder — fixes the nonce order + commit-reveal order in the transcript. Set
   *  PER-PAIRING from the two readable ids in beginPairing (smaller id = initiator), NOT from
   *  create/join; provisional until then (see newSasState). Mirrors `this.role` for this pair. */
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

/**
 * Failure reason for a Max-privacy direct-connection failure (the STRICT model: Max-privacy never
 * relays, so a direct ICE failure is terminal). A STABLE, user-readable marker so the FailedScreen can
 * classify it from the error text — like the MITM / room-not-found cases — and render the
 * switch-to-Reliable hint. Keep the "directly" / "Max privacy" tokens in sync with FailedScreen's
 * detection.
 */
const DIRECT_FAIL_REASON = "couldn't connect directly (Max privacy)";

/** Fresh SAS state for the room method, with our own nonce drawn from the CSPRNG. The role is
 *  PROVISIONAL ('initiator' placeholder) — beginPairing overwrites it with the per-pairing,
 *  id-derived role once both ids are known, well before any SAS signal is processed. */
function newSasState(): SasState {
  return {
    role: 'initiator',
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
    timer: null,
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
  /**
   * WebRTC signals (offer / answer / ICE) that arrived for the ACTIVE pairing (`from === peerId`)
   * while `this.peer` was still null — i.e. AFTER beginPairing fixed `peerId` but BEFORE startPeer
   * finished building the PeerConnection. That window opens whenever startPeer is gated on an async
   * step that runs concurrently with the peer's offer: most sharply, a Reliable-mode ANSWERER still
   * awaiting its coturn creds (`ensureTurnReady` pending) when a Max-privacy offerer's offer arrives.
   * Without buffering, that early offer hit `this.peer?.handleSignal` as a NO-OP and was silently
   * DROPPED — deadlocking a mixed-privacy room pair, and latently link/qr (which, unlike words, has no
   * CPace gate serializing the offer behind a round-trip). startPeer replays this queue in arrival
   * order right after building the PC (flushPendingPeerSignals); ICE that races ahead of the offer is
   * re-buffered by the PC's own pendingIce, so replay order is safe. CLEARED on every teardown / reset
   * / retry (clearPendingPeerSignals) so a stale signal from a finished attempt can never replay into
   * the next attempt's PC. Lives ONLY in the core (plain payloads, never entered into the store).
   */
  private readonly pendingPeerSignals: unknown[] = [];

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

  // --- per-pairing transport/crypto role. Lives ONLY in the core. ---
  /** initiator or responder, fixed PER-PAIRING from the two readable ids (smaller id = initiator,
   *  via `pairingRoleFor`) — NOT from create/join, so a joiner↔joiner lobby pair still gets exactly
   *  one of each (the old create/join rule left both `responder` → no offer, SAS commit-reveal
   *  deadlock). Assigned once at pairing start (beginPairing). Drives the WebRTC offer/answer
   *  direction, CPace init/respond (words), and the key-confirmation transcript (words/link/qr). The
   *  room method mirrors it into `this.sas.role` (SAS nonce order + commit-reveal); the reconnect
   *  protocol role is SEPARATE and stays create/join (see ReconnectState.role). For a 1:1 pair the
   *  OUTCOME is identical to the old rule — only which side offers/reveals first is now id-ordered. */
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
  /** true once the DataChannel has OPENED (transport up). From this point the DataChannel + ICE are
   *  the SOLE liveness authority for the 1:1 methods — a signaling `peer-left` no longer aborts the
   *  pairing (see onPeerLeft / livenessGate). Reset on a words retry / lobby reset / dispose. */
  private channelOpen = false;
  private readonly signalingUrl: string;

  // --- privacy toggle + TURN relay (step 6d, client side) — picks the iceServers the PeerConnection
  //     is built with. Lives ONLY in the core. ---
  /** `max` (direct only, default) vs `reliable` (STUN + TURN relay). Pushed in from the persisted UI
   *  pref (prefs.tsx) via setPrivacyMode; READ at pairing start (so a mid-session toggle affects the
   *  NEXT connection, not the live one). */
  private privacyMode: PrivacyMode = DEFAULT_PRIVACY_MODE;
  /** This session's fetched coturn credentials (Reliable mode only). Null until
   *  fetched; reset per session in openSignaling (creds are tied to the live signaling socket).
   *  NO_TURN (empty urls) ⇒ relay unavailable → we stay direct-only. */
  private turnCreds: TurnCredentials | null = null;
  /** Memoizes the one-shot TURN fetch per session so concurrent startPeer calls never double-request. */
  private turnFetch: Promise<void> | null = null;

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

  /**
   * Set the privacy mode (step 6d). Pushed in from the persisted UI pref (prefs.tsx) — `max` (direct
   * only, default) or `reliable` (allow a TURN relay fallback). It is READ at pairing start (iceServers
   * are assembled then), so toggling mid-session affects the NEXT connection, not the live one.
   * Max-privacy is STRICT: it NEVER relays — a direct connection failure is terminal (`failed`, with a
   * hint to switch to Reliable), never silently relayed and never offered a relay. Cheap setter — no
   * transport work happens here.
   */
  setPrivacyMode(mode: PrivacyMode): void {
    this.privacyMode = mode;
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
    // A fresh signaling socket → any prior TURN creds are stale (they were minted for the old socket).
    // Drop them so Reliable mode re-fetches against THIS session's socket at pairing start.
    this.turnCreds = null;
    this.turnFetch = null;
    this.signaling = new SignalingClient(this.signalingUrl, {
      onWelcome: (selfId, room, peers) => this.onWelcome(selfId, room, peers),
      onPeerJoined: (peer) => this.onPeerJoined(peer),
      onPeerLeft: (peerId) => this.onPeerLeft(peerId),
      onSignal: (from, data) => this.onSignal(from, data),
      onRoomClosed: (reason) => this.onRoomClosed(reason),
      onClose: (code, reason) => this.onSignalingClose(code, reason),
    });
  }

  private onWelcome(selfId: string, room: string, peers: PeerInfo[]): void {
    this.selfId = selfId;
    this.dispatch(devActions.setSelfId(selfId));
    // Seed the roster from the existing-room peers (mesh lobby — room method). Harmless for
    // words/link/qr (they auto-pair below and never render the roster).
    this.dispatch(connectionActions.rosterSet(peers));
    if (this.isCreator) {
      // A: rendezvous allocated. For words it IS the rendezvous word; show the full 5-word
      // credential (rendezvous + 4 secret) so A can read it aloud. For room, credential=null.
      // Then we sit in the room: the LOBBY (room) shows the roster; words/link/qr just wait.
      this.rendezvous = room;
      this.dispatch(connectionActions.roomReady({ room, credential: this.fullCredential() }));
    } else if (this.isLobby()) {
      // room method (mesh lobby): DON'T auto-pair. Land in the lobby (joining → awaitingPeer) so the
      // joiner sees the roster + picks whom to pair with, exactly like the creator. Pairing starts
      // ONLY on a human pick (pickPeer) or an inbound pair-request — see onPairRequest.
      this.rendezvous = room;
      this.dispatch(connectionActions.roomReady({ room, credential: null }));
    } else if (peers.length > 0) {
      // words / link / qr (and reconnect): 1:1 auto-pair with the first peer. Both ids are known now,
      // so beginPairing fixes the per-pairing role.
      this.beginPairing(peers[0].id);
    }
    // else (joined an existing-but-empty room): stay put; we'll begin pairing / fill the roster on
    // peer-joined.
  }

  private onPeerJoined(peer: PeerInfo): void {
    // Always reflect the newcomer in the roster (every method seeds it; only the lobby renders it).
    this.dispatch(connectionActions.rosterAdd(peer));
    if (this.isLobby()) return; // lobby: pairing starts on a human pick, not on a join — just roster
    if (this.peer || this.role) return; // 1:1 auto-pair: already engaged with a peer
    // A newcomer arrived while we were in the room. Both ids are known now → beginPairing.
    this.beginPairing(peer.id);
  }

  /**
   * True for the mesh-LOBBY rendezvous (room method, plain SAS): an authenticated 4-digit room where
   * several peers see each other and the human PICKS whom to raise a 1:1 channel with. Distinguished
   * by `this.sas` set AND `this.reconnect` null:
   *   - plain SAS room (createRoomSession/joinRoomSession): sas set, reconnect null → lobby.
   *   - reconnect (create/joinReconnectSession): sas set, reconnect set → NOT a lobby (1:1 auto-pair,
   *     no human pick — reconnect-in-lobby is deferred).
   *   - words / link / qr: sas null → NOT a lobby (1:1 auto-pair with a single peer).
   *   - step-1 transport room: sas null → NOT a lobby (legacy auto-pair, unchanged).
   */
  private isLobby(): boolean {
    return this.sas != null && this.reconnect == null;
  }

  /**
   * LOBBY pick → start a 1:1 pairing with `peerId` (room method only). Announces the pick to the peer
   * (`pair-request`) so it engages too, then sets up our own side via beginPairing — where the
   * per-pairing role (smaller id = initiator) decides who offers: the initiator offers immediately,
   * the responder stands ready (and sends its SAS commit). Glare (both pick each other) resolves
   * naturally — only the smaller id offers; the larger's pick just readies it. De-duped: a pick while
   * already engaged is ignored.
   */
  pickPeer(peerId: string): void {
    if (!this.isLobby()) return; // SAS-room lobby only
    if (this.peerId) return; // already engaged (UI is off the lobby; ignore a stray/duplicate pick)
    const role = pairingRoleFor(this.selfId, peerId);
    if (!role) {
      this.fail(new Error('cannot resolve pairing role — missing peer id'));
      return;
    }
    this.dispatch(connectionActions.lobbyNotice(null)); // a fresh pick clears any prior "busy" notice
    // Announce first (before beginPairing's async offer) so the peer readies itself: a responder's
    // pair-request prompts the initiator to offer; an initiator's pair-request readies the responder.
    this.sendLobby(peerId, { kind: 'pair-request' });
    this.beginPairing(peerId);
  }

  /** Relay a lobby control frame (pair-request / busy) to a specific peer over the signaling relay. */
  private sendLobby(to: string, frame: LobbySignal): void {
    this.signaling?.send(to, frame);
  }

  /** Route an inbound lobby control frame (validated). Lobby (room) only — a no-op otherwise. */
  private onLobbySignal(from: string, frame: LobbySignal): void {
    if (!this.isLobby()) return;
    if (frame.kind === 'pair-request') this.onPairRequest(from);
    else this.onBusy(from);
  }

  /**
   * A peer announced it picked us. If we are free → engage (beginPairing fixes the role by id: if we
   * are the initiator we offer, if the responder we ready + commit). If we are already pairing/
   * connected with a DIFFERENT peer → bounce it with `busy` (a clear rejection, no hang). If it is the
   * peer we are ALREADY engaged with (glare / duplicate) → ignore.
   */
  private onPairRequest(from: string): void {
    if (this.peerId === from) return; // already engaged with this peer (glare/duplicate) — ignore
    if (this.peerId || this.peer) {
      this.sendLobby(from, { kind: 'busy' }); // busy with someone else → clear reject
      return;
    }
    const role = pairingRoleFor(this.selfId, from);
    if (!role) {
      this.fail(new Error('cannot resolve pairing role — missing peer id'));
      return;
    }
    // Engage. We do NOT echo a pair-request — the sender already engaged on its side; the role-by-id
    // decides who offers (initiator) and who waits (responder).
    this.beginPairing(from);
  }

  /**
   * A peer we picked is already pairing with someone else. Tear down our half-started attempt and
   * return to the LOBBY with a clear "X is busy" notice — no hang, and we can pick another peer.
   * (Only the busy case returns to the lobby; the general post-session return-to-lobby is deferred.)
   */
  private onBusy(from: string): void {
    if (this.peerId !== from || this.established) return; // not the peer we picked, or already done
    this.resetPairingToLobby();
    this.dispatch(connectionActions.lobbyNotice({ kind: 'busy', peerId: from }));
  }

  /** Tear down a half-started lobby pairing and re-prime a fresh SAS state, returning to the lobby
   *  (awaitingPeer) with the room + roster intact so the human can pick another peer. */
  private resetPairingToLobby(): void {
    if (this.sas?.timer != null) clearTimeout(this.sas.timer);
    this.peer?.close();
    this.peer = null;
    this.clearPendingPeerSignals(); // drop a stale pre-PC offer/ICE so it can't replay into the next pick's PC
    this.peerId = null;
    this.role = null;
    this.channelOpen = false;
    this.confirmFps = null;
    this.peerConfirmTag = null;
    this.confirmSettled = false;
    this.sas = newSasState(); // fresh nonce for the next pick (still a SAS-room lobby session)
    this.dispatch(connectionActions.returnToLobby());
  }

  /**
   * Begin the 1:1 pairing with `peerId`. The transport/crypto role is PER-PAIRING, fixed from the two
   * readable ids (`pairingRoleFor`: lexicographically smaller id = initiator), NOT from create/join —
   * so a joiner↔joiner lobby pair still gets exactly one initiator + one responder (the old rule left
   * both `responder` → no WebRTC offer, SAS commit-reveal deadlock). Both peers compute it identically
   * (ids are unique in a room) → opposite roles. For a 1:1 creator↔joiner pair the OUTCOME is
   * unchanged — same connection, same authentication; only WHICH side offers / reveals first is now
   * id-ordered. Entry points (all with both ids known): the words/link/qr 1:1 auto-pair (onWelcome /
   * onPeerJoined), and — for the room mesh LOBBY — a human pick (pickPeer) or an inbound pair-request
   * (onPairRequest). De-dup against re-entry is the caller's job (the lobby handlers + onPeerJoined
   * guard on `this.peer`/`this.peerId`/`this.role` before calling here).
   */
  private beginPairing(peerId: string): void {
    this.peerId = peerId;
    const role = pairingRoleFor(this.selfId, peerId);
    if (!role) {
      // Fail closed: an unresolved role (a missing/equal id — impossible in a real room, ids are
      // unique) must NEVER silently default a side, or both could land on the same role and deadlock.
      this.fail(new Error('cannot resolve pairing role — missing peer id'));
      return;
    }
    this.role = role;
    const initiator = role === 'initiator';
    this.dispatch(connectionActions.pairingStarted({ peerId }));

    // Reliable mode: kick off the coturn-cred fetch now (the WS is up — `welcome` has arrived) so it
    // runs in PARALLEL with CPace/SAS; startPeer awaits the SAME memoized fetch before building the PC,
    // guaranteeing TURN is in iceServers from the start. Max-privacy: a no-op (never requests creds).
    void this.ensureTurnReady();

    if (this.method === 'words') {
      this.attemptResolved = false; // a fresh guess attempt begins (either role)
      if (initiator) {
        // Run CPace FIRST; bring up WebRTC only once we hold the ISK (onCpaceMessage), so the
        // DataChannel can't open before key-confirmation has a key to MAC the DTLS fingerprints under.
        this.beginCpaceAsInitiator();
      } else {
        // Responder: reply to CPace over signaling and stand ready as the WebRTC answerer. The
        // initiator's offer arrives only AFTER it finishes CPace, so the PeerConnection is up in time.
        void this.startPeer(peerId, /* initiator */ false);
      }
      return;
    }

    if (this.method === 'link' || this.method === 'qr') {
      // link/qr: no PAKE — bring up WebRTC straight away (the secret S is already in hand); the
      // key-confirmation over S runs once the DataChannel opens. Initiator offers, responder answers.
      void this.startPeer(peerId, initiator);
      return;
    }

    // room method. On the SAS path, both ids are known now → mirror the role into the SAS state (the
    // nonce-order + commit-reveal crypto role) and fix the asymmetric SAS UI reader/picker role
    // (`resolveSasRole`, same id ordering). The SAS RESPONDER commits FIRST (anti-grinding) — send our
    // commit now if that's us, before the initiator reveals. Arm the pre-SAS pairing deadline (the
    // 4-digit room TTL only bounds the rendezvous; without this a peer that joins then stalls the
    // commit-reveal would hang us in `pairing` forever). All of this no-ops on the step-1 UNauthenticated
    // room (`this.sas == null`), which just brings up the channel.
    if (this.sas) {
      this.sas.role = role; // per-pairing nonce ordering + commit-reveal (was create/join)
      this.resolveSasRole();
      if (!initiator) {
        // We are the SAS responder → COMMIT to our nonce now, before the initiator reveals theirs, so
        // we are locked to it and cannot grind it against the initiator's. The reveal waits for the
        // initiator's nonce (onSasSignal). Runs in parallel with the WebRTC bring-up below.
        this.sendSas({ kind: 'sas-commit', c: bytesToHex(sasCommit(this.sas.myNonce)) });
      }
      this.armSasTimeout('SAS pairing timed out', preSasTimeoutMs());
    }
    // reconnect (4b-ii): the re-auth wait (reconnect-init → reconnect-proof/fallback) gets its OWN
    // liveness deadline, INDEPENDENT of the SAS pre-timer above (which guards the SAS commit-reveal,
    // not a stalled reconnect). Without it a MISMATCHED entry — this side on the reconnect path while
    // the peer joined via the plain-SAS lobby (a fresh SAS, never a reconnect response) — would leave
    // us waiting forever in `pairing`. Fail-closed: a stalled re-auth ends in `failed`, not a hang;
    // nothing in the verify/crypto changes. A no-op off the reconnect path (`this.reconnect` null).
    if (this.reconnect && !this.reconnect.fellBack) {
      this.armReconnectTimeout('reconnect timed out — peer did not complete re-authentication', reconnectTimeoutMs());
    }
    // Initiator offers, responder answers (for words the responder's PeerConnection was started above).
    void this.startPeer(peerId, initiator);
  }

  private onPeerLeft(peerId: string): void {
    // Always drop the leaver from the roster (and clear a stale "busy" notice naming it). A peer we
    // are NOT paired with leaving the lobby must update the roster but otherwise not disturb us.
    this.dispatch(connectionActions.rosterRemove({ peerId }));
    if (peerId !== this.peerId) return;
    if (import.meta.env.DEV) console.debug('[session] peer left', peerId);
    // words: a peer that drops while the rendezvous is still the liveness authority (BEFORE the
    // DataChannel transport is up) aborts this pairing attempt (counts on A; a clean leave-and-fail
    // on B). Once the channel is open the DataChannel/ICE are the sole liveness signal — a
    // `peer-left` then is the benign post-connect socket close (ours or the peer's; the two sides
    // can connect-then-close a hair apart), and a REAL abort after channel-open is still counted by
    // onChannelClose. So we gate on peerLeftAbortsPairing, NOT a bare `!established` — this keeps the
    // anti-bruteforce window intact (every actual guess is counted by the confirmation-mismatch /
    // channel-close paths regardless) while not failing a peer that has, in fact, connected.
    if (this.method === 'words' && peerLeftAbortsPairing(this.established, this.channelOpen)) {
      this.onWordsPairingFailure('peer left during pairing');
    }
    // link/qr: same gate — a peer dropping before the transport is up aborts this single-use attempt
    // (no bytes); a post-channel-open `peer-left` is the benign post-connect close and is ignored.
    if ((this.method === 'link' || this.method === 'qr') && peerLeftAbortsPairing(this.established, this.channelOpen)) {
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

  /**
   * Bring up the PeerConnection for this pairing. Reliable mode fetches coturn creds FIRST (so the
   * TURN relay is in `iceServers` from the very start of ICE gathering — never added mid-negotiation);
   * Max-privacy resolves instantly and never contacts the relay. The privacy mode is read here, at
   * pairing start, which is why a mid-session toggle only affects the NEXT connection. async + voided
   * at the call sites; each call site is the last statement of its branch, so the one-microtask defer
   * (and the Reliable round-trip) reorders nothing.
   */
  private async startPeer(peerId: string, initiator: boolean): Promise<void> {
    await this.ensureTurnReady();
    const iceServers = this.iceServers();
    this.publishIceConfig();
    this.peer = new PeerConnection(
      {
        onSignal: (data) => this.signaling?.send(peerId, data),
        onOpen: () => void this.onChannelOpen(),
        onClose: () => this.onChannelClose(),
        onMessage: (data) => this.onPeerMessage(data),
        onIceFailed: () => this.onIceFailed(),
      },
      {
        iceServers,
        // STRICT model: in Max-privacy drop the peer's relay candidates so we are never relayed; an ICE
        // failure then fails terminally (onIceFailed) with a hint to switch to Reliable.
        filterRelay: this.privacyMode === 'max',
        forceIceFail: forceIceFailEnabled(),
      },
    );
    this.peer.start(initiator);
    // Replay any WebRTC signals that arrived before this PC existed (e.g. the peer's offer reached a
    // Reliable answerer while it was still fetching TURN creds). The queue is normally empty (signals
    // hit handleSignal directly once the PC is up); it is non-empty only in the pre-PC race window.
    this.flushPendingPeerSignals();
  }

  /** The iceServers for THIS pairing, from the privacy mode + configured STUN + (Reliable) fetched
   *  TURN creds. Max-privacy ⇒ STUN-only (or none); Reliable ⇒ STUN + TURN when a relay is configured. */
  private iceServers(): RTCIceServer[] {
    return buildIceServers({ mode: this.privacyMode, stunUrls: configuredStunUrls(), turn: this.turnCreds });
  }

  /**
   * Reliable mode only: fetch this session's short-lived coturn credentials BEFORE the PeerConnection
   * is created (so TURN is present from the first ICE candidate, not bolted on later). Memoized per
   * session (one request even if several startPeer calls race), and never throws — a failed/absent
   * relay resolves to NO_TURN (empty urls), which iceServers() treats as direct-only. Max-privacy is a
   * no-op: it NEVER requests creds, so the relay is never even contacted.
   */
  private ensureTurnReady(): Promise<void> {
    // Max-privacy never requests creds (strict — stay direct-only, never relay).
    if (this.privacyMode !== 'reliable') return Promise.resolve();
    if (this.turnCreds) return Promise.resolve(); // already have this session's creds
    if (!this.turnFetch) {
      this.turnFetch = (async () => {
        const creds = (await this.signaling?.requestTurnCredentials()) ?? NO_TURN;
        this.turnCreds = creds;
        this.dispatch(
          devActions.appendLog(
            creds.urls.length > 0
              ? `turn: relay available (${creds.urls.length} url${creds.urls.length > 1 ? 's' : ''})`
              : 'turn: relay unavailable — staying direct-only',
          ),
        );
      })();
    }
    return this.turnFetch;
  }

  /** Publish (DEV diagnostics) the ICE config the PeerConnection was just built with: the privacy
   *  mode, whether a relay was added, and the TURN creds it carried — the e2e reads this to confirm
   *  Reliable assembled a correct TURN entry and Max-privacy added none. Mirrors iceServers()'s logic. */
  private publishIceConfig(): void {
    // A relay is in the config only in Reliable mode, and only when the server actually returned relay
    // urls. Max-privacy is STRICT — it never relays, so it never carries a TURN entry.
    const relay = this.privacyMode === 'reliable' && !!this.turnCreds && this.turnCreds.urls.length > 0;
    this.dispatch(
      devActions.setIceConfig({
        mode: this.privacyMode,
        relay,
        urls: relay ? this.turnCreds!.urls : [],
        username: relay ? this.turnCreds!.username : '',
        credential: relay ? this.turnCreds!.credential : '',
      }),
    );
  }

  // ===========================================================================
  // STEP 6d — Max-privacy STRICT model. Max-privacy NEVER relays: the PeerConnection drops the peer's
  // relay candidates (filterRelay, always on in Max-privacy) and never requests local TURN, so no
  // relay path can ever form. A direct connection that cannot come up is therefore TERMINAL — we fail
  // (→ existing `failed` state, no new FSM state) with a hint to switch to Reliable, rather than
  // silently relaying or offering a consent-gated relay escalation. The relay path exists ONLY in
  // Reliable mode (STUN + TURN, where the filter is off). See core/relax.ts for the candidate filter.
  // ===========================================================================

  /**
   * PeerConnection reported ICE could NOT connect — only reachable in Max-privacy (the filter is on,
   * see PeerConnection.onIceFailure), so we never requested TURN and dropped the peer's relay
   * candidates: no relay path could ever have formed. STRICT model — this is terminal: fail with a
   * switch-to-Reliable hint (the FailedScreen renders the hint off this reason). No-op once established.
   */
  private onIceFailed(): void {
    if (this.established) return;
    this.dispatch(devActions.appendLog('ice: direct connection failed (Max privacy) — failing'));
    this.failDirect(DIRECT_FAIL_REASON);
  }

  /**
   * Terminal Max-privacy direct-connection failure: mark every per-method one-shot settled so their
   * own teardown paths can't also fire, then close the PeerConnection + fail (pairing → failed).
   * Method-agnostic. The reason carries the stable DIRECT_FAIL_REASON marker the FailedScreen keys its
   * switch-to-Reliable hint off.
   *
   * We DELIBERATELY do NOT close the signaling socket here (we leave that to dispose()). In Max-privacy
   * BOTH peers' ICE fails independently (each side's own connectivity check times out — they did not
   * "leave"); closing signaling would emit a spurious `peer-left` that the OTHER side's words/SAS
   * retry logic would misread as a guess attempt and bounce back to the lobby BEFORE its own ICE
   * failure fires. Leaving signaling up lets each side reach `failed` on its own timeout — matching a
   * real NAT failure, where the socket stays connected throughout. Closing only the (local, invisible
   * to the peer) PeerConnection also suppresses our own onClose, so no local words/SAS retry fires.
   */
  private failDirect(reason: string): void {
    this.attemptResolved = true; // words: don't let a later signal count this as a guess attempt
    this.linkSettled = true; // link/qr: close the teardown guard
    if (this.sas) {
      this.sas.settled = true;
      if (this.sas.timer != null) clearTimeout(this.sas.timer);
      this.sas.timer = null;
    }
    if (this.reconnect) {
      this.reconnect.settled = true;
      if (this.reconnect.timer != null) clearTimeout(this.reconnect.timer);
      this.reconnect.timer = null;
    }
    this.peer?.close();
    this.peer = null;
    this.clearPendingPeerSignals();
    this.fail(new Error(reason));
  }

  private onSignal(from: string, data: unknown): void {
    // Mesh-lobby pairing control (room method) is handled BEFORE the 1:1 gate, because a pick can
    // come from a peer we are not yet paired with (pair-request), or report that a peer we picked is
    // busy. Validated (the relay is UNTRUSTED) before use.
    const lobby = lobbySignalSchema.safeParse(data);
    if (lobby.success) {
      this.onLobbySignal(from, lobby.data);
      return;
    }
    if (from !== this.peerId) return; // 1:1 — ignore SDP/cpace/sas from anyone we're not pairing with
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
    // WebRTC tail (offer / answer / ICE). Past the `from !== this.peerId` gate above, this signal is
    // from our ACTIVE pairing. If the PeerConnection exists, hand it straight over. If not, the PC is
    // still being built — e.g. a Reliable answerer awaiting coturn creds (ensureTurnReady) when the
    // peer's offer arrives — so BUFFER it and replay once startPeer builds the PC, rather than dropping
    // it on a null peer. Shared fix for the mixed-privacy room deadlock AND the latent link/qr race;
    // words is unaffected (its offer is serialized behind the CPace gate, so the PC is already up).
    if (this.peer) {
      void this.peer.handleSignal(data);
    } else {
      this.pendingPeerSignals.push(data);
    }
  }

  /**
   * Replay the WebRTC signals buffered while `this.peer` was null (see onSignal / pendingPeerSignals)
   * into the freshly-built PeerConnection, in arrival order. setRemoteDescription does not depend on
   * iceServers, and our OWN candidates come from this already-built PC (creds included in Reliable), so
   * the "TURN in iceServers from the first candidate" invariant is untouched. Snapshot-then-clear so a
   * replay that synchronously re-enters (e.g. an answer being emitted) can't see a half-drained queue.
   */
  private flushPendingPeerSignals(): void {
    if (!this.peer || this.pendingPeerSignals.length === 0) return;
    const queued = this.pendingPeerSignals.splice(0);
    for (const data of queued) void this.peer.handleSignal(data);
  }

  /** Drop any buffered pre-PC WebRTC signals. Called on every teardown / reset / retry so a stale
   *  offer/ICE from a finished attempt can never be replayed into the NEXT attempt's PeerConnection. */
  private clearPendingPeerSignals(): void {
    this.pendingPeerSignals.length = 0;
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
        void this.startPeer(this.peerId!, /* initiator */ true);
      }
    } catch (err) {
      // A malformed / low-order peer point (active tampering) or a broken cpace frame aborts the
      // attempt here. A wrong password does NOT throw — it surfaces at key-confirmation instead.
      this.onWordsPairingFailure(errText(err));
    }
  }

  private async onChannelOpen(): Promise<void> {
    // The DataChannel transport is up: from here the DataChannel + ICE are the sole liveness signal,
    // so a signaling `peer-left` no longer aborts the pairing (see onPeerLeft). Set for every method
    // (it only GATES the 1:1 words/link/qr peer-left branches).
    this.channelOpen = true;
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
      this.closeSignalingAfterConnect(); // 1:1: the signaling socket has no further job — close it
    } else {
      this.onConfirmFailure(
        this.method === 'words'
          ? 'key-confirmation mismatch — wrong words or a man-in-the-middle'
          : 'key-confirmation mismatch — wrong or missing secret, or a man-in-the-middle',
      );
    }
  }

  /**
   * On an AUTHENTICATED `connected`, the 1:1 methods (words / link / qr) close their own signaling
   * socket. By that point signaling has no further job: ICE/SDP are exchanged, key-confirmation rode
   * the DataChannel, and TOFU enrollment rides the DataChannel too — so closing the socket costs the
   * session nothing while denying the UNTRUSTED server any knowledge of how long the P2P session
   * runs (it sees only the short pairing window, then we vanish). The live DataChannel + ICE remain
   * the sole liveness authority (see onPeerLeft / livenessGate), so neither this close nor the peer's
   * own equivalent close disturbs the transfer. Our own SignalingClient.close() sets its `closed`
   * flag, so it never calls back onSignalingClose — only the PEER observes a `peer-left`.
   *
   * 1:1 ONLY. The room method is a mesh LOBBY whose socket also carries the roster + other peers'
   * picks; tearing it down needs a "seal room" step (deferred — see BACKLOG). Reconnect runs over its
   * own fresh socket (method 'room', sas set), so it is excluded here and unaffected.
   */
  private closeSignalingAfterConnect(): void {
    if (this.method !== 'words' && this.method !== 'link' && this.method !== 'qr') return;
    this.dispatch(devActions.appendLog('signaling: P2P connected — closing signaling socket (server learns no session duration)'));
    this.signaling?.close();
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
    this.clearPendingPeerSignals();
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
    this.clearPendingPeerSignals(); // a fresh joiner's offer must not see a stale one from this attempt
    this.peerId = null;
    this.role = null;
    this.channelOpen = false; // next attempt's channel is not open yet
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
      await this.signaling!.connect({ create: true, codeType: 'token' }); // high-entropy token rendezvous (unguessable)
      // `welcome` carries the allocated token; onWelcome then shows the full link via fullCredential().
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * B-side: join a link or qr session. The rendezvous token + secret S come from the link fragment
   * (link: read from `location.hash` on page load; qr: decoded from a scanned/pasted link) — the
   * caller has ALREADY scrubbed the fragment from the address bar/history. Only the token goes to
   * the server (`join`, codeType=token); S stays local. On `welcome` (A already present) we become
   * the responder and run key-confirmation over S when the DataChannel opens.
   */
  async joinLinkSession(rendezvous: string, secret: Uint8Array, method: 'link' | 'qr'): Promise<void> {
    this.dispatch(connectionActions.joinStarted({ method, room: rendezvous }));
    this.isCreator = false;
    this.method = method;
    this.linkSecret = secret;
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: rendezvous, codeType: 'token' }); // token join — S never sent
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
    this.sas = newSasState(); // role fixed per-pairing by id in beginPairing (not create/join)
    try {
      this.openSignaling();
      await this.signaling!.connect({ create: true }); // 4-digit allocate — unchanged server path
      // `welcome` -> roomReady (shows the code); `peer-joined` -> beginPairing (WebRTC + SAS).
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
    this.sas = newSasState(); // role fixed per-pairing by id in beginPairing (not create/join)
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
   * the pairingId to reconnect under. The home screen passes the SELECTED recent-device row's
   * `pairingId` (the deduped freshest pin for that peer); absent that we fall back to the
   * most-recently-pinned peer overall. If we hold NO pin there is nothing to reconnect — we degrade
   * to a plain SAS room (the `this.reconnect == null` path), exactly the normal first-connect. On
   * `peer-joined` we initiate WebRTC; on channel-open we send `reconnect-init` announcing the
   * pairingId + our challenge. (UI selection only — the reconnect protocol is unchanged.)
   */
  async createReconnectSession(pairingId?: string): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'room' }));
    this.isCreator = true;
    this.method = 'room';
    // SAS primed as the fallback (no human cost unless surfaced); its role is fixed per-pairing by id
    // in beginPairing. The RECONNECT protocol role below stays create/join (creator = reconnect
    // initiator) — independent of the per-pairing transport role — so the verifier-first side is fixed
    // and a key change is caught before the forger can settle.
    this.sas = newSasState();
    try {
      const pins = await this.keystore.listPins();
      if (pins.length > 0) {
        // Reconnect under the SELECTED pin if the caller named one (and we still hold it); otherwise
        // the most-recently-pinned peer overall. Either way it is a real pin from THIS keystore.
        const pin =
          (pairingId !== undefined ? pins.find((p) => p.pairingId === pairingId) : undefined) ??
          pins.reduce((a, b) => (b.firstSeen > a.firstSeen ? b : a));
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
    this.sas = newSasState(); // SAS fallback role fixed per-pairing by id in beginPairing
    // RECONNECT protocol role stays create/join (joiner = reconnect responder) — see createReconnectSession.
    this.reconnect = newReconnectState('responder', null);
    this.dispatch(devActions.setReconnect({ active: true, outcome: null }));
    try {
      this.openSignaling();
      await this.signaling!.connect({ join: code });
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Compute + project the per-pairing SAS UI role (reader/picker) for THIS 1:1 channel from the two
   * readable ids: the lexicographically smaller id reads its phrase, the other is the blind picker
   * (`sasRoleFor`). Both peers compute it identically (ids are unique in the room) → opposite roles,
   * for ANY pair — including joiner↔joiner, where the old create/join rule made BOTH pickers. Called
   * at pairing start (both ids known) on the room+SAS path ONLY (`this.sas` set, incl. the reconnect
   * fallback); a no-op elsewhere (words/link/qr have no SAS). The role is a UI-only signal — it does
   * NOT touch `this.sas.role`, which stays initiator/responder for the nonce-ordering crypto. If an
   * id is missing nothing is dispatched, so the projection stays null and the SAS screen fails closed.
   */
  private resolveSasRole(): void {
    if (!this.sas) return; // SAS-authenticated room path only
    const role = sasRoleFor(this.selfId, this.peerId);
    if (role) this.dispatch(connectionActions.sasRoleResolved({ role }));
  }

  /** Relay a SAS commit/nonce frame to the peer through the (untrusted) signaling server. */
  private sendSas(frame: SasSignal): void {
    // DEV/TEST stall knob: a peer that reaches the SAS but NEVER reveals its own sas-nonce, to drive
    // the pre-SAS pairing-deadline FIRING e2e — the other side then never completes the commit-reveal
    // and must fail at the deadline, not hang. Only the nonce REVEAL is withheld (the commit still
    // goes out, so this side still computes + shows its SAS). Dead-code-eliminated in prod (DEV-gated).
    if (frame.kind === 'sas-nonce' && stallSasNonceEnabled()) {
      this.dispatch(devActions.appendLog('sas: stalling — withholding sas-nonce reveal (DEV knob)'));
      return;
    }
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
   * Arm (or re-arm) the reconnect re-auth liveness deadline — a backstop INDEPENDENT of the SAS
   * timers (the reconnect path keeps `this.sas` primed as the fallback, so the SAS pre-timer is also
   * armed, but it guards the SAS commit-reveal, NOT a stalled reconnect-init/-proof). On expiry →
   * failReconnect (→ `failed` + close), the SAME terminal path as a key-change / MITM / channel drop.
   * Liveness, not security: it changes nothing in the two-check verify or the crypto — a re-auth that
   * never gets a response from the peer (e.g. a mismatched entry: this side on reconnect, the peer on
   * the plain-SAS lobby path) ends in `failed` instead of an infinite "agreeing on keys" hang. It
   * clears any prior handle first; the live handle lives on `this.reconnect` (core-only, never in the
   * store). No-op once the reconnect attempt has settled or fallen back to SAS.
   */
  private armReconnectTimeout(reason: string, ms: number): void {
    const rc = this.reconnect;
    if (!rc || rc.settled || rc.fellBack) return;
    if (rc.timer != null) clearTimeout(rc.timer);
    rc.timer = setTimeout(() => this.failReconnect(reason), ms);
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
    // Symmetric to failReconnect closing out the SAS state: close out a parallel reconnect attempt so
    // its (independent) liveness deadline can't fire a second teardown after the SAS path already failed.
    if (this.reconnect && !this.reconnect.settled) {
      this.reconnect.settled = true;
      if (this.reconnect.timer != null) clearTimeout(this.reconnect.timer);
      this.reconnect.timer = null;
    }
    this.peer?.close();
    this.peer = null;
    this.clearPendingPeerSignals();
    this.signaling?.close();
    this.fail(new Error(reason));
  }

  // ---- reconnect re-auth (step 4b-ii) ----

  /** Relay a reconnect control frame to the peer over the DTLS-protected DataChannel. */
  private sendReconnect(frame: ReconnectFrame): void {
    // DEV/TEST stall knob: a side that reaches the reconnect handshake but NEVER sends its
    // reconnect-proof, to drive the reconnect liveness-deadline FIRING e2e — the peer then never
    // completes the re-auth and must fail at the deadline, not hang. Only the proof is withheld (the
    // initiator's reconnect-init still goes out). Dead-code-eliminated in prod (DEV-gated).
    if (frame.kind === 'reconnect-proof' && stallReconnectProofEnabled()) {
      this.dispatch(devActions.appendLog('reconnect: stalling — withholding reconnect-proof (DEV knob)'));
      return;
    }
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
    if (rc.timer != null) clearTimeout(rc.timer); // re-auth succeeded — disarm the liveness deadline
    rc.timer = null;
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
    // The SAS comparison takes over from here (its own pre-SAS / comparison deadlines bound it) — the
    // reconnect-specific deadline no longer applies, so disarm it to avoid a spurious mid-SAS expiry.
    if (rc.timer != null) clearTimeout(rc.timer);
    rc.timer = null;
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
    if (this.reconnect.timer != null) clearTimeout(this.reconnect.timer); // disarm the liveness deadline
    this.reconnect.timer = null;
    if (this.sas) {
      this.sas.settled = true;
      if (this.sas.timer != null) clearTimeout(this.sas.timer);
      this.sas.timer = null;
    }
    this.peer?.close();
    this.peer = null;
    this.clearPendingPeerSignals();
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
    this.clearPendingPeerSignals();
    this.signaling = null;
    this.selfId = null;
    this.peerId = null;
    this.isCreator = false;
    this.established = false;
    this.channelOpen = false;
    // words-method state
    this.method = null;
    if (this.sas?.timer != null) clearTimeout(this.sas.timer); // disarm a pending SAS timeout
    this.sas = null; // room-method (SAS) state
    if (this.reconnect?.timer != null) clearTimeout(this.reconnect.timer); // disarm the reconnect deadline
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
