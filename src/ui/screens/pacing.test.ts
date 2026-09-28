import { describe, it, expect } from 'vitest';
import type { ConnectionStatus } from '../../store/connectionSlice';
import {
  advance,
  DEFAULT_TIMING,
  initialPace,
  isBusy,
  isStage,
  markPainted,
  nextWake,
  HOLD_MS,
  TITLE_MIN_MS,
  STAGE_SETTLE_MS,
  type Pace,
  type Timing,
} from './pacing';

/**
 * Unit coverage for the screen pacing (pacing.ts). The timelines are the ones measured on the live
 * build: a direct connection runs through every pre-connection stage in tens of milliseconds, a
 * relayed one in about a second. Labels: `awaitingPeer` = that screen; a trailing `*` = held (busy:
 * its controls quiet); `~pairing` = the Connecting screen with that stage's title; `blank` = a hold
 * with nothing painted yet.
 */

const label = (p: Pace): string => {
  const s = p.shown;
  if (s.kind === 'blank') return 'blank';
  if (s.kind === 'connecting') return `~${s.stage}${isBusy(p) ? '*' : ''}`;
  return `${s.status}${s.heldSince !== null ? '*' : ''}`;
};

type Step = [at: number, status: ConnectionStatus];

/**
 * Replays FSM changes the way the router hook does: each change is observed when it happens, and in
 * between the pace wakes up whenever `nextWake` says. Returns `[time, label]` at every change of
 * label. `check` runs after every step.
 */
function replay(
  start: ConnectionStatus,
  steps: Step[],
  opts: { painted?: boolean; timing?: Timing; until?: number; check?: (p: Pace) => void } = {},
): Array<[number, string]> {
  const t = opts.timing ?? DEFAULT_TIMING;
  let p = initialPace(start, 0);
  if (opts.painted ?? true) p = markPainted(p);
  const out: Array<[number, string]> = [[0, label(p)]];
  const note = (at: number): void => {
    opts.check?.(p);
    const l = label(p);
    if (out[out.length - 1]![1] !== l) out.push([at, l]);
  };
  const queue = [...steps];
  const until = opts.until ?? (queue.at(-1)?.[0] ?? 0) + 10_000;
  for (;;) {
    const wake = nextWake(p, t);
    const next = queue[0];
    if (next && (wake === null || next[0] <= wake)) {
      queue.shift();
      p = advance(p, next[1], next[0], t);
      note(next[0]);
    } else if (wake !== null && wake <= until) {
      const before = p;
      p = advance(p, p.real, wake, t);
      // A wake-up that changes nothing would loop forever in the hook (setState to the same value).
      expect(p, `a wake at ${wake} made no progress (${label(before)})`).not.toBe(before);
      note(wake);
    } else break;
  }
  return out;
}

