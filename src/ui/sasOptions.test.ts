import { describe, it, expect } from 'vitest';
import { buildSasOptions, sasSelectionOk, SAS_WORDS } from './sasOptions';
import { WORDLIST } from '../core/words/words';

/**
 * Unit coverage for the SAS "pick from 3" DISPLAY logic. The crypto (sas.ts) is unchanged and not
 * exercised here — this pins the UI invariants the review calls out: indistinguishable decoys
 * (same wordlist, same 3-word format, distinct from the real phrase and each other), a randomised
 * real-phrase position, and ok=true ONLY when the real phrase is picked.
 */

const WORDSET = new Set<string>(WORDLIST);
// Any 3 words make a valid "real" phrase for the display logic (its origin is the core).
const REAL = 'cedar falcon lemon';
const ITER = 300;

describe('buildSasOptions', () => {
  it('always returns the real phrase plus exactly two decoys (3 options)', () => {
    for (let i = 0; i < ITER; i++) {
      const opts = buildSasOptions(REAL, SAS_WORDS);
      expect(opts).toHaveLength(3);
      expect(opts.filter((o) => o === REAL)).toHaveLength(1); // real appears exactly once
    }
  });

  it('decoys differ from the real phrase and from each other', () => {
    for (let i = 0; i < ITER; i++) {
      const decoys = buildSasOptions(REAL, SAS_WORDS).filter((o) => o !== REAL);
      expect(decoys).toHaveLength(2);
      expect(decoys[0]).not.toBe(REAL);
      expect(decoys[1]).not.toBe(REAL);
      expect(decoys[0]).not.toBe(decoys[1]);
    }
  });

  it('decoys use the same 3-word format and only EFF short #2 words', () => {
    for (let i = 0; i < ITER; i++) {
      const decoys = buildSasOptions(REAL, SAS_WORDS).filter((o) => o !== REAL);
      for (const decoy of decoys) {
        const words = decoy.split(' ');
        expect(words).toHaveLength(SAS_WORDS);
        for (const w of words) expect(WORDSET.has(w)).toBe(true);
      }
    }
  });

  it('randomises the real phrase position (not a fixed slot)', () => {
    const positions = new Set<number>();
    for (let i = 0; i < ITER; i++) positions.add(buildSasOptions(REAL, SAS_WORDS).indexOf(REAL));
    expect(positions.size).toBeGreaterThan(1); // appears in more than one position across runs
  });
});

describe('sasSelectionOk', () => {
  it('is true ONLY when the selected option is the real phrase', () => {
    const opts = buildSasOptions(REAL, SAS_WORDS);
    const realIdx = opts.indexOf(REAL);
    expect(sasSelectionOk(opts, realIdx, REAL)).toBe(true);
    // every other index is a decoy → false
    for (let i = 0; i < opts.length; i++) {
      if (i !== realIdx) expect(sasSelectionOk(opts, i, REAL)).toBe(false);
    }
  });

  it('is false for "none of these match" (null) and out-of-range picks', () => {
    const opts = buildSasOptions(REAL, SAS_WORDS);
    expect(sasSelectionOk(opts, null, REAL)).toBe(false);
    expect(sasSelectionOk(opts, -1, REAL)).toBe(false);
    expect(sasSelectionOk(opts, opts.length, REAL)).toBe(false);
  });
});
