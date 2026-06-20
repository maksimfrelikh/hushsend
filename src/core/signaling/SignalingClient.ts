import { serverMessageSchema, type PeerInfo } from '../../types/protocol';
import { NO_TURN, type TurnCredentials } from '../iceServers';

export interface SignalingHandlers {
  /** `peers` is the existing-room roster (mesh lobby): {id, device, joinedAt} each. */
  onWelcome?: (selfId: string, room: string, peers: PeerInfo[]) => void;
  /** a newcomer arrived — carries its coarse device + server-stamped joinedAt for the roster. */
  onPeerJoined?: (peer: PeerInfo) => void;
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
 * default (omitted) = the 4-digit code used by the ROOM method; `'word'` = a single
 * EFF-short-#2 rendezvous word, used by the "words" method; `'token'` = a high-entropy
 * 128-bit base64url token, used by the link/qr methods (unguessable, strictly 1:1).
 */
export type ConnectOptions =
  | { create: true; codeType?: 'word' | 'token' }
  | { join: string; codeType?: 'word' | 'token' };

const APP_ID = 'filetransfer';

/**
 * A COARSE, cosmetic device label sent to the server on connect (relayed to room peers for the
 * lobby roster). Deliberately NOT the full user-agent: this travels to the UNTRUSTED server and to
 * peers, so it is kept to a coarse Mobile/Desktop hint. It authenticates nothing — the SAS does.
 */
function coarseDeviceLabel(): string {
  try {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ? 'Mobile' : 'Desktop';
  } catch {
    return 'Desktop'; // no navigator (non-browser) — a harmless default
  }
}

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
  /** In-flight `turn-request` (step 6d, Reliable mode): resolved by the `turn-credentials` reply, a
   *  timeout, or close — whichever first. One at a time (the core requests once per pairing). */
  private turnPending: { resolve: (c: TurnCredentials) => void; timer: ReturnType<typeof setTimeout> } | null = null;

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
    params.set('device', coarseDeviceLabel()); // cosmetic lobby-roster hint (server caps the length)

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
        this.handlers.onPeerJoined?.({ id: msg.peerId, device: msg.device, joinedAt: msg.joinedAt });
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
      case 'turn-credentials':
        // Reply to our `turn-request` (Reliable mode). Validated (untrusted relay) by the schema
        // above; hand the creds to whoever is awaiting them. `urls` may be empty (relay unavailable).
        this.settleTurn({ urls: msg.urls, username: msg.username, credential: msg.credential });
        break;
    }
  }

  /**
   * Request short-lived TURN (coturn) credentials from the server for Reliable mode — send
   * `{type:'turn-request'}` and resolve with the `turn-credentials` reply. The shared TURN secret
   * never leaves the server; only the derived per-session credential comes back. Resolves to NO_TURN
   * (empty urls → direct-only) if the socket is closed, the server doesn't answer within `timeoutMs`,
   * or the request is superseded — so the caller never hangs and treats "no relay" as the safe default.
   * Max-privacy mode never calls this (it stays direct-only and never contacts the relay).
   */
  requestTurnCredentials(timeoutMs = 5000): Promise<TurnCredentials> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(NO_TURN);
    this.settleTurn(NO_TURN); // supersede any prior in-flight request (shouldn't happen — one per pairing)
    return new Promise<TurnCredentials>((resolve) => {
      const timer = setTimeout(() => this.settleTurn(NO_TURN), timeoutMs);
      this.turnPending = { resolve, timer };
      this.ws!.send(JSON.stringify({ type: 'turn-request' }));
    });
  }

  /** Resolve the in-flight `turn-request` (reply / timeout / close), clearing its timer. No-op if none. */
  private settleTurn(creds: TurnCredentials): void {
    const pending = this.turnPending;
    if (!pending) return;
    this.turnPending = null;
    clearTimeout(pending.timer);
    pending.resolve(creds);
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
    this.settleTurn(NO_TURN); // don't leave a turn-request awaiter hanging when we tear down
    this.ws?.close();
    this.ws = null;
  }
}
