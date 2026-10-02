import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * The codeless reconnect's WAIT logic, driven deterministically at the SessionController level with a
 * fake signaling client and fake timers:
 *   - `reconnectTo` takes the token room DERIVED from the pin for the current time bucket
 *     (join-or-create — `{ join: token, codeType: 'token' }`, never `create`), and projects nothing
 *     about the token to the store;
 *   - at the bucket boundary a side still waiting alone leaves the old room and takes the new token;
 *   - well before the server's TTL it re-takes the same token (a fresh room);
 *   - a room that expires under it (room-closed) is taken again, and unexpected server closes are
 *     answered the same way — up to a cap;
 *   - once a peer is engaged, none of that fires (the rendezvous has done its job);
 *   - the overall wait cap ends in `failed` with the stable "did not show up" reason.
 * The crypto (hello/proof/ok) is covered in crypto/reconnect.test.ts; the real two-browser flow in
 * tests/e2e/reconnect.spec.ts.
 */

const hoisted = vi.hoisted(() => {
  interface Handlers {
    onWelcome?: (selfId: string, room: string, peers: unknown[]) => void;
    onRoomClosed?: (reason: string) => void;
    onClose?: (code: number, reason: string) => void;
  }
  const instances: FakeSignaling[] = [];
  /** how many of the NEXT connect() calls reject (the network is down under the wait). */
  const failing = { next: 0 };
  class FakeSignaling {
    readonly connects: unknown[] = [];
    closed = false;
    constructor(
      readonly url: string,
      readonly handlers: Handlers,
    ) {
      instances.push(this);
    }
    async connect(opts: unknown): Promise<void> {
      this.connects.push(opts);
      if (failing.next > 0) {
        failing.next--;
        throw new Error('signaling connection failed');
      }
    }
    send(): void {}
    destroyRoom(): void {}
    async requestTurnCredentials(): Promise<{ urls: string[]; username: string; credential: string }> {
      return { urls: [], username: '', credential: '' };
    }
    close(): void {
      this.closed = true;
    }
  }
  return { instances, FakeSignaling, failing };
});

vi.mock('./signaling/SignalingClient', () => ({ SignalingClient: hoisted.FakeSignaling }));

import { SessionController } from './SessionController';
import { Keystore, MemoryKeystoreBackend } from './keystore';
import { RECONNECT_BUCKET_MS, reconnectBucket, reconnectRendezvous } from './crypto/reconnect';
import { hexToBytes } from '@noble/curves/utils.js';

interface SCInternals {
  keystore: Keystore;
  signaling: unknown;
  peerId: string | null;
  reconnect: { settled: boolean; rejoins: number } | null;
}

const PAIRING_ID_HEX = '0102030405060708090a0b0c0d0e0f10';
const PEER_KEY_HEX = 'ab'.repeat(32);
const REFRESH_MS = 2 * 60_000;
const WAIT_MS = 10 * 60_000;

function tokenFor(nowMs: number): string {
  return reconnectRendezvous(hexToBytes(PAIRING_ID_HEX), reconnectBucket(nowMs));
}

async function newReconnecting(): Promise<{ sc: SessionController; internals: SCInternals; dispatch: ReturnType<typeof vi.fn> }> {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const internals = sc as unknown as SCInternals;
  const ks = new Keystore(new MemoryKeystoreBackend());
  await ks.putPin(PAIRING_ID_HEX, PEER_KEY_HEX);
  (internals as unknown as { keystore: Keystore }).keystore = ks;
  await sc.reconnectTo(PAIRING_ID_HEX);
  return { sc, internals, dispatch };
}

const failedReasons = (dispatch: ReturnType<typeof vi.fn>): string[] =>
  dispatch.mock.calls
    .map((c) => c[0] as { type?: string; payload?: { reason?: string } })
    .filter((a) => a.type === 'connection/failed')
    .map((a) => a.payload?.reason ?? '');

