import { describe, it, expect } from 'vitest';
import { sasSignalSchema } from './SessionController';
import { NONCE_BYTES } from './crypto/sas';

/**
 * The signaling relay is UNTRUSTED, so a SAS commit/nonce must be rejected by the schema BEFORE
 * the crypto sees it — and not merely "some hex string". A MITM that sent a short/truncated
 * commit or nonce (to grind a smaller space) or any malformed value must be dropped at decode.
 */
const HEX_COMMIT = 'ab'.repeat(32); // 32 bytes (SHA-256), 64 hex chars
const HEX_NONCE = 'cd'.repeat(NONCE_BYTES); // 16 bytes, 32 hex chars

describe('sasSignalSchema — exact decoded lengths', () => {
  it('accepts a well-formed commit (32 bytes) and nonce (16 bytes)', () => {
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: HEX_COMMIT }).success).toBe(true);
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: HEX_NONCE }).success).toBe(true);
  });

  it('rejects a commit that is not exactly 32 bytes', () => {
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: '' }).success).toBe(false); // empty
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: 'ab' }).success).toBe(false); // 1 byte
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: 'ab'.repeat(31) }).success).toBe(false); // short
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: 'ab'.repeat(33) }).success).toBe(false); // long
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: HEX_NONCE }).success).toBe(false); // nonce-sized
  });

  it('rejects a nonce that is not exactly 16 bytes', () => {
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: '' }).success).toBe(false);
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: 'cd' }).success).toBe(false);
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: 'cd'.repeat(15) }).success).toBe(false);
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: 'cd'.repeat(17) }).success).toBe(false);
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: HEX_COMMIT }).success).toBe(false); // commit-sized
  });

  it('rejects non-hex / odd-length / wrong-type payloads at the right length', () => {
    // Right character count but not hex.
    expect(sasSignalSchema.safeParse({ kind: 'sas-commit', c: 'zz'.repeat(32) }).success).toBe(false);
    // Odd hex length (the even-pair regex also rejects this).
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: 'a'.repeat(31) }).success).toBe(false);
    // Non-string and unknown kind.
    expect(sasSignalSchema.safeParse({ kind: 'sas-nonce', nonce: 123 }).success).toBe(false);
    expect(sasSignalSchema.safeParse({ kind: 'sas-bogus', c: HEX_COMMIT }).success).toBe(false);
  });
});
