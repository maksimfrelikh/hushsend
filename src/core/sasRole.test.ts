import { describe, it, expect } from 'vitest';
import { sasRoleFrom } from './sasRole';
import { sasReaderIsFpMin, generateNonce } from './crypto/sas';

/**
 * The per-pairing SAS reader/picker split, as rebuilt after the 2026-09-12 audit.
 *
 * It used to come from the two readable signaling ids (smaller id reads). The ids are assigned BY
 * THE UNTRUSTED SERVER, independently to each peer, so a malicious server could tell BOTH peers they
 * held the smaller id — both become the blind picker, nobody reads, and the ceremony degrades from
 * "one reads, one identifies" to two humans each guessing 1-in-3. These pin the replacement:
 *   - the split is a function of the SAS MATERIAL (both nonces + both fingerprints), not of any id;
 *   - both sides of a pair still resolve to OPPOSITE roles, for ANY pair including joiner↔joiner;
 *   - fail-closed: a missing/degenerate fingerprint pair yields `null`, which the SAS screen renders
 *     as the restart view, never a functional blind picker.
 */
const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const FP_B = 'sha-256 FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00';

describe('sasRoleFrom', () => {
  it('gives the two sides of a pair OPPOSITE roles, for either value of the bit', () => {
    for (const bit of [true, false]) {
      // A holds (local=FP_A, remote=FP_B); B holds the same pair labelled the other way round.
      const roleA = sasRoleFrom(FP_A, FP_B, bit);
      const roleB = sasRoleFrom(FP_B, FP_A, bit);
      expect(roleA).not.toBeNull();
      expect(roleB).not.toBeNull();
      expect(roleA).not.toBe(roleB);
      expect(new Set([roleA, roleB])).toEqual(new Set(['reader', 'picker']));
    }
  });

  it('lets the bit decide WHICH side reads (fp_min when true, fp_max when false)', () => {
    const [fpMin, fpMax] = FP_A < FP_B ? [FP_A, FP_B] : [FP_B, FP_A];
    expect(sasRoleFrom(fpMin, fpMax, true)).toBe('reader');
    expect(sasRoleFrom(fpMax, fpMin, true)).toBe('picker');
    expect(sasRoleFrom(fpMin, fpMax, false)).toBe('picker');
    expect(sasRoleFrom(fpMax, fpMin, false)).toBe('reader');
  });

  it('FAILS CLOSED to null on a missing or degenerate fingerprint pair (→ restart screen)', () => {
    expect(sasRoleFrom(null, FP_B, true)).toBeNull();
    expect(sasRoleFrom(FP_A, null, true)).toBeNull();
    expect(sasRoleFrom(null, null, true)).toBeNull();
    expect(sasRoleFrom(undefined, FP_B, false)).toBeNull();
    expect(sasRoleFrom('', FP_B, true)).toBeNull();
    // identical fingerprints cannot happen (a certificate is fresh per PeerConnection) but must not
    // silently land both sides on the same role if they ever did.
    expect(sasRoleFrom(FP_A, FP_A, true)).toBeNull();
  });
});

describe('sasReaderIsFpMin — the split the server cannot choose', () => {
  it('is deterministic, and identical for both peers of a pair (they hold the pair oppositely)', () => {
    const nI = generateNonce();
    const nR = generateNonce();
    const fromA = sasReaderIsFpMin(nI, nR, FP_A, FP_B);
    const fromB = sasReaderIsFpMin(nI, nR, FP_B, FP_A);
    expect(fromA).toBe(fromB); // the fingerprints are canonicalised inside the IKM
    expect(sasReaderIsFpMin(nI, nR, FP_A, FP_B)).toBe(fromA); // deterministic
  });

  it('depends on the NONCES — so a MITM picking a certificate cannot steer it', () => {
    // The nonces are revealed only after the fingerprints are pinned, so at certificate-choosing
    // time the attacker does not know them. Changing only the nonces must move the bit around.
    const fps: [string, string] = [FP_A, FP_B];
    const seen = new Set<boolean>();
    for (let i = 0; i < 64 && seen.size < 2; i++) {
      seen.add(sasReaderIsFpMin(generateNonce(), generateNonce(), ...fps));
    }
    expect(seen).toEqual(new Set([true, false]));
  });

  it('is not a function of anything the server assigns — the ids are not an input at all', () => {
    // Regression guard for the audit finding: the signature takes no id, so no id ordering can
    // reach the split. Both peers derive it from material the server does not choose.
    expect(sasReaderIsFpMin.length).toBe(4); // (nonceInitiator, nonceResponder, localFp, remoteFp)
  });
});
