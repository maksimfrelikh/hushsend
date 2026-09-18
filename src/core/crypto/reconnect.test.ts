import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { restoreIdentity } from './identity';
import { PAIRING_ID_BYTES } from './enrollment';
import { RECONNECT_CHALLENGE_BYTES, reconnectTranscript, signReconnect, verifyReconnect, presentedKeyMatchesPin, generateChallenge, blindPairingId, matchBlindedPairingId } from './reconnect';

const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const FP_B = 'sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_M = 'sha-256 99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA'; // a MITM's cert

const PAIRING_ID = new Uint8Array(PAIRING_ID_BYTES).map((_, i) => (i + 1) & 0xff);
const CHAL_I = new Uint8Array(RECONNECT_CHALLENGE_BYTES).map((_, i) => (i * 5 + 1) & 0xff);
const CHAL_R = new Uint8Array(RECONNECT_CHALLENGE_BYTES).map((_, i) => (i * 11 + 7) & 0xff);

/** Local re-implementation of the lv() prefix to independently verify the transcript bytes. */
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

describe('reconnect transcript', () => {
  it('generateChallenge returns RECONNECT_CHALLENGE_BYTES of randomness (and varies)', () => {
    const c1 = generateChallenge();
    const c2 = generateChallenge();
    expect(c1.length).toBe(RECONNECT_CHALLENGE_BYTES);
    expect(c2.length).toBe(RECONNECT_CHALLENGE_BYTES);
    expect(c1).not.toEqual(c2); // overwhelmingly likely for 16 random bytes
  });

  it('matches the lv || challenges || fp-canonical construction (shared format)', () => {
    const expected = concatBytes(
      lv(utf8ToBytes('hushsend/identity/reconnect')),
      lv(PAIRING_ID),
      lv(CHAL_I), // challenges in FIXED role order: initiator, then responder
      lv(CHAL_R),
      lv(utf8ToBytes(FP_A)), // FP_A < FP_B lexicographically → fp_min
      lv(utf8ToBytes(FP_B)),
      lv(utf8ToBytes('initiator')),
    );
    const got = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    expect(bytesToHex(got)).toBe(bytesToHex(expected));
  });

  it('canonicalises the fingerprint order (peers labelling local/remote oppositely agree)', () => {
    const fromOneView = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    const fromOtherView = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_B, FP_A, 'initiator');
    expect(bytesToHex(fromOneView)).toBe(bytesToHex(fromOtherView));
  });

  it('binds the challenge ROLE order (swapping initiator/responder changes the transcript)', () => {
    const correct = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    const swapped = reconnectTranscript(PAIRING_ID, CHAL_R, CHAL_I, FP_A, FP_B, 'initiator');
    expect(bytesToHex(swapped)).not.toBe(bytesToHex(correct));
  });

  it('changes with a different role', () => {
    const init = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    const resp = reconnectTranscript(PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'responder');
    expect(bytesToHex(init)).not.toBe(bytesToHex(resp));
  });
});

describe('reconnect sign / verify (check 2 — channel-bound signature under the pinned key)', () => {
  it('verifies under the correct pinned key, role, pairingId, challenges and fingerprints', async () => {
    const initiator = makeIdentity(1);
    // Signer (initiator) sees local=FP_A, remote=FP_B. Verifier (responder) sees them swapped.
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    expect(
      await verifyReconnect(initiator.publicKey, PAIRING_ID, CHAL_I, CHAL_R, FP_B, FP_A, 'initiator', sig),
    ).toBe(true);
  });

  it('rejects under a DIFFERENT key (the key-changed signature would never verify here either)', async () => {
    const initiator = makeIdentity(1);
    const other = makeIdentity(2);
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    expect(
      await verifyReconnect(other.publicKey, PAIRING_ID, CHAL_I, CHAL_R, FP_B, FP_A, 'initiator', sig),
    ).toBe(false);
  });

  it('rejects under DIFFERENT fingerprints (channel binding / MITM)', async () => {
    const initiator = makeIdentity(1);
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    // A MITM leg presents FP_M instead of FP_A → the verifier's pair differs → reject.
    expect(
      await verifyReconnect(initiator.publicKey, PAIRING_ID, CHAL_I, CHAL_R, FP_B, FP_M, 'initiator', sig),
    ).toBe(false);
  });

  it('rejects under DIFFERENT / replayed challenges (anti-replay)', async () => {
    const initiator = makeIdentity(1);
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    // A replayed transcript from a prior session would carry a stale challenge → reject.
    const staleI = CHAL_I.slice();
    staleI[0] ^= 0x01;
    expect(
      await verifyReconnect(initiator.publicKey, PAIRING_ID, staleI, CHAL_R, FP_B, FP_A, 'initiator', sig),
    ).toBe(false);
    const staleR = CHAL_R.slice();
    staleR[0] ^= 0x01;
    expect(
      await verifyReconnect(initiator.publicKey, PAIRING_ID, CHAL_I, staleR, FP_B, FP_A, 'initiator', sig),
    ).toBe(false);
  });

  it('rejects under the WRONG role label (reflection defense)', async () => {
    const initiator = makeIdentity(1);
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    expect(
      await verifyReconnect(initiator.publicKey, PAIRING_ID, CHAL_I, CHAL_R, FP_B, FP_A, 'responder', sig),
    ).toBe(false);
  });

  it('rejects under a DIFFERENT pairingId', async () => {
    const initiator = makeIdentity(1);
    const sig = await signReconnect(initiator, PAIRING_ID, CHAL_I, CHAL_R, FP_A, FP_B, 'initiator');
    const otherPairing = new Uint8Array(PAIRING_ID_BYTES).fill(0xaa);
    expect(
      await verifyReconnect(initiator.publicKey, otherPairing, CHAL_I, CHAL_R, FP_B, FP_A, 'initiator', sig),
    ).toBe(false);
  });
});

