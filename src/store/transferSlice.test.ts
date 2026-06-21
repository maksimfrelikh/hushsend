import { describe, it, expect } from 'vitest';
import reducer, { transferActions, type TransferState } from './transferSlice';

/**
 * Per-transfer state must start from a clean slate on every new send (UX bug #2): a finished
 * transfer's progress / file name / phase must not bleed into the next one. `sendFiles` dispatches
 * `reset()` before each send, and the "New transfer" button on the done screen dispatches it on the
 * way back to ready-to-send. The reducer is the single source of that guarantee.
 */

const dirtyDone: TransferState = {
  direction: 'send',
  fileName: 'old.bin',
  totalBytes: 1000,
  transferredBytes: 1000,
  phase: 'done',
  error: null,
};

describe('transfer slice — per-send reset', () => {
  it('reset() returns per-transfer state to initial from any terminal state', () => {
    const s = reducer(dirtyDone, transferActions.reset());
    expect(s).toEqual({
      direction: null,
      fileName: null,
      totalBytes: 0,
      transferredBytes: 0,
      phase: 'idle',
      error: null,
    });
  });

  it('reset() also clears a lingering error from a failed transfer', () => {
    const failed = reducer(dirtyDone, transferActions.failed({ reason: 'sink died' }));
    expect(failed.error).toBe('sink died');
    expect(reducer(failed, transferActions.reset()).error).toBeNull();
  });

  it('a new offered() starts clean — no leftover progress/error from the prior transfer', () => {
    // Simulate: prior transfer left progress + an error, then a new send is offered.
    const carry = reducer(dirtyDone, transferActions.failed({ reason: 'boom' }));
    const next = reducer(carry, transferActions.offered({ direction: 'send', fileName: 'new.txt', totalBytes: 42 }));
    expect(next).toEqual({
      direction: 'send',
      fileName: 'new.txt',
      totalBytes: 42,
      transferredBytes: 0,
      phase: 'offered',
      error: null,
    });
  });
});
