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
import { makeConfirmation, verifyConfirmation, type ConfirmationRole } from './crypto/keyConfirmation';
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
  // private identity: IdentityKey         // Ed25519 long-term key (TOFU + reconnect sig)

  private selfId: string | null = null;
  private peerId: string | null = null;
  private isCreator = false;
  /** Which rendezvous+auth method this session is running. Drives the welcome/peer-joined
   *  branch and whether onChannelOpen runs real CPace key-confirmation or the step-1 no-op. */
  private method: 'room' | 'words' | null = null;

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
    } else {
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

    // ⚠️ step-1 "room" transport path: NO authentication. This `connected` is UNAUTHENTICATED
    // (anyone who reached the rendezvous is trusted). It exists only to prove the DataChannel
    // comes up; the real room method (4-digit + mandatory SAS) is a later step. The words
    // method above is the authenticated path. The no-file-bytes-before-connected invariant
    // holds regardless.
    this.established = true;
    this.dispatch(connectionActions.connectionEstablished());
  }

  /**
   * Words method: produce our confirmation tag over (sessionKey, localFp, remoteFp, ourRole),
   * send it to the peer, and verify the peer's tag. The two sides hold the same fingerprint
   * pair (labelled local/remote oppositely) — keyConfirmation canonicalises the order — so a
   * shared ISK + an honest channel ⇒ both tags verify ⇒ authenticated `connected`. A wrong
   * password yields divergent ISKs ⇒ verification fails ⇒ `failed`, channel torn down.
   */
  private runKeyConfirmation(local: string | null, remote: string | null): void {
    if (!this.sessionKey || !this.role || !local || !remote) {
      this.onWordsPairingFailure('key-confirmation: missing session key or DTLS fingerprints');
      return;
    }
    this.confirmFps = { local, remote };
    const tag = makeConfirmation(this.sessionKey, local, remote, this.role);
    void this.peer
      ?.send(JSON.stringify({ kind: 'confirm', role: this.role, tag: bytesToHex(tag) }))
      .catch((err) => this.onWordsPairingFailure(`key-confirmation: failed to send tag (${errText(err)})`));
    this.tryVerifyConfirmation(); // the peer's tag may already be waiting (order-independent)
  }

  /** Verify the peer's tag once BOTH our fingerprints and the peer's tag are known. One-shot. */
  private tryVerifyConfirmation(): void {
    if (this.confirmSettled) return;
    if (!this.sessionKey || !this.role || !this.confirmFps || !this.peerConfirmTag) return;
    // Reflection defense: verify under the role we EXPECT the peer to hold (the opposite of
    // ours), never a role claimed on the wire — an echoed copy of our own tag fails here.
    const peerRole: ConfirmationRole = this.role === 'initiator' ? 'responder' : 'initiator';
    const ok = verifyConfirmation(
      this.sessionKey,
      this.confirmFps.local,
      this.confirmFps.remote,
      peerRole,
      this.peerConfirmTag,
    );
    this.confirmSettled = true;
    if (ok) {
      this.attemptResolved = true; // success — no later signal should count as a failure
      this.established = true;
      this.dispatch(connectionActions.connectionEstablished());
    } else {
      this.onWordsPairingFailure('key-confirmation mismatch — wrong words or a man-in-the-middle');
    }
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

  /** The full 5-word credential (rendezvous + 4 secret) for display, or null if not yet known. */
  private fullCredential(): string[] | null {
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

  /** Stash the peer's confirmation tag and try to settle (order-independent with our own). */
  private onConfirmMessage(tagHex: string): void {
    if (this.method !== 'words' || this.confirmSettled) return;
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
    this.role = null;
    this.pendingSecretWords = null;
    this.prs = null;
    this.cpaceState = null;
    this.sessionKey = null;
    this.confirmFps = null;
    this.peerConfirmTag = null;
    this.confirmSettled = false;
    this.rendezvous = null;
    this.attemptCount = 0;
    this.attemptResolved = false;
    this.dispatch(connectionActions.reset());
    this.dispatch(transferActions.reset());
    this.dispatch(devActions.reset());
  }
}

export function createSessionController(dispatch: AppDispatch): SessionController {
  return new SessionController(dispatch);
}