describe('screen pacing — the measured timelines', () => {
  it('a direct connection never shows the Connecting screen: the Share screen is held, then Transfer', () => {
    // creator on one LAN (live, 2026-09-28): pairing 27–40 ms, confirming 1–3 ms
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1035, 'confirming'],
        [1037, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1037, 'connected'],
    ]);
  });

  it('`creating` (37–155 ms) no longer flashes between the method picker and the Share screen', () => {
    expect(
      replay('idle', [
        [500, 'creating'],
        [590, 'awaitingPeer'],
      ]),
    ).toEqual([
      [0, 'idle'],
      [500, 'idle*'],
      [590, 'awaitingPeer'],
    ]);
  });

  it('a link opened before the first frame holds an EMPTY column, never the unseen Home screen', () => {
    // joiner: the mount effect dispatches `joining` before the first paint (measured)
    expect(
      replay(
        'idle',
        [
          [5, 'joining'],
          [40, 'pairing'],
          [70, 'confirming'],
          [72, 'connected'],
        ],
        { painted: false },
      ),
    ).toEqual([
      [0, 'idle'],
      [5, 'blank'],
      [72, 'connected'],
    ]);
    // …and a slow one gets the Connecting screen out of the blank, after the same hold.
    expect(replay('idle', [[5, 'joining']], { painted: false, until: 1000 })).toEqual([
      [0, 'idle'],
      [5, 'blank'],
      [5 + HOLD_MS, '~joining'],
    ]);
  });

  it('a relayed connection shows it after the hold; each title stays TITLE_MIN_MS; it leaves after its title had its time', () => {
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [2200, 'confirming'],
        [2400, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1000 + HOLD_MS, '~pairing'],
      [2200 + STAGE_SETTLE_MS, '~confirming'],
      [2400, '~confirming*'], // the FSM is connected; the title finishes its minimum, inert
      [2200 + STAGE_SETTLE_MS + TITLE_MIN_MS, 'connected'],
    ]);
  });

  it('a stage too short to read never gets its title (and costs no extra wait)', () => {
    // relay, joiner: confirming 4 ms
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [2200, 'confirming'],
        [2204, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1400, '~pairing'],
      [2204, 'connected'],
    ]);
  });

  it('titles never change faster than TITLE_MIN_MS, and the one that comes next is the stage NOW', () => {
    expect(
      replay('idle', [
        [1000, 'joining'],
        [1450, 'pairing'],
        [1480, 'confirming'],
        [2500, 'connected'],
      ]),
    ).toEqual([
      [0, 'idle'],
      [1000, 'idle*'],
      [1400, '~joining'],
      [1400 + TITLE_MIN_MS, '~confirming'], // pairing was skipped: it was over before its turn
      [2500, 'connected'],
    ]);
  });

  it('the Connecting screen that just appeared stays its minimum even when the FSM settles at once', () => {
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1450, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1400, '~pairing'],
      [1450, '~pairing*'],
      [1400 + TITLE_MIN_MS, 'connected'],
    ]);
  });
});

describe('screen pacing — failures, the SAS round trip, the reader who waits', () => {
  it('a failure during the hold shows at once', () => {
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1100, 'failed'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1100, 'failed'],
    ]);
  });

  it('a failure after the Connecting screen appeared waits for its title’s minimum, inert meanwhile', () => {
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1450, 'failed'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1400, '~pairing'],
      [1450, '~pairing*'],
      [1900, 'failed'],
    ]);
  });

  it('room method: Connecting → the SAS screen → the SAS screen HELD while confirming → Transfer', () => {
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1700, 'awaitingSas'],
        [5000, 'confirming'],
        [5020, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1400, '~pairing'],
      [1700, '~pairing*'],
      [1900, 'awaitingSas'],
      [5000, 'awaitingSas*'],
      [5020, 'connected'],
    ]);
  });

  it('the SAS reader who confirmed early waits on a LIVE Connecting screen (its Stop acts) until the picker answers', () => {
    const busy: boolean[] = [];
    const out = replay(
      'awaitingSas',
      [
        [1000, 'confirming'],
        [9000, 'connected'],
      ],
      { check: (p) => p.shown.kind === 'connecting' && busy.push(isBusy(p)) },
    );
    expect(out).toEqual([
      [0, 'awaitingSas'],
      [1000, 'awaitingSas*'],
      [1400, '~confirming'],
      [9000, 'connected'],
    ]);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((b) => b === false)).toBe(true);
  });

  it('a Connecting screen left for a settled status, then re-entered, keeps its title timing', () => {
    // pairing → awaitingSas → confirming before the title's minimum ran out: never leaves at all
    expect(
      replay('awaitingPeer', [
        [1000, 'pairing'],
        [1500, 'awaitingSas'],
        [1600, 'confirming'],
        [3000, 'connected'],
      ]),
    ).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
      [1400, '~pairing'],
      [1500, '~pairing*'],
      [1600, '~pairing'],
      [1900, '~confirming'],
      [3000, 'connected'],
    ]);
  });
});

