import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * The 1:1 methods (link / QR / words) and a pairing that stalls BEFORE the DataChannel opens
 * (docs/test-runs/2026-10-11.md). Measured on the live build: a joiner whose browser has WebRTC
 * switched off threw inside startPeer — an unhandled rejection, nothing on screen — and both sides sat
 * on "Agreeing on keys…" for ~165 s until the SERVER expired the room. Two fixes, both pinned here:
 *  - the 120 s client deadline arms at pairing start, not only once the channel is open, so a peer
 *    that never answers no longer leaves us waiting on the untrusted server;
 *  - a failed PeerConnection bring-up fails the pairing visibly, through the method's own teardown.
 */

const hoisted = vi.hoisted(() => {
  const config = { throwOnStart: null as Error | null };
  class StalledPeerConnection {
    constructor(_handlers: unknown, _config: unknown) {}
    start(): void {
      if (config.throwOnStart) throw config.throwOnStart;
      // otherwise: an offer goes out and nothing ever answers — the channel never opens
    }
    close(): void {}
    remoteFingerprint(): string | null {
      return null;
    }
  }
  return { config, StalledPeerConnection };
});

vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.StalledPeerConnection }));

import { SessionController } from './SessionController';
import { WEBRTC_UNAVAILABLE_REASON } from './webrtc/available';

type Method = 'link' | 'qr' | 'words';
interface SCInternals {
  method: Method;
  selfId: string | null;
  isCreator: boolean;
  rendezvous: string | null;
  signaling: unknown;
  beginPairing(peerId: string): void;
}
type Action = { type: string; payload?: { reason?: string } };

const DEADLINE_MS = 120_000;
const STALLED = 'the connection did not come up in time';

function pairing(method: Method, { initiator, isCreator }: { initiator: boolean; isCreator: boolean }) {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const internals = sc as unknown as SCInternals;
  internals.method = method;
  internals.isCreator = isCreator;
  internals.rendezvous = 'bathrobe';
  // pairingRoleFor: the lexicographically smaller id is the initiator.
  internals.selfId = initiator ? 'aaaa' : 'zzzz';
  const signaling = { send: vi.fn(), close: vi.fn(), destroyRoom: vi.fn(), requestTurnCredentials: vi.fn() };
  internals.signaling = signaling;
  const actions = (): Action[] => (dispatch.mock.calls as Array<[Action]>).map(([a]) => a);
  const failures = (): string[] =>
    actions()
      .filter((a) => a.type === 'connection/failed')
      .map((a) => a.payload?.reason ?? '');
  return { internals, signaling, actions, failures };
}

describe('a 1:1 pairing that stalls before the DataChannel opens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.config.throwOnStart = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('link: fails at the client deadline, without the server expiring anything', async () => {
    const p = pairing('link', { initiator: true, isCreator: true });
    p.internals.beginPairing('zzzz');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(p.failures()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.failures()).toEqual([STALLED]);
    expect(p.signaling.close).toHaveBeenCalled();
  });

  it('qr: the same deadline', async () => {
    const p = pairing('qr', { initiator: false, isCreator: false });
    p.internals.beginPairing('aaaa');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(p.failures()).toEqual([STALLED]);
  });

  it('words joiner: the deadline ends its single attempt', async () => {
    const p = pairing('words', { initiator: false, isCreator: false });
    p.internals.beginPairing('aaaa');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(p.failures()).toEqual([STALLED]);
  });

  it('words creator: the deadline counts an attempt and the room keeps waiting', async () => {
    const p = pairing('words', { initiator: false, isCreator: true });
    p.internals.beginPairing('aaaa');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(p.failures()).toEqual([]);
    expect(p.actions().map((a) => a.type)).toContain('connection/roomReady');
  });
});

describe('a PeerConnection that cannot be brought up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    hoisted.config.throwOnStart = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('without WebRTC in the browser: fails at once, naming it — no unhandled rejection, no wait', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    hoisted.config.throwOnStart = new ReferenceError('RTCPeerConnection is not defined');
    const p = pairing('link', { initiator: false, isCreator: false });
    p.internals.beginPairing('aaaa');
    await vi.advanceTimersByTimeAsync(0);
    expect(p.failures()).toEqual([WEBRTC_UNAVAILABLE_REASON]);
    expect(p.signaling.close).toHaveBeenCalled();
  });

  it('with WebRTC present but the bring-up throwing: fails at once with the error', async () => {
    vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {});
    hoisted.config.throwOnStart = new Error('boom');
    const p = pairing('link', { initiator: true, isCreator: true });
    p.internals.beginPairing('zzzz');
    await vi.advanceTimersByTimeAsync(0);
    expect(p.failures()).toEqual(['could not start the connection (boom)']);
  });
});