describe('SessionController — codeless reconnect rendezvous (derive, refresh, roll over, give up)', () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
    vi.useFakeTimers();
    // 1 s into a bucket, so the first boundary is ~10 min away and the 2-min refresh fires first.
    vi.setSystemTime(new Date(1_800_000_000_000 - (1_800_000_000_000 % RECONNECT_BUCKET_MS) + 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the token derived from the pin for the current bucket, join-or-create, and never a create', async () => {
    const { dispatch } = await newReconnecting();
    expect(hoisted.instances).toHaveLength(1);
    expect(hoisted.instances[0].connects).toEqual([{ join: tokenFor(Date.now()), codeType: 'token' }]);
    // Nothing about the token reaches the store: the join projection carries an empty room.
    const join = dispatch.mock.calls.map((c) => c[0] as { type: string; payload?: { room?: string } }).find((a) => a.type === 'connection/joinStarted');
    expect(join?.payload?.room).toBe('');
  });

  it('re-takes the SAME token (a fresh room) before the server TTL while still alone', async () => {
    const { internals } = await newReconnecting();
    const first = hoisted.instances[0];
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(first.closed).toBe(true);
    expect(hoisted.instances).toHaveLength(2);
    expect(hoisted.instances[1].connects).toEqual([{ join: tokenFor(Date.now()), codeType: 'token' }]);
    expect(hoisted.instances[1].connects).toEqual(first.connects); // same bucket → same token
    expect(internals.reconnect?.rejoins).toBe(0); // a scheduled refresh is not a "server closed us"
  });

  it('moves to the NEXT bucket\'s token at the boundary — the two clocks converge within their skew', async () => {
    await newReconnecting();
    const before = tokenFor(Date.now());
    const untilBoundary = RECONNECT_BUCKET_MS - (Date.now() % RECONNECT_BUCKET_MS);
    await vi.advanceTimersByTimeAsync(untilBoundary + 5);
    const latest = hoisted.instances[hoisted.instances.length - 1];
    const after = tokenFor(Date.now());
    expect(after).not.toBe(before);
    expect(latest.connects).toEqual([{ join: after, codeType: 'token' }]);
  });

  it('a room that expires under it (room-closed) is simply taken again', async () => {
    await newReconnecting();
    hoisted.instances[0].handlers.onRoomClosed?.('expired');
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.instances[0].closed).toBe(true);
    expect(hoisted.instances).toHaveLength(2);
    expect(hoisted.instances[1].connects).toEqual(hoisted.instances[0].connects);
  });

  it('an unexpected server close while alone is answered with a re-join, but not forever', async () => {
    const { dispatch, internals } = await newReconnecting();
    for (let i = 0; i < 8; i++) {
      hoisted.instances[hoisted.instances.length - 1].handlers.onClose?.(4010, 'expired');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(hoisted.instances).toHaveLength(9); // 1 + 8 re-joins
    expect(failedReasons(dispatch)).toEqual([]);
    hoisted.instances[hoisted.instances.length - 1].handlers.onClose?.(4010, 'expired');
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.instances).toHaveLength(9); // the 9th is refused
    expect(failedReasons(dispatch)[0]).toMatch(/keeps closing the rendezvous/);
    expect(internals.reconnect?.settled).toBe(true);
  });

  it('the network going away under the wait (1006, then the new socket cannot open) is retried, not fatal', async () => {
    // TESTPLAN E7, 2026-10-02: the phone switched Wi-Fi while waiting; its socket died with a 1006,
    // the immediate re-take could not open a socket on a network that was still coming up, and the wait
    // ended at once with "signaling connection failed". Now: retry after RECONNECT_RETRY_MS, counted
    // against the same cap.
    const { dispatch, internals } = await newReconnecting();
    hoisted.failing.next = 2; // the next two sockets fail to open
    hoisted.instances[0].handlers.onClose?.(1006, '');
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.instances).toHaveLength(2); // re-join attempted at once…
    expect(failedReasons(dispatch)).toEqual([]); // …its failure to open is NOT the end of the wait
    await vi.advanceTimersByTimeAsync(3_000 + 5);
    expect(hoisted.instances).toHaveLength(3); // second try, 3 s later — fails too
    expect(failedReasons(dispatch)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000 + 5);
    expect(hoisted.instances).toHaveLength(4); // third try opens (failing.next exhausted)
    expect(hoisted.instances[3].connects).toEqual(hoisted.instances[0].connects); // same token room
    expect(failedReasons(dispatch)).toEqual([]);
    expect(internals.reconnect?.settled).toBe(false);
  });

  it('a socket that never opens again gives up at the re-join cap with a readable reason', async () => {
    const { dispatch, internals } = await newReconnecting();
    hoisted.failing.next = 100;
    hoisted.instances[0].handlers.onClose?.(1006, '');
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(3_000 + 5);
    expect(internals.reconnect?.settled).toBe(true);
    expect(failedReasons(dispatch)[0]).toMatch(/signaling connection failed|could not be reached/);
    hoisted.failing.next = 0;
  });

  it('a browser `online` event while waiting re-takes the rendezvous at once and does not count against the cap', async () => {
    // Node has no `window`; the controller installs its listener only when one exists, so give it a
    // bare EventTarget for this test.
    const fakeWindow = new EventTarget();
    (globalThis as unknown as { window: unknown }).window = fakeWindow;
    try {
      const { dispatch, internals } = await newReconnecting();
      const before = hoisted.instances.length;
      fakeWindow.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(hoisted.instances).toHaveLength(before + 1);
      expect(hoisted.instances[before - 1].closed).toBe(true);
      expect(internals.reconnect?.rejoins).toBe(0);
      expect(failedReasons(dispatch)).toEqual([]);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it('once a peer is engaged, neither the refresh nor a room-closed moves us off the room', async () => {
    const { internals } = await newReconnecting();
    internals.peerId = 'brave-otter'; // beginPairing would set this (and clear the wait timers)
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 5);
    hoisted.instances[0].handlers.onRoomClosed?.('expired');
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.instances).toHaveLength(1);
    expect(hoisted.instances[0].closed).toBe(false);
  });

  it('gives up with the stable "did not show up" reason at the wait cap', async () => {
    const { dispatch } = await newReconnecting();
    await vi.advanceTimersByTimeAsync(WAIT_MS + 5);
    expect(failedReasons(dispatch)).toHaveLength(1);
    expect(failedReasons(dispatch)[0]).toMatch(/did not show up/);
    expect(hoisted.instances[hoisted.instances.length - 1].closed).toBe(true);
    // And nothing fires afterwards — the session is settled.
    const n = hoisted.instances.length;
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(hoisted.instances).toHaveLength(n);
  });

  it('refuses to reconnect to a device it holds no pin for', async () => {
    const dispatch = vi.fn();
    const sc = new SessionController(dispatch as unknown as AppDispatch);
    (sc as unknown as { keystore: Keystore }).keystore = new Keystore(new MemoryKeystoreBackend());
    await sc.reconnectTo(PAIRING_ID_HEX);
    expect(failedReasons(dispatch)[0]).toMatch(/no stored pin/);
    expect(hoisted.instances).toHaveLength(0);
  });
});
