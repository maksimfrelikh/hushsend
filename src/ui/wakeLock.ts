/**
 * Screen Wake Lock for the duration of a transfer — the ONE thing it does is keep the display from
 * dimming and locking by the idle timer while bytes are in flight.
 *
 * Why: iOS Safari tears the WebRTC connection down the moment the screen locks (TESTPLAN F1 on the
 * iPhone 15, 2026-10-03: an 800 MB receive died at 14 %, both sides read "Connection lost" within
 * 17 s). A phone left on the table while a file arrives locks by its own timeout — the most common
 * way to lose a transfer on an iPhone, and the only one the app can prevent. A deliberate press of
 * the lock button, switching apps or closing the tab are untouched (the browser releases the lock
 * as soon as the page is hidden, and refuses it to a hidden page), which is why the transfer screen
 * also SAYS to keep the screen on and the page in front (`keepScreenOn`).
 *
 * The lock is wanted while `transferInFlight(phase)` and held only while the page is visible; when
 * the page comes back into view with the transfer still running it is requested again (the browser
 * released it on hide). A missing API or a refused request is not an error — nothing else changes.
 * Pure w.r.t. the browser: the environment is injected (`browserWakeLockEnv` for the app, a fake in
 * `wakeLock.test.ts`), because the live `WakeLockSentinel` is a non-serializable object that must
 * never reach the store.
 */
import type { TransferPhase } from '../store/transferSlice';

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockEnv {
  /** `navigator.wakeLock.request('screen')`, or null where the API does not exist. */
  request: (() => Promise<WakeLockSentinelLike>) | null;
  isVisible: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility: (listener: () => void) => () => void;
  log?: (message: string) => void;
}

export interface TransferWakeLock {
  /** Want the lock (true) or not (false). Idempotent. */
  set(active: boolean): void;
  /** A sentinel is currently held. */
  readonly held: boolean;
  dispose(): void;
}

/** The phases during which the screen must stay on: an offer on the table, or bytes crossing. */
export function transferInFlight(phase: TransferPhase): boolean {
  return phase === 'offered' || phase === 'transferring';
}

export function createTransferWakeLock(env: WakeLockEnv): TransferWakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;
  let unsubscribe: (() => void) | null = null;

  const acquire = async (): Promise<void> => {
    if (!env.request || sentinel || pending || !wanted || !env.isVisible()) return;
    pending = true;
    try {
      const s = await env.request();
      if (!wanted) {
        // Released while the request was in flight: give it straight back.
        await s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener?.('release', () => {
        if (sentinel === s) sentinel = null;
      });
      env.log?.('wake lock acquired');
    } catch (e) {
      env.log?.(`wake lock refused: ${e instanceof Error ? e.name : String(e)}`);
    } finally {
      pending = false;
    }
  };

  const release = async (): Promise<void> => {
    const s = sentinel;
    sentinel = null;
    if (s) {
      await s.release().catch(() => undefined);
      env.log?.('wake lock released');
    }
  };

  return {
    set(active: boolean): void {
      if (active === wanted) return;
      wanted = active;
      if (active) {
        unsubscribe = env.onVisibility(() => {
          if (wanted && env.isVisible()) void acquire();
        });
        void acquire();
      } else {
        unsubscribe?.();
        unsubscribe = null;
        void release();
      }
    },
    get held(): boolean {
      return sentinel !== null;
    },
    dispose(): void {
      this.set(false);
    },
  };
}

/** The real browser as a `WakeLockEnv`; `request` is null where the Screen Wake Lock API is absent. */
export function browserWakeLockEnv(): WakeLockEnv {
  const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : undefined;
  return {
    request: wl ? () => wl.request('screen') : null,
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibility: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    log: import.meta.env.DEV ? (m) => console.debug(`[hushsend] ${m}`) : undefined,
  };
}
