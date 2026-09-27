import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppDispatch } from '../store';
import { connectionActions } from '../store/connectionSlice';
import { transferActions } from '../store/transferSlice';

/**
 * An AUTHENTICATED channel dying (TESTPLAN F2 / F3, BACKLOG § UX bugs "Peer gone after `connected`").
 *
 * Until 2026-09-27 nothing after `established` reacted to a DataChannel close, an ICE failure or a
 * `disconnected` connection: both screens went on saying "Secure channel open" / "Sending 46 %" to a
 * peer that was gone. Now every one of those signals reaches `onConnectionLost`, which fails the
 * in-flight transfer, drops the PeerConnection and goes `connected → failed` with the stable
 * `connection lost: <signal>` (CONNECTION_LOST_PREFIX) — and an ICE `disconnected` is surfaced as
 * `interrupted`, with a backstop.
 *
 * Driven at the SessionController level with a mock PeerConnection (the real one needs
 * RTCPeerConnection, absent under Node) and the controller's private hooks reached through a cast.
 * `openReceive` is replaced so a test can hold the save picker "open"; the rest of fileTransfer is the
 * real module — the send pump in these tests is the production one.
 */

const hoisted = vi.hoisted(() => {
  class MockPeerConnection {
    constructor(_handlers: unknown, _config: unknown) {}
  }
  return { MockPeerConnection, openReceive: vi.fn() };
});
vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));
vi.mock('./transfer/fileTransfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transfer/fileTransfer')>()),
  openReceive: hoisted.openReceive,
}));

// Imported AFTER vi.mock (vitest hoists the mocks above imports) so SessionController binds them.
import { SessionController } from './SessionController';

interface MockPeer {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  maxMessageSize(): number;
}
interface SCInternals {
  method: 'room' | 'words' | 'link' | 'qr' | 'reconnect' | null;
  peer: MockPeer | null;
  peerId: string | null;
  established: boolean;
  channelOpen: boolean;
  privacyMode: 'max' | 'reliable';
  signaling: unknown;
  pendingOffer: {
    name: string;
    size: number;
    isZip: boolean;
    canStream: boolean;
    maxBytes: number;
  } | null;
  onChannelClose(why?: string): void;
  onIceFailed(): void;
  onPeerInterrupted(interrupted: boolean): void;
  onPeerMessage(data: string | ArrayBuffer): void;
}
type Action = { type: string; payload?: unknown };

/** A controller sitting on an authenticated `connected` link pair, its signaling already closed. */
function connectedPair(): {
  sc: SessionController;
  internals: SCInternals;
  dispatch: ReturnType<typeof vi.fn>;
  peer: MockPeer;
} {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const internals = sc as unknown as SCInternals;
  const peer: MockPeer = {
    send: vi.fn(async () => {}),
    close: vi.fn(),
    maxMessageSize: () => 16 * 1024,
  };
  internals.method = 'link';
  internals.peerId = 'peer-a';
  internals.peer = peer;
  internals.established = true;
  internals.channelOpen = true;
  internals.signaling = null; // closed the instant we connected, as in production
  return { sc, internals, dispatch, peer };
}

const actions = (dispatch: ReturnType<typeof vi.fn>): Action[] =>
  dispatch.mock.calls.map(([a]) => a as Action);
const failures = (dispatch: ReturnType<typeof vi.fn>): Action[] =>
  actions(dispatch).filter((a) => a.type === connectionActions.failed.type);
const lostFailures = (dispatch: ReturnType<typeof vi.fn>): Action[] =>
  failures(dispatch).filter((a) =>
    /connection lost/.test((a.payload as { reason: string }).reason),
  );

/** Transfer / connection actions dispatched from call `from` on. The constructor's once-per-session
 *  STUN cross-check lands `dev/*` actions at arbitrary moments, which say nothing about the session. */