describe('screen pacing — mechanics', () => {
  it('the DEV hold knob: 0 shows the Connecting screen at once, a huge hold keeps the screen held', () => {
    const zero = { ...DEFAULT_TIMING, holdMs: 0 };
    expect(replay('awaitingPeer', [[1000, 'pairing']], { timing: zero, until: 3000 })).toEqual([
      [0, 'awaitingPeer'],
      [1000, '~pairing'],
    ]);
    const huge = { ...DEFAULT_TIMING, holdMs: 1e9 };
    expect(replay('awaitingPeer', [[1000, 'pairing']], { timing: huge, until: 60_000 })).toEqual([
      [0, 'awaitingPeer'],
      [1000, 'awaitingPeer*'],
    ]);
  });

  it('advance is idempotent (same status, same time → the same object), so the hook cannot loop', () => {
    let p = markPainted(initialPace('awaitingPeer', 0));
    p = advance(p, 'pairing', 1000);
    expect(advance(p, 'pairing', 1000)).toBe(p);
    expect(advance(p, 'pairing', 1200)).toBe(p);
    const settled = markPainted(initialPace('connected', 0));
    expect(advance(settled, 'connected', 5000)).toBe(settled);
    expect(nextWake(settled)).toBeNull();
    expect(markPainted(settled)).toBe(settled);
  });

  it('only the Connecting screen and the held screen are busy — a settled screen never is', () => {
    const p = markPainted(initialPace('awaitingPeer', 0));
    expect(isBusy(p)).toBe(false);
    const held = advance(p, 'pairing', 10);
    expect(isBusy(held)).toBe(true);
    const connecting = advance(held, 'pairing', 10 + HOLD_MS);
    expect(connecting.shown.kind).toBe('connecting');
    expect(isBusy(connecting)).toBe(false);
    expect(isBusy(advance(connecting, 'connected', 20 + HOLD_MS))).toBe(true);
  });
});

/** The FSM's legal moves (connectionSlice ALLOWED), for random walks. */
const NEXT: Record<ConnectionStatus, ConnectionStatus[]> = {
  idle: ['creating', 'joining'],
  creating: ['awaitingPeer', 'failed'],
  awaitingPeer: ['pairing', 'failed'],
  joining: ['pairing', 'awaitingPeer', 'failed'],
  pairing: ['awaitingSas', 'confirming', 'awaitingPeer', 'failed'],
  awaitingSas: ['confirming', 'failed'],
  confirming: ['connected', 'awaitingPeer', 'failed'],
  connected: ['idle', 'failed'],
  failed: ['idle'],
};

describe('screen pacing — invariants over random walks of the FSM', () => {
  it('never shows a status the FSM has not reached, never shows `connected` unless connected, always catches up', () => {
    let seed = 0x2545f491;
    const rnd = (n: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let walk = 0; walk < 400; walk++) {
      const steps: Step[] = [];
      let s: ConnectionStatus = 'idle';
      let at = rnd(50);
      const reached = new Set<ConnectionStatus>(['idle']);
      for (let i = 0; i < 12; i++) {
        const options: ConnectionStatus[] = NEXT[s];
        s = options[rnd(options.length)]!;
        // gaps from "same frame" to "longer than every timer", biased to the short ones that matter
        at += [0, 1, 3, 20, 60, 140, 200, 380, 420, 520, 900, 1600][rnd(12)]!;
        steps.push([at, s]);
      }
      let last: Pace | null = null;
      replay('idle', steps, {
        painted: rnd(2) === 0,
        check: (p) => {
          reached.add(p.real);
          const shown = p.shown;
          if (shown.kind === 'screen') {
            // a settled screen is the FSM's own status, or one it has just left for a stage (held)
            expect(shown.status === p.real || (isStage(p.real) && shown.heldSince !== null)).toBe(
              true,
            );
            if (shown.status === 'connected') expect(p.real).toBe('connected');
            expect(reached.has(shown.status)).toBe(true);
          } else if (shown.kind === 'connecting') {
            expect(reached.has(shown.stage)).toBe(true);
          } else {
            expect(isStage(p.real)).toBe(true); // an empty column only ever stands in for a hold
          }
          last = p;
        },
      });
      // After the last change and every timer, the display has caught up with the FSM.
      const end = last as Pace | null;
      if (end && !isStage(end.real)) {
        expect(end.shown).toEqual({ kind: 'screen', status: end.real, heldSince: null });
      }
    }
  });
});
