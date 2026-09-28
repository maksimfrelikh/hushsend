import { useEffect, useState } from 'react';
import { useAppSelector } from '../../store/hooks';
import {
  advance,
  DEFAULT_TIMING,
  initialPace,
  isBusy,
  markPainted,
  nextWake,
  type Pace,
  type Timing,
} from './pacing';

export type PacedScreen = { pace: Pace; busy: boolean };

const now = (): number => performance.now();

/**
 * DEV-only: `window.__HUSHSEND_SCREEN_HOLD_MS__` replaces the hold — a huge value keeps a held screen
 * up so the visual gate can photograph it (a 400 ms state is otherwise a race), 0 turns the hold off.
 * Dead code in the production bundle, which always uses the defaults.
 */
function timing(): Timing {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __HUSHSEND_SCREEN_HOLD_MS__?: unknown };
    const hold = w.__HUSHSEND_SCREEN_HOLD_MS__;
    if (typeof hold === 'number' && hold >= 0) return { ...DEFAULT_TIMING, holdMs: hold };
  }
  return DEFAULT_TIMING;
}

/**
 * The screen to show for the FSM status, paced (see pacing.ts): which screen, and whether it is
 * `busy` — held while the FSM has moved on, so nothing on it may act.
 */
export function usePacedScreen(): PacedScreen {
  const real = useAppSelector((s) => s.connection.status);
  const [pace, setPace] = useState(() => initialPace(real, now()));

  // Follow the FSM in the SAME render (React's "adjusting state while rendering"): a settled status
  // is never a frame late — above all `connected → failed`, where a stale frame would still show
  // the file UI.
  let current = pace;
  if (pace.real !== real) {
    current = advance(pace, real, now(), timing());
    setPace(current);
  }

  // Wake up when a hold, a title's minimum or a stage's settle runs out. Advancing to the wake time
  // itself (not a clock that may read a hair early) guarantees the step happens.
  useEffect(() => {
    const t = timing();
    const at = nextWake(current, t);
    if (at === null) return;
    const delay = Math.max(0, at - now());
    if (!(delay <= 2 ** 31 - 1)) return; // longer than a timer can wait: only the DEV knob asks that
    const id = window.setTimeout(
      () => setPace((p) => advance(p, p.real, Math.max(now(), at), t)),
      delay,
    );
    return () => window.clearTimeout(id);
  }, [current]);

  // The first frame: until it has been painted, a hold shows an empty column (pacing.ts § 3).
  useEffect(() => {
    if (current.painted) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPace(markPainted));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [current.painted]);

  return { pace: current, busy: isBusy(current) };
}
