import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { restoreIdentity } from './identity';
import { enrollmentTranscript, signEnrollment, verifyEnrollment, PAIRING_ID_BYTES } from './enrollment';

const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const FP_B = 'sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_M = 'sha-256 99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA';

const PAIRING_ID = new Uint8Array(PAIRING_ID_BYTES).map((_, i) => (i + 1) & 0xff);

/** Local re-implementation of the lv() prefix to independently verify transcript bytes. */
function lv(data: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  let length = data.length;
  for (;;) {
    if (length < 128) prefix.push(length);
    else prefix.push((length & 0x7f) + 0x80);
    length = Math.floor(length / 128);
    if (length === 0) break;
  }
  return concatBytes(Uint8Array.from(prefix), data);
}

function makeIdentity(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const publicKey = Uint8Array.from(ed25519.getPublicKey(seed));
  return restoreIdentity({ kind: 'noble', seed, publicKey });
}

describe('enrollment transcript', () => {
  it('matches the lv || fp-canonical construction (shared format)', () => {
    const ownPub = new Uint8Array(32).map((_, i) => (i * 5) & 0xff);
    const expected = concatBytes(
      lv(utf8ToBytes('hushsend/identity/enroll')),
      lv(PAIRING_ID),
      lv(ownPub),
      lv(utf8ToBytes(FP_A)), // FP_A < FP_B lexicographically → fp_min
      lv(utf8ToBytes(FP_B)),
      lv(utf8ToBytes('initiator')),
    );
    const got = enrollmentTranscript(PAIRING_ID, ownPub, FP_A, FP_B, 'initiator');
    expect(bytesToHex(got)).toBe(bytesToHex(expected));
  });

  it('canonicalises the fingerprint order (peers labelling local/remote oppositely agree)', () => {
    const ownPub = new Uint8Array(32).fill(7);
    const fromOneView = enrollmentTranscript(PAIRING_ID, ownPub, FP_A, FP_B, 'initiator');
    const fromOtherView = enrollmentTranscript(PAIRING_ID, ownPub, FP_B, FP_A, 'initiator');
    expect(bytesToHex(fromOneView)).toBe(bytesToHex(fromOtherView));
  });

  it('changes with a different role', () => {
    const ownPub = new Uint8Array(32).fill(7);
    const init = enrollmentTranscript(PAIRING_ID, ownPub, FP_A, FP_B, 'initiator');
    const resp = enrollmentTranscript(PAIRING_ID, ownPub, FP_A, FP_B, 'responder');
    expect(bytesToHex(init)).not.toBe(bytesToHex(resp));
  });
});

describe('enrollment sign / verify', () => {
  it('verifies under the correct peer pubkey, role, pairingId and fingerprints', async () => {
    const initiator = makeIdentity(1);
    // Signer (initiator) sees local=FP_A, remote=FP_B. Verifier (responder) sees them swapped.
    const sig = await signEnrollment(initiator, PAIRING_ID, FP_A, FP_B, 'initiator');
    expect(await verifyEnrollment(initiator.publicKey, PAIRING_ID, FP_B, FP_A, 'initiator', sig)).toBe(true);
  });

  it('rejects under a DIFFERENT public key', async () => {
    const initiator = makeIdentity(1);
    const other = makeIdentity(2);
    const sig = await signEnrollment(initiator, PAIRING_ID, FP_A, FP_B, 'initiator');
    expect(await verifyEnrollment(other.publicKey, PAIRING_ID, FP_B, FP_A, 'initiator', sig)).toBe(false);
  });

  it('rejects under DIFFERENT fingerprints (channel binding)', async () => {
    const initiator = makeIdentity(1);
    const sig = await signEnrollment(initiator, PAIRING_ID, FP_A, FP_B, 'initiator');
    // A MITM leg presents FP_M instead of FP_A → verifier's pair differs → reject.
    expect(await verifyEnrollment(initiator.publicKey, PAIRING_ID, FP_B, FP_M, 'initiator', sig)).toBe(false);
  });

  it('rejects under the WRONG role label', async () => {
    const initiator = makeIdentity(1);
    const sig = await signEnrollment(initiator, PAIRING_ID, FP_A, FP_B, 'initiator');
    expect(await verifyEnrollment(initiator.publicKey, PAIRING_ID, FP_B, FP_A, 'responder', sig)).toBe(false);
  });

  it('rejects under a DIFFERENT pairingId', async () => {
    const initiator = makeIdentity(1);
    const sig = await signEnrollment(initiator, PAIRING_ID, FP_A, FP_B, 'initiator');
    const otherPairing = new Uint8Array(PAIRING_ID_BYTES).fill(0xaa);
    expect(await verifyEnrollment(initiator.publicKey, otherPairing, FP_B, FP_A, 'initiator', sig)).toBe(false);
  });
});
