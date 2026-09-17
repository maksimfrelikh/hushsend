import { describe, it, expect } from 'vitest';
import { paddedSize, padBytesFor, PAD_FLOOR, PAD_COARSE_BELOW, BUCKETS_PER_OCTAVE } from './padding';

describe('paddedSize', () => {
  it('never returns less than the real size — padding must not truncate', () => {
    for (const n of [1, 999, 16 * 1024, 16 * 1024 + 1, 1e6, 1e9, 2 ** 31]) {
      expect(paddedSize(n)).toBeGreaterThanOrEqual(n);
    }
  });

  it('is monotonic — a bigger file never pads to a smaller volume (that would leak by inversion)', () => {
    let prev = 0;
    for (let n = 1; n < 40 * 1024 * 1024; n = Math.ceil(n * 1.37) + 1) {
      const p = paddedSize(n);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('collapses every small file into one floor bucket', () => {
    expect(paddedSize(1)).toBe(PAD_FLOOR);
    expect(paddedSize(9_000)).toBe(PAD_FLOOR);
    expect(paddedSize(PAD_FLOOR)).toBe(PAD_FLOOR);
  });

  it('uses powers of two below the coarse threshold', () => {
    expect(paddedSize(PAD_FLOOR + 1)).toBe(PAD_FLOOR * 2);
    expect(paddedSize(500 * 1024)).toBe(512 * 1024);
    expect(paddedSize(700 * 1024)).toBe(1024 * 1024);
  });

  it('caps the overhead above the threshold — the reason it is not powers of two throughout', () => {
    for (let n = PAD_COARSE_BELOW; n < 8 * 1024 * 1024 * 1024; n = Math.ceil(n * 1.11)) {
      const overhead = (paddedSize(n) - n) / n;
      expect(overhead).toBeLessThanOrEqual(1 / BUCKETS_PER_OCTAVE + 1e-9);
    }
  });

  it('pads an ordinary document to a bucket edge rather than its own size', () => {
    const doc = 4_723_811; // the worked example in the module header
    const p = paddedSize(doc);
    expect(p).toBeGreaterThan(doc);
    expect(p % (2 ** Math.floor(Math.log2(doc)) / BUCKETS_PER_OCTAVE)).toBe(0);
  });

  it('zero and nonsense are zero, not NaN — a 0-byte file sends nothing', () => {
    expect(paddedSize(0)).toBe(0);
    expect(paddedSize(-5)).toBe(0);
    expect(paddedSize(Number.NaN)).toBe(0);
    expect(padBytesFor(0)).toBe(0);
  });

  it('padBytesFor is the difference, and is 0 exactly on a bucket edge', () => {
    expect(padBytesFor(512 * 1024)).toBe(0);
    expect(padBytesFor(500 * 1024)).toBe(512 * 1024 - 500 * 1024);
  });
});