describe('presentedKeyMatchesPin (check 1 — key-change detection in the keystore)', () => {
  it('matches when the presented key equals the pinned key', () => {
    const pinned = bytesToHex(makeIdentity(1).publicKey);
    expect(presentedKeyMatchesPin(pinned, pinned)).toBe(true);
  });

  it('flags a key change when the presented key differs from the pin (SSH-style hard stop)', () => {
    const pinned = bytesToHex(makeIdentity(1).publicKey);
    const presented = bytesToHex(makeIdentity(2).publicKey);
    expect(presentedKeyMatchesPin(pinned, presented)).toBe(false);
  });

  it('treats malformed hex as "does not match" (rejected before crypto)', () => {
    const pinned = bytesToHex(makeIdentity(1).publicKey);
    expect(presentedKeyMatchesPin(pinned, 'not-hex')).toBe(false);
  });
});

describe('blindPairingId / matchBlindedPairingId — the announced value (2026-09-18)', () => {
  const ID_A = new Uint8Array(PAIRING_ID_BYTES).map((_, i) => (i + 1) & 0xff);
  const ID_B = new Uint8Array(PAIRING_ID_BYTES).fill(0x77);
  const FP1 = 'sha-256 AA:BB:CC';
  const FP2 = 'sha-256 11:22:33';

  it('is the same length as the raw id it replaces — so an older peer still parses the frame', () => {
    expect(blindPairingId(ID_A, FP1, FP2)).toHaveLength(PAIRING_ID_BYTES);
  });

  it('both sides derive it, whichever of them is "local"', () => {
    expect(blindPairingId(ID_A, FP1, FP2)).toEqual(blindPairingId(ID_A, FP2, FP1));
  });

  it('REVEALS NOTHING CORRELATABLE: the same pair announces a different value every session', () => {
    const session1 = blindPairingId(ID_A, FP1, FP2);
    const session2 = blindPairingId(ID_A, 'sha-256 DE:AD:BE', 'sha-256 EF:00:11');
    expect(session1).not.toEqual(session2); // the whole point — this is the leak being closed
    expect(session1).not.toEqual(ID_A); // and it is not the id itself
  });

  it('different pairs announce different values in the same session', () => {
    expect(blindPairingId(ID_A, FP1, FP2)).not.toEqual(blindPairingId(ID_B, FP1, FP2));
  });

  it('a peer holding the pin recognises it by recomputation', () => {
    const announced = blindPairingId(ID_B, FP1, FP2);
    const hex = bytesToHex(ID_B);
    expect(matchBlindedPairingId(announced, [bytesToHex(ID_A), hex], FP1, FP2)).toBe(hex);
  });

  it('a stranger holding no pin for this pair matches nothing → SAS fallback', () => {
    const announced = blindPairingId(ID_B, FP1, FP2);
    expect(matchBlindedPairingId(announced, [bytesToHex(ID_A)], FP1, FP2)).toBeNull();
    expect(matchBlindedPairingId(announced, [], FP1, FP2)).toBeNull();
  });

  it('the right pin under the WRONG session fingerprints does not match — it is channel-bound', () => {
    const announced = blindPairingId(ID_B, FP1, FP2);
    expect(matchBlindedPairingId(announced, [bytesToHex(ID_B)], 'sha-256 99:99:99', FP2)).toBeNull();
  });

  it('a malformed entry in the keystore does not abort the scan', () => {
    const announced = blindPairingId(ID_B, FP1, FP2);
    expect(matchBlindedPairingId(announced, ['nothex!!', bytesToHex(ID_B)], FP1, FP2)).toBe(bytesToHex(ID_B));
  });

  it('an OLD peer announcing a raw pairingId matches nothing → SAS fallback, never a hang', () => {
    // The compatibility path: the field is the same length, so the frame parses; it simply is not a
    // tag we can recognise, and the responder falls back exactly as it would for an unknown pair.
    expect(matchBlindedPairingId(ID_B, [bytesToHex(ID_B)], FP1, FP2)).toBeNull();
  });
});