const sessionActionsSince = (dispatch: ReturnType<typeof vi.fn>, from: number): string[] =>
  actions(dispatch)
    .slice(from)
    .map((a) => a.type)
    .filter((t) => t.startsWith('transfer/') || t.startsWith('connection/'));

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('SessionController — an authenticated channel dying', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a DataChannel close after connect ends the session as lost instead of staying "connected"', () => {
    const { internals, dispatch, peer } = connectedPair();
    internals.onChannelClose('data channel closed');

    expect(lostFailures(dispatch)).toHaveLength(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(internals.peer).toBeNull();
  });

  it('a Max-privacy ICE failure after connect is a loss — not "couldn\'t connect directly"', () => {
    const { internals, dispatch } = connectedPair();
    internals.privacyMode = 'max';
    internals.onIceFailed();

    expect(failures(dispatch)).toHaveLength(1);
    expect(lostFailures(dispatch)).toHaveLength(1);
  });

  it('one loss, one outcome: every later signal for it is ignored', () => {
    const { internals, dispatch, peer } = connectedPair();
    internals.onChannelClose('data channel closed');
    internals.onIceFailed();
    internals.onChannelClose('peer connection closed');
    internals.onPeerInterrupted(true);

    expect(failures(dispatch)).toHaveLength(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('BEFORE authentication a close still takes the pairing path, never "connection lost"', () => {
    const { sc, internals, dispatch } = connectedPair();
    internals.established = false;
    const failLink = vi
      .spyOn(sc as unknown as { failLink: (reason: string) => void }, 'failLink')
      .mockImplementation(() => {});
    internals.onChannelClose('data channel closed');

    expect(failLink).toHaveBeenCalledWith('channel closed during pairing');
    expect(lostFailures(dispatch)).toHaveLength(0);
  });

  it('a send stuck mid-flight is failed with the reason BEFORE the session ends — the F3 freeze', async () => {
    const { sc, internals, dispatch, peer } = connectedPair();
    // offer-file + two chunks go out; the third chunk's send never returns (a buffer that never drains).
    let sends = 0;
    peer.send.mockImplementation(() => (++sends > 3 ? new Promise(() => {}) : Promise.resolve()));
    sc.sendFiles([new File([new Uint8Array(256 * 1024)], 'big.bin')]);
    internals.onPeerMessage(JSON.stringify({ t: 'accept' }));
    for (let i = 0; i < 200 && sends < 4; i++) await tick();
    expect(sends).toBe(4);

    internals.onChannelClose('data channel closed');

    const types = actions(dispatch).map((a) => a.type);
    const transferFailed = types.lastIndexOf(transferActions.failed.type);
    const sessionFailed = types.lastIndexOf(connectionActions.failed.type);
    expect(transferFailed).toBeGreaterThan(-1);
    expect(transferFailed).toBeLessThan(sessionFailed); // the row says what happened to the file first
    expect(dispatch).toHaveBeenCalledWith(transferActions.failed({ reason: 'connection lost' }));
    expect(lostFailures(dispatch)).toHaveLength(1);
  });

  it('an offer still waiting for Accept is marked lost, and cannot be accepted afterwards', async () => {
    const { sc, internals, dispatch } = connectedPair();
    internals.pendingOffer = {
      name: 'a.bin',
      size: 10,
      isZip: false,
      canStream: false,
      maxBytes: 1 << 20,
    };
    internals.onChannelClose('data channel closed');

    expect(dispatch).toHaveBeenCalledWith(transferActions.failed({ reason: 'connection lost' }));
    expect(internals.pendingOffer).toBeNull();
    await sc.acceptIncoming();
    expect(hoisted.openReceive).not.toHaveBeenCalled();
  });

  it('a save picker still open when the session ends: what it returns is discarded, the row keeps its reason', async () => {
    const { sc, internals, dispatch } = connectedPair();
    internals.pendingOffer = {
      name: 'a.bin',
      size: 10,
      isZip: false,
      canStream: true,
      maxBytes: Infinity,
    };
    let pick!: (r: unknown) => void;
    hoisted.openReceive.mockReturnValue(new Promise((resolve) => (pick = resolve)));
    const accepting = sc.acceptIncoming(); // the picker is up now

    internals.onChannelClose('data channel closed'); // ...and the connection dies under it
    const afterLoss = dispatch.mock.calls.length;
    const receive = {
      start: vi.fn(async () => {}),
      discard: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };
    pick(receive); // the human finally taps Save
    await accepting;

    expect(receive.discard).toHaveBeenCalledTimes(1);
    expect(receive.start).not.toHaveBeenCalled(); // no `accept` to a peer that is gone
    expect(sessionActionsSince(dispatch, afterLoss)).toEqual([]); // no "accepted" / "cancelled" over "connection lost"
  });

  it('a picker dismissed after the session ended adds nothing — no "cancelled", no reject sent', async () => {
    const { sc, internals, dispatch, peer } = connectedPair();
    internals.pendingOffer = {
      name: 'a.bin',
      size: 10,
      isZip: false,
      canStream: true,
      maxBytes: Infinity,
    };
    let dismiss!: (e: unknown) => void;
    hoisted.openReceive.mockReturnValue(new Promise((_, reject) => (dismiss = reject)));
    const accepting = sc.acceptIncoming();

    internals.onChannelClose('data channel closed');
    const afterLoss = dispatch.mock.calls.length;
    dismiss(new DOMException('The user aborted a request.', 'AbortError'));
    await accepting;

    expect(sessionActionsSince(dispatch, afterLoss)).toEqual([]);
    expect(peer.send).not.toHaveBeenCalled();
  });

  it('a finished transfer is left exactly as it was — the lost screen can still say "delivered"', () => {
    const { internals, dispatch } = connectedPair();
    internals.onChannelClose('data channel closed');
    const transferTypes = actions(dispatch)
      .map((a) => a.type)
      .filter((t) => t.startsWith('transfer/'));
    expect(transferTypes).toEqual([]);
  });

  it('ICE `disconnected` is surfaced as interrupted, cleared when it comes back, and ends nothing', () => {
    vi.useFakeTimers();
    const { internals, dispatch } = connectedPair();
    internals.onPeerInterrupted(true);
    expect(dispatch).toHaveBeenCalledWith(connectionActions.interrupted(true));

    vi.advanceTimersByTime(29_000);
    internals.onPeerInterrupted(false);
    expect(dispatch).toHaveBeenCalledWith(connectionActions.interrupted(false));
    vi.advanceTimersByTime(60_000);
    expect(failures(dispatch)).toHaveLength(0);
  });

  it('interrupted for the whole grace period: the backstop ends it as lost', () => {
    vi.useFakeTimers();
    const { internals, dispatch, peer } = connectedPair();
    internals.onPeerInterrupted(true);
    vi.advanceTimersByTime(29_999);
    expect(failures(dispatch)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(lostFailures(dispatch)).toHaveLength(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('BEFORE authentication an interruption is not surfaced — the pairing deadlines own that stall', () => {
    vi.useFakeTimers();
    const { internals, dispatch } = connectedPair();
    internals.established = false;
    internals.onPeerInterrupted(true);
    vi.advanceTimersByTime(60_000);
    expect(dispatch).not.toHaveBeenCalledWith(connectionActions.interrupted(true));
    expect(lostFailures(dispatch)).toHaveLength(0);
  });

  it('dispose() disarms the backstop', () => {
    vi.useFakeTimers();
    const { sc, internals, dispatch } = connectedPair();
    internals.onPeerInterrupted(true);
    sc.dispose();
    vi.advanceTimersByTime(60_000);
    expect(lostFailures(dispatch)).toHaveLength(0);
  });
});
