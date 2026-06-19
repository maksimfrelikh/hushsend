import { describe, it, expect } from 'vitest';
import {
  WORDLIST,
  RENDEZVOUS_WORDS,
  SECRET_WORDS,
  TOTAL_WORDS,
  generateWords,
  splitWords,
} from './words';

describe('EFF short wordlist #2', () => {
  it('is exactly 1296 unique words with a unique 3-character prefix each', () => {
    expect(WORDLIST.length).toBe(1296);
    expect(new Set(WORDLIST).size).toBe(1296);
    // The misread-resistant property the words method relies on for autocomplete:
    // typing 3 chars narrows to a single word.
    expect(new Set(WORDLIST.map((w) => w.slice(0, 3))).size).toBe(1296);
    // Every word is at least 3 chars (so a 3-char prefix exists).
    expect(WORDLIST.every((w) => w.length >= 3)).toBe(true);
  });

  it('uses the finalized credential shape: 1 rendezvous + 4 secret = 5', () => {
    expect(RENDEZVOUS_WORDS).toBe(1);
    expect(SECRET_WORDS).toBe(4);
    expect(TOTAL_WORDS).toBe(5);
  });
});

describe('generateWords', () => {
  it('returns TOTAL_WORDS (5) words', () => {
    expect(generateWords()).toHaveLength(TOTAL_WORDS);
  });

  it('only ever yields words from the list', () => {
    const set = new Set(WORDLIST);
    for (let i = 0; i < 100; i++) {
      for (const w of generateWords()) expect(set.has(w)).toBe(true);
    }
  });

  it('differs between calls (fresh CSPRNG draw each time)', () => {
    // Two independent 5-word draws colliding fully is ~1296^-5 ≈ 2^-51; never in practice.
    const runs = Array.from({ length: 8 }, () => generateWords().join(' '));
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('produces a roughly uniform spread (no obvious stuck index)', () => {
    // Sanity check the rejection sampler isn't collapsed onto one bucket.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) for (const w of generateWords()) seen.add(w);
    // 1000 draws should touch a large fraction of the 1296-word space.
    expect(seen.size).toBeGreaterThan(300);
  });
});

describe('splitWords', () => {
  it('splits a 5-word credential into rendezvous (1) + secret (4)', () => {
    const { rendezvous, secret } = splitWords(['alpha', 'bravo', 'cosy', 'delta', 'echo']);
    expect(rendezvous).toBe('alpha');
    expect(secret).toEqual(['bravo', 'cosy', 'delta', 'echo']);
  });
});
