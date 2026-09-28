import type { ConnectionStatus } from '../../store/connectionSlice';

/**
 * Screen pacing — what the router SHOWS while the FSM runs through the four pre-connection states.
 *
 * `creating`, `joining`, `pairing` and `confirming` are usually over in a blink. Measured on the live
 * build (2026-09-28, two Chromes on one LAN, link method): the joiner went through all of them in
 * 60–215 ms, the creator in 30–45 ms, and `creating` took 37–155 ms. Routed straight to the Connecting
 * screen, that flashed it for a few frames and cut its title up to three times. Through a relay the
 * same run took 0.3–1.5 s, and there the screen is worth seeing. So:
 *
 *  1. HOLD. When the FSM leaves a screen for one of those states, that screen stays up for `holdMs`
 *     with every control quiet — `Screen` sets `inert`, app.css gives the controls the disabled look
 *     — so the tap visibly registered and nothing on it can act any more. If the FSM settles within
 *     the hold, the next screen replaces it directly and the Connecting screen never appears.
 *  2. The Connecting screen, once up, keeps each stage's title at least `titleMinMs`, and leaves only
 *     after its current title has had that long. A title changes to the stage the FSM is in NOW, and
 *     only once that stage has lasted `settleMs`: a stage that is over sooner never gets its title,
 *     it would be gone before anyone could read it.
 *  3. The app's first screen can be replaced before it was ever painted — a link opens straight into
 *     `joining`. Holding it would SHOW it, dimmed, for the length of the hold; that hold is an empty
 *     column instead.
 *
 * Only the DISPLAY lags. The FSM, the store and `data-testid="status"` are untouched, and what is
 * shown is always the current status or one the FSM has just left — never one it has not reached —
 * so the file UI still exists only while the status IS `connected`.
 */

/** The pre-connection states the Connecting screen stands for. */
export type Stage = 'creating' | 'joining' | 'pairing' | 'confirming';
/** Every other status has a screen of its own. */
export type Settled = Exclude<ConnectionStatus, Stage>;

export function isStage(s: ConnectionStatus): s is Stage {
  return s === 'creating' || s === 'joining' || s === 'pairing' || s === 'confirming';
}

export type Shown =
  /** A settled status's screen. `heldSince` = when the FSM moved on to a stage (the hold), else null. */
  | { kind: 'screen'; status: Settled; heldSince: number | null }
  /** A hold with nothing painted yet to hold (§ 3). */
  | { kind: 'blank'; heldSince: number }
  /** The Connecting screen with `stage`'s title, on screen since `titleSince`. */
  | { kind: 'connecting'; stage: Stage; titleSince: number };

export interface Pace {
  shown: Shown;
  /** The FSM status last observed, and when it last changed. */
  real: ConnectionStatus;
  realAt: number;
  /** False only until the app's first screen has been painted (§ 3). */
  painted: boolean;
}

export interface Timing {
  holdMs: number;
  titleMinMs: number;
  settleMs: number;
}

/** Long enough to cover a direct connection on one network, short enough that a relayed one still
 *  shows the Connecting screen within half a second. */
export const HOLD_MS = 400;
/** The least time the Connecting screen, and each of its titles, stays up. */
export const TITLE_MIN_MS = 500;
/** A stage shorter than this never gets its title. */
export const STAGE_SETTLE_MS = 150;

export const DEFAULT_TIMING: Timing = {
  holdMs: HOLD_MS,
  titleMinMs: TITLE_MIN_MS,
  settleMs: STAGE_SETTLE_MS,
};

export function initialPace(real: ConnectionStatus, now: number): Pace {
  const shown: Shown = isStage(real)
    ? { kind: 'blank', heldSince: now }
    : { kind: 'screen', status: real, heldSince: null };
  return { shown, real, realAt: now, painted: false };
}

/** The router saw its first frame painted. */
export function markPainted(p: Pace): Pace {
  return p.painted ? p : { ...p, painted: true };
}

/**
 * The pace at `now`, given the FSM status `real` (unchanged from last time on a timer wake-up).
 * Pure; returns `p` itself when nothing changes, so the caller can compare by identity.
 */
export function advance(
  p: Pace,
  real: ConnectionStatus,
  now: number,
  t: Timing = DEFAULT_TIMING,
): Pace {
  const q: Pace = real === p.real ? p : { ...p, real, realAt: now };
  const shown = q.shown;

  if (shown.kind !== 'connecting') {
    if (!isStage(q.real)) {
      // Settled while no Connecting screen is up: show it now, there is nothing to wait for.
      if (shown.kind === 'screen' && shown.status === q.real && shown.heldSince === null) return q;
      return { ...q, shown: { kind: 'screen', status: q.real, heldSince: null } };
    }
    if (shown.heldSince === null) {
      // The FSM just left this screen for a stage: hold it (or, before the first frame, nothing).
      const held: Shown = q.painted
        ? { ...shown, heldSince: now }
        : { kind: 'blank', heldSince: now };
      return advance({ ...q, shown: held }, real, now, t);
    }
    if (now - shown.heldSince >= t.holdMs) {
      return { ...q, shown: { kind: 'connecting', stage: q.real, titleSince: now } };
    }
    return q;
  }

  const titleAge = now - shown.titleSince;
  if (!isStage(q.real)) {
    // Settled: leave once the title on screen has had its time.
    return titleAge >= t.titleMinMs
      ? { ...q, shown: { kind: 'screen', status: q.real, heldSince: null } }
      : q;
  }
  if (q.real !== shown.stage && titleAge >= t.titleMinMs && now - q.realAt >= t.settleMs) {
    return { ...q, shown: { kind: 'connecting', stage: q.real, titleSince: now } };
  }
  return q;
}

/** When `advance` next has something to do on its own (no FSM change), or null. */
export function nextWake(p: Pace, t: Timing = DEFAULT_TIMING): number | null {
  const s = p.shown;
  if (s.kind !== 'connecting') return s.heldSince === null ? null : s.heldSince + t.holdMs;
  if (!isStage(p.real)) return s.titleSince + t.titleMinMs;
  if (p.real !== s.stage) return Math.max(s.titleSince + t.titleMinMs, p.realAt + t.settleMs);
  return null;
}

/** Whether what is shown is no longer where the FSM is, so nothing on it may act. */
export function isBusy(p: Pace): boolean {
  const s = p.shown;
  if (s.kind === 'screen') return s.heldSince !== null;
  if (s.kind === 'connecting') return !isStage(p.real);
  return true;
}
