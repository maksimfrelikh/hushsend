import type { AppDispatch } from '../store';
import { connectionActions } from '../store/connectionSlice';
import { devActions } from '../store/devSlice';
import { SignalingClient } from './signaling/SignalingClient';
import { PeerConnection } from './webrtc/PeerConnection';
import { splitWords } from './words/words';

const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  // private sessionKey: Uint8Array | null // CPace ISK, used for key-confirmation

  private selfId: string | null = null;
  private peerId: string | null = null;
  private isCreator = false;
  /** true once we've reached `connected`; after that a signaling drop is harmless (P2P is live). */
  private established = false;
  private readonly signalingUrl: string;

  constructor(private readonly dispatch: AppDispatch) {
    this.signalingUrl = import.meta.env.VITE_SIGNALING_URL || DEFAULT_SIGNALING_URL;
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
      onClose: (code, reason) => this.onSignalingClose(code, reason),
    });
  }

  private onWelcome(selfId: string, room: string, peers: string[]): void {
    this.selfId = selfId;
    this.dispatch(devActions.setSelfId(selfId));
    if (this.isCreator) {
      // A: room allocated. Show the code, wait; we initiate when a peer joins.
      this.dispatch(connectionActions.roomReady({ room, credential: null }));
    } else if (peers.length > 0) {
      // B: someone is already here -> we are the newcomer -> RESPONDER (await offer).
      const other = peers[0];
      this.peerId = other;
      this.startPeer(other, /* initiator */ false);
      this.dispatch(connectionActions.pairingStarted({ peerId: other }));
    }
    // else (joined an existing-but-empty room): stay put; we'll initiate on peer-joined.
  }

  private onPeerJoined(peerId: string): void {
    if (this.peer) return; // 1:1 — already engaged with a peer
    // We were already in the room -> we are the INITIATOR toward the newcomer.
    this.peerId = peerId;
    this.startPeer(peerId, /* initiator */ true);
    this.dispatch(connectionActions.pairingStarted({ peerId }));
  }

  private onPeerLeft(peerId: string): void {
    if (peerId !== this.peerId) return;
    if (import.meta.env.DEV) console.debug('[session] peer left', peerId);
    // Step 1: a live DataChannel survives the peer's signaling drop, so we don't tear
    // down once connected. Lobby/peer-loss handling is a later concern.
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
    void this.peer?.handleSignal(data);
  }

  private async onChannelOpen(): Promise<void> {
    // DataChannel is open: transport is up. Now "key-confirmation".
    this.dispatch(connectionActions.confirmStarted());
    const local = this.peer?.localFingerprint() ?? null;
    const remote = this.peer?.remoteFingerprint() ?? null;
    console.info('[session] DTLS fingerprints — local:', local, '| remote:', remote);
    this.dispatch(devActions.setFingerprints({ local, remote }));

    await this.confirmKey();

    // ⚠️ STEP-1 NOTE: there is NO authentication here. This `connected` is TEMPORARY /
    // UNAUTHENTICATED — anyone who reached the rendezvous is trusted. Step 3 replaces
    // confirmKey() with real CPace + a key-confirmation MAC over the remote DTLS
    // fingerprint; only then does `connected` mean "authenticated & channel-bound".
    // The "no file bytes before connected" invariant is preserved either way.
    this.established = true;
    this.dispatch(connectionActions.connectionEstablished());
  }

  /**
   * STUB (step 1). Step 3 replaces this with CPace key agreement + a key-confirmation
   * MAC over the negotiated DTLS fingerprint (mismatch -> abort, no data). Empty no-op
   * for the transport test; the confirming -> connected transition is kept intentionally.
   */
  private async confirmKey(): Promise<void> {
    /* intentionally empty in step 1 — real key-confirmation lands in step 3 */
  }

  private onChannelClose(): void {
    if (import.meta.env.DEV) console.debug('[session] data channel closed');
  }

  private onPeerMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return; // step-1 harness speaks JSON text only
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { kind?: unknown; text?: unknown };
    if (m.kind === 'ping' && typeof m.text === 'string') {
      this.dispatch(devActions.appendLog(`← ping: ${m.text}`));
      void this.peer?.send(JSON.stringify({ kind: 'echo', text: m.text })); // echo back
    } else if (m.kind === 'echo' && typeof m.text === 'string') {
      this.dispatch(devActions.appendLog(`← echo: ${m.text}`));
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
  // STEP 2/3 — words (CPace) + crypto. STILL STUBS; do not implement here yet.
  // ===========================================================================

  /** A-side: start a "words" session — allocate a room, generate the words. */
  async createWordsSession(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'words' }));
    // TODO (step 2):
    //  1. words = generateWords()                         // core/words/words.ts (1 rendezvous + 4 secret)
    //  2. signaling.connect({ create: true })             // server allocates the rendezvous room
    //  3. dispatch(roomReady({ room, credential: words })) // show words to A
    //  4. on peer-joined  -> this.beginPairing(secretOf(words))
    throw notImplemented('createWordsSession');
  }

  /** B-side: join a "words" session — route on the rendezvous word, PAKE on the rest. */
  async joinWordsSession(words: string[]): Promise<void> {
    const { rendezvous } = splitWords(words);
    this.dispatch(connectionActions.joinStarted({ method: 'words', room: rendezvous }));
    // TODO (step 2): signaling.connect({ join: rendezvous }), then run CPace over signaling.
    return this.beginPairing();
  }

  /** Run key agreement, key-confirmation (channel binding), then open the transfer. */
  private async beginPairing(): Promise<void> {
    this.dispatch(connectionActions.pairingStarted({ peerId: '' /* from welcome */ }));
    // TODO (step 3):
    //  - CPace round over signaling        -> shared key K           (core/crypto/cpace.ts)
    //  - exchange SDP offer/answer         -> DTLS fingerprints      (core/webrtc/PeerConnection.ts)
    //  - key-confirmation: MAC(K, fingerprint) both ways            (core/crypto/keyConfirmation.ts)
    //      mismatch -> dispatch(failed(...));  match -> dispatch(connectionEstablished())
    //  - INVARIANT: no file bytes until status === 'connected'
    throw notImplemented('beginPairing');
  }

  /** Send a file. Only valid once connected (the UI gates this too). */
  async sendFile(_file: File): Promise<void> {
    // TODO (step 2): chunk + backpressure over the DataChannel    (core/transfer/fileTransfer.ts)
    throw notImplemented('sendFile');
  }

  /** Tear everything down and reset state (cancel / session end / failure). */
  dispose(): void {
    this.peer?.close();
    this.signaling?.close();
    this.peer = null;
    this.signaling = null;
    this.selfId = null;
    this.peerId = null;
    this.isCreator = false;
    this.established = false;
    this.dispatch(connectionActions.reset());
    this.dispatch(devActions.reset());
  }
}

function notImplemented(what: string): Error {
  return new Error(`SessionController.${what} not implemented yet`);
}

export function createSessionController(dispatch: AppDispatch): SessionController {
  return new SessionController(dispatch);
}
