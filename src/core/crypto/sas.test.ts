import { describe, it, expect } from 'vitest';
import { WORDLIST } from '../words/words';
import {
  NONCE_BYTES,
  SAS_WORD_COUNT,
  generateNonce,
  sasCommit,
  verifySasCommit,
  computeSasWords,
} from './sas';

// Deterministic nonce fixtures (the module's CSPRNG draw is generateNonce; the rest is pure).
const NONCE_A = new Uint8Array(NONCE_BYTES).map((_, i) => (i * 5 + 1) & 0xff);
const NONCE_B = new Uint8Array(NONCE_BYTES).map((_, i) => (i * 11 + 7) & 0xff);

// DTLS fingerprints (same canonicalisation as keyConfirmation: the value parsed from SDP).
const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const FP_B = 'sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_M = 'sha-256 99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA'; // a MITM's cert

describe('SAS — commit/reveal', () => {
  it('generateNonce returns NONCE_BYTES of randomness (and varies)', () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    expect(n1.length).toBe(NONCE_BYTES);
    expect(n2.length).toBe(NONCE_BYTES);
    expect(n1).not.toEqual(n2); // overwhelmingly likely for 16 random bytes
  });

  it('a commitment verifies against its own nonce', () => {
    const c = sasCommit(NONCE_B);
    expect(c.length).toBe(32); // SHA-256
    expect(verifySasCommit(c, NONCE_B)).toBe(true);
  });

  it('rejects a reveal that does not match the commitment (anti-grinding)', () => {
    const c = sasCommit(NONCE_B);
    // Wrong nonce → reject (the responder cannot swap its nonce after committing).
    expect(verifySasCommit(c, NONCE_A)).toBe(false);
    const flipped = NONCE_B.slice();
    flipped[0] ^= 0x01;
    expect(verifySasCommit(c, flipped)).toBe(false);
  });

  it('rejects a tampered commitment', () => {
    const c = sasCommit(NONCE_B);
    const tampered = c.slice();
    tampered[0] ^= 0x01;
    expect(verifySasCommit(tampered, NONCE_B)).toBe(false);
    expect(verifySasCommit(new Uint8Array(32), NONCE_B)).toBe(false);
  });
});

describe('SAS — derivation', () => {
  it('is deterministic and yields SAS_WORD_COUNT words from the EFF short #2 list', () => {
    const w1 = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    const w2 = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    expect(w1).toEqual(w2);
    expect(w1).toHaveLength(SAS_WORD_COUNT);
    for (const word of w1) expect(WORDLIST).toContain(word);
  });

  it('known-answer: pins the HKDF-SHA512 derivation for fixed inputs (regression anchor)', () => {
    // Catches any accidental change to the KDF, IKM layout, info label, or word-index mapping.
    expect(computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B)).toEqual(['acid', 'kennel', 'pantyhose']);
  });

  it('both sides compute the SAME triple despite labelling fingerprints local/remote oppositely', () => {
    // Initiator sees (local=FP_A, remote=FP_B); responder sees (local=FP_B, remote=FP_A). The
    // nonces are passed in the SAME role order (initiator, responder) on both sides, and the
    // fingerprints are canonicalised inside — so the words must match.
    const initiatorView = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    const responderView = computeSasWords(NONCE_A, NONCE_B, FP_B, FP_A);
    expect(initiatorView).toEqual(responderView);
  });

  it('is bound to the channel: a different fingerprint pair yields a different SAS (MITM detect)', () => {
    // Honest pair {FP_A, FP_B} vs a MITM leg {FP_A, FP_M}: the humans would read different words.
    const honest = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    const mitmLeg = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_M);
    expect(mitmLeg).not.toEqual(honest);

    // The classic MITM split: A's leg holds {FP_A, FP_M}, B's leg holds {FP_B, FP_M}. Even with
    // the SAME nonces (worst case), the two sides derive DIFFERENT words → mismatch is visible.
    const aLeg = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_M);
    const bLeg = computeSasWords(NONCE_A, NONCE_B, FP_B, FP_M);
    expect(aLeg).not.toEqual(bLeg);
  });

  it('is bound to the nonces: different nonces yield a different SAS', () => {
    const base = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    const other = NONCE_A.slice();
    other[0] ^= 0x01;
    expect(computeSasWords(other, NONCE_B, FP_A, FP_B)).not.toEqual(base);
    expect(computeSasWords(NONCE_A, other, FP_A, FP_B)).not.toEqual(base);
  });

  it('binds the nonce ROLE order (swapping initiator/responder changes the SAS)', () => {
    // A and B must agree which nonce is "initiator"; if they disagreed the words would diverge.
    const correct = computeSasWords(NONCE_A, NONCE_B, FP_A, FP_B);
    const swapped = computeSasWords(NONCE_B, NONCE_A, FP_A, FP_B);
    expect(swapped).not.toEqual(correct);
  });
});
