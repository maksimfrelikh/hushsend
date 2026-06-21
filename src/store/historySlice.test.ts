import { describe, it, expect } from 'vitest';
import reducer, { historyActions, type TransferRecord } from './historySlice';

/**
 * Session-only transfer history (in-memory). It must stay MANAGEABLE so a long-lived tab can't
 * accumulate stale rows (UX bug #2): it is BOUNDED by a fixed cap (newest kept, oldest dropped) and
 * CLEARABLE via `forgotten` (wired to the home "forget", alongside the keystore-pin reset). The
 * per-send transfer reset is separate and does NOT clear these records.
 */

const HISTORY_CAP = 12; // mirror the slice's internal cap

const rec = (n: number): TransferRecord => ({
  id: `id-${n}`,
  fileName: `file-${n}.bin`,
  totalBytes: n,
  direction: 'send',
  at: n,
});

describe('history slice — bounded + clearable', () => {
  it('remembered() prepends newest-first', () => {
    let s = reducer(undefined, historyActions.remembered(rec(1)));
    s = reducer(s, historyActions.remembered(rec(2)));
    expect(s.records.map((r) => r.id)).toEqual(['id-2', 'id-1']);
  });

  it('remembered() is bounded at the cap (oldest rows fall off)', () => {
    let s = reducer(undefined, historyActions.remembered(rec(0)));
    for (let n = 1; n <= HISTORY_CAP + 5; n++) s = reducer(s, historyActions.remembered(rec(n)));
    expect(s.records).toHaveLength(HISTORY_CAP);
    // newest kept, oldest (id-0 … id-5) dropped
    expect(s.records[0].id).toBe(`id-${HISTORY_CAP + 5}`);
    expect(s.records.some((r) => r.id === 'id-0')).toBe(false);
  });

  it('forgotten() clears the whole history', () => {
    let s = reducer(undefined, historyActions.remembered(rec(1)));
    s = reducer(s, historyActions.remembered(rec(2)));
    s = reducer(s, historyActions.forgotten());
    expect(s.records).toEqual([]);
  });
});
