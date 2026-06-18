export interface SignalingHandlers {
  onWelcome?: (selfId: string, room: string, peers: string[]) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onSignal?: (from: string, data: unknown) => void;
}

export type ConnectOptions = { create: true } | { join: string };

/**
 * Thin wrapper over the signaling WebSocket. PURE signaling — never carries file
 * data. Owns the live WebSocket, so it stays in the core, never in the store.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;

  // `url` and `handlers` get stored as fields when connect() is implemented.
  constructor(_url: string, _handlers: SignalingHandlers = {}) {}

  connect(_opts: ConnectOptions): Promise<void> {
    // TODO: open ws to `${url}?app=filetransfer&create=1` or `&room=<code>`;
    //       parse frames, validate with serverMessageSchema (types/protocol.ts) — the
    //       server is untrusted — then fan out to this.handlers.
    throw new Error('SignalingClient.connect not implemented');
  }

  /** Send an addressed signaling message; the server stamps `from`. */
  send(_to: string, _data: unknown): void {
    // TODO: this.ws.send(JSON.stringify({ type: 'signal', to: _to, data: _data }))
    throw new Error('SignalingClient.send not implemented');
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
