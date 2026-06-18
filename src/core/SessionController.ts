import type { AppDispatch } from '../store';
import { connectionActions } from '../store/connectionSlice';
import type { SignalingClient } from './signaling/SignalingClient';
import type { PeerConnection } from './webrtc/PeerConnection';
import { splitWords } from './words/words';

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

  constructor(private readonly dispatch: AppDispatch) {}

  /** A-side: start a "words" session — allocate a room, generate the words. */
  async createWordsSession(): Promise<void> {
    this.dispatch(connectionActions.createStarted({ method: 'words' }));
    // TODO:
    //  1. words = generateWords()                         // core/words/words.ts (1 rendezvous + 3 secret)
    //  2. signaling.connect({ create: true })             // server allocates the rendezvous room
    //  3. dispatch(roomReady({ room, credential: words })) // show words to A
    //  4. on peer-joined  -> this.beginPairing(secretOf(words))
    throw notImplemented('createWordsSession');
  }

  /** B-side: join a "words" session — route on the rendezvous word, PAKE on the rest. */
  async joinWordsSession(words: string[]): Promise<void> {
    const { rendezvous } = splitWords(words);
    this.dispatch(connectionActions.joinStarted({ method: 'words', room: rendezvous }));
    // TODO: signaling.connect({ join: rendezvous }), then run CPace over signaling.
    return this.beginPairing();
  }

  /** Run key agreement, key-confirmation (channel binding), then open the transfer. */
  private async beginPairing(): Promise<void> {
    this.dispatch(connectionActions.pairingStarted({ peerId: '' /* from welcome */ }));
    // TODO:
    //  - CPace round over signaling        -> shared key K           (core/crypto/cpace.ts)
    //  - exchange SDP offer/answer         -> DTLS fingerprints      (core/webrtc/PeerConnection.ts)
    //  - key-confirmation: MAC(K, fingerprint) both ways            (core/crypto/keyConfirmation.ts)
    //      mismatch -> dispatch(failed(...));  match -> dispatch(connectionEstablished())
    //  - INVARIANT: no file bytes until status === 'connected'
    throw notImplemented('beginPairing');
  }

  /** Send a file. Only valid once connected (the UI gates this too). */
  async sendFile(_file: File): Promise<void> {
    // TODO: chunk + backpressure over the DataChannel    (core/transfer/fileTransfer.ts)
    throw notImplemented('sendFile');
  }

  /** Tear everything down and reset state (cancel / session end / failure). */
  dispose(): void {
    this.peer?.close();
    this.signaling?.close();
    this.peer = null;
    this.signaling = null;
    this.dispatch(connectionActions.reset());
  }
}

function notImplemented(what: string): Error {
  return new Error(`SessionController.${what} not implemented yet`);
}

export function createSessionController(dispatch: AppDispatch): SessionController {
  return new SessionController(dispatch);
}
