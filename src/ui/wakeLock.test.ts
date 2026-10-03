import { describe, it, expect, vi } from 'vitest';
import { createTransferWakeLock, transferInFlight, type WakeLockEnv, type WakeLockSentinelLike } from './wakeLock';

function fakeEnv(opts: { api?: boolean; visible?: boolean; reject?: boolean } = {}) {
  let visible = opts.visible ?? true;
  const listeners = new Set<() => void>();
  const sentinels: Array<WakeLockSentinelLike & { released: boolean; fire: () => void }> = [];
  const request = vi.fn(async () => {
    if (opts.reject) throw new DOMException('denied', 'NotAllowedError');
    let onRelease: (() => void) | null = null;
    const s = {
      released: false,
      release: vi.fn(async () => {
        s.released = true;
      }),
      addEventListener: (_t: 'release', l: () => void) => {
        onRelease = l;
      },
      fire: () => {
        s.released = true;
        onRelease?.();
      },
    };
    sentinels.push(s);
    return s;
  });
  const env: WakeLockEnv = {
    request: opts.api === false ? null : request,
    isVisible: () => visible,
    onVisibility: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    env,
    request,
    sentinels,
    setVisible(v: boolean) {
      visible = v;
      for (const l of listeners) l();
    },
    listeners,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('transferInFlight', () => {
  it('is the offer and the bytes, nothing else', () => {
    expect(transferInFlight('offered')).toBe(true);
    expect(transferInFlight('transferring')).toBe(true);
    for (const p of ['idle', 'done', 'rejected', 'cancelled', 'error'] as const) expect(transferInFlight(p)).toBe(false);
  });
});

describe('createTransferWakeLock', () => {
  it('requests the lock once when wanted and visible, releases it when no longer wanted', async () => {
    const f = fakeEnv();
    const lock = createTransferWakeLock(f.env);
    lock.set(true);
    lock.set(true);
    await tick();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(true);
    lock.set(false);
    await tick();
    expect(f.sentinels[0].released).toBe(true);
    expect(lock.held).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it('does nothing, and does not throw, where the API is absent', async () => {
    const f = fakeEnv({ api: false });
    const lock = createTransferWakeLock(f.env);
    lock.set(true);
    await tick();
    expect(lock.held).toBe(false);
    lock.set(false);
  });

  it('a refused request is swallowed and logged', async () => {
    const log = vi.fn();
    const f = fakeEnv({ reject: true });
    const lock = createTransferWakeLock({ ...f.env, log });
    lock.set(true);
    await tick();
    expect(lock.held).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/refused: NotAllowedError/));
  });

  it('waits for the page to be visible and re-acquires after the browser released it on hide', async () => {
    const f = fakeEnv({ visible: false });
    const lock = createTransferWakeLock(f.env);
    lock.set(true);
    await tick();
    expect(f.request).not.toHaveBeenCalled();
    f.setVisible(true);
    await tick();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(true);
    // The browser releases the sentinel when the page hides …
    f.setVisible(false);
    f.sentinels[0].fire();
    expect(lock.held).toBe(false);
    // … and the lock is requested again when the page is back, as long as it is still wanted.
    f.setVisible(true);
    await tick();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
  });

  it('a lock that resolves after it stopped being wanted is given straight back', async () => {
    const f = fakeEnv();
    let resolve!: (s: WakeLockSentinelLike) => void;
    const slow: WakeLockEnv = {
      ...f.env,
      request: () => new Promise<WakeLockSentinelLike>((r) => (resolve = r)),
    };
    const lock = createTransferWakeLock(slow);
    lock.set(true);
    lock.set(false);
    const release = vi.fn(async () => undefined);
    resolve({ release });
    await tick();
    expect(release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });
});
