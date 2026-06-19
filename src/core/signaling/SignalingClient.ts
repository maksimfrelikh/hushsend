import { serverMessageSchema } from '../../types/protocol';

export interface SignalingHandlers {
  onWelcome?: (selfId: string, room: string, peers: string[]) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onSignal?: (from: string, data: unknown) => void;
  /** Server invalidated our word room (TTL expiry / creator destroy). `reason` is informational. */
  onRoomClosed?: (reason: string) => void;
  /** Server-initiated close (e.g. 4009 "room not found"). NOT fired when WE call close(). */
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Event) => void;
}

/**
 * `codeType` picks the rendezvous-code shape the server allocates/validates:
 * default (omitted) = the 4-digit code used by room/link/QR; `'word'` = a single
 * EFF-short-#2 rendezvous word, used by the "words" method.
 */
export type ConnectOptions =
  | { create: true; codeType?: 'word' }
  | { join: string; codeType?: 'word' };

const APP_ID = 'filetransfer';

/**
 * Thin wrapper over the signaling WebSocket. PURE signaling — never carries file
 * data. Owns the live WebSocket, so it stays in the core, never in the store.
 *
 * The server is UNTRUSTED: every inbound frame is JSON-parsed and validated against
 * serverMessageSchema (zod) before we act on it; anything invalid is dropped.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  /** Set when WE intentionally close — suppresses the close/message callbacks of a
   *  socket we're tearing down (so a disposed session can't spuriously call back). */
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SignalingHandlers = {},
  ) {}

  /** Open the WS to `${url}?app=filetransfer&create=1` (allocate a room) or `&room=<code>`
   *  (join an existing one). Resolves once the socket is open, rejects if it fails to open. */
  connect(opts: ConnectOptions): Promise<void> {
    const params = new URLSearchParams({ app: APP_ID });
    if ('create' in opts) params.set('create', '1');
    else params.set('room', opts.join);
    if (opts.codeType) params.set('codeType', opts.codeType);

    const ws = new WebSocket(`${this.url}?${params}`);
    this.ws = ws;
    this.closed = false;

    let opened = false;
    return new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        opened = true;
        resolve();
      });
      ws.addEventListener('message', (e) => this.handleMessage(e));
      ws.addEventListener('error', (e) => {
        this.handlers.onError?.(e);
        if (!opened) reject(new Error('signaling connection failed'));
      });
      ws.addEventListener('close', (e) => {
        if (!opened) {
          reject(new Error(`signaling closed before open (code ${e.code})`));
          return;
        }
        if (this.closed) return; // our own close() — stay quiet
        this.handlers.onClose?.(e.code, e.reason);
      });
    });
  }

  private handleMessage(e: MessageEvent): void {
    if (this.closed) return;
    if (typeof e.data !== 'string') return; // signaling is JSON text only
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return; // not JSON -> ignore
    }
    const result = serverMessageSchema.safeParse(parsed);
    if (!result.success) {
      if (import.meta.env.DEV) console.warn('[signaling] dropped invalid frame', result.error.issues);
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case 'welcome':
        this.handlers.onWelcome?.(msg.selfId, msg.room, msg.peers);
        break;
      case 'peer-joined':
        this.handlers.onPeerJoined?.(msg.peerId);
        break;
      case 'peer-left':
        this.handlers.onPeerLeft?.(msg.peerId);
        break;
      case 'signal':
        this.handlers.onSignal?.(msg.from, msg.data);
        break;
      case 'room-closed':
        this.handlers.onRoomClosed?.(msg.reason);
        break;
    }
  }

  /** Send an addressed signaling message; the server stamps `from` (no source spoofing). */
  send(to: string, data: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (import.meta.env.DEV) console.warn('[signaling] send while socket not open — dropped');
      return;
    }
    this.ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  /** Words method, creator only: ask the server to invalidate our word room (free the word,
   *  evict the joiner). The server honors it only from the socket that created the room. */
  destroyRoom(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'destroy' }));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
