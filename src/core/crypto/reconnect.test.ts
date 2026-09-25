import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { restoreIdentity } from './identity';
import { PAIRING_ID_BYTES } from './enrollment';
import {
  RECONNECT_BUCKET_MS,
  RECONNECT_CHALLENGE_BYTES,
  reconnectTranscript,
  signReconnect,
  verifyReconnect,
  presentedKeyMatchesPin,
  generateChallenge,
  reconnectBucket,
  msUntilNextBucket,
  reconnectRendezvous,
  reconnectRoleFor,
  oppositeRole,
  reconnectHelloMac,
  verifyReconnectHello,
  reconnectFrameSchema,
} from './reconnect';

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

describe('reconnectRendezvous — WHERE two pinned peers meet, with no code (2026-09-25)', () => {
  const ID_A = new Uint8Array(PAIRING_ID_BYTES).map((_, i) => (i + 1) & 0xff);
  const ID_B = new Uint8Array(PAIRING_ID_BYTES).fill(0x77);

  it('has exactly the shape of a link/QR token (22 base64url chars) — the server cannot tell them apart', () => {
    expect(reconnectRendezvous(ID_A, 12345)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('is deterministic: both pin-holders derive the same token for the same bucket', () => {
    expect(reconnectRendezvous(ID_A, 12345)).toBe(reconnectRendezvous(ID_A, 12345));
  });

  it('changes every bucket — the server cannot link one reconnect to the next by the room name', () => {
    expect(reconnectRendezvous(ID_A, 12345)).not.toBe(reconnectRendezvous(ID_A, 12346));
  });

  it('differs per pair — two pairs never collide on a token', () => {
    expect(reconnectRendezvous(ID_A, 12345)).not.toBe(reconnectRendezvous(ID_B, 12345));
  });

  it('is not the pairingId in disguise (keyed HMAC, truncated)', () => {
    const tok = reconnectRendezvous(ID_A, 12345);
    expect(tok).not.toContain(bytesToHex(ID_A));
    expect(Buffer.from(tok, 'base64url')).not.toEqual(Buffer.from(ID_A));
  });

  it('buckets the clock and knows the distance to the next boundary', () => {
    const t = 7 * RECONNECT_BUCKET_MS + 1234;
    expect(reconnectBucket(t)).toBe(7);
    expect(msUntilNextBucket(t)).toBe(RECONNECT_BUCKET_MS - 1234);
    expect(reconnectBucket(t + msUntilNextBucket(t))).toBe(8);
  });
});

describe('reconnectRoleFor — from the DTLS fingerprints, not create/join and not the server', () => {
  it('the lexicographically smaller fingerprint is the initiator, and the two sides are opposite', () => {
    expect(reconnectRoleFor(FP_A, FP_B)).toBe('initiator'); // '11…' < 'AB…'
    expect(reconnectRoleFor(FP_B, FP_A)).toBe('responder');
    expect(oppositeRole('initiator')).toBe('responder');
    expect(oppositeRole('responder')).toBe('initiator');
  });

  it('fails closed on degenerate fingerprints (equal / missing) rather than defaulting a side', () => {
    expect(reconnectRoleFor(FP_A, FP_A)).toBeNull();
    expect(reconnectRoleFor('', FP_A)).toBeNull();
    expect(reconnectRoleFor(FP_A, '')).toBeNull();
  });
});

describe('reconnect hello MAC — WHO is in the room, proven before any identity key is shown', () => {
  it('verifies under the same pairingId, the sender challenge, this channel and the sender role', () => {
    const mac = reconnectHelloMac(PAIRING_ID, CHAL_I, FP_A, FP_B, 'initiator');
    // The receiver labels local/remote the other way round and supplies the PEER role.
    expect(verifyReconnectHello(PAIRING_ID, CHAL_I, FP_B, FP_A, 'initiator', mac)).toBe(true);
  });

  it('a stranger without the pairing secret cannot produce one', () => {
    const other = new Uint8Array(PAIRING_ID_BYTES).fill(0x42);
    const mac = reconnectHelloMac(other, CHAL_I, FP_A, FP_B, 'initiator');
    expect(verifyReconnectHello(PAIRING_ID, CHAL_I, FP_B, FP_A, 'initiator', mac)).toBe(false);
  });

  it('is channel-bound: a relay re-terminating DTLS presents other fingerprints and fails it', () => {
    const mac = reconnectHelloMac(PAIRING_ID, CHAL_I, FP_A, FP_M, 'initiator');
    expect(verifyReconnectHello(PAIRING_ID, CHAL_I, FP_B, FP_A, 'initiator', mac)).toBe(false);
  });

  it('is bound to the role: our own hello echoed back to us does not verify (reflection)', () => {
    const mac = reconnectHelloMac(PAIRING_ID, CHAL_I, FP_A, FP_B, 'initiator');
    // We are the initiator; a reflected hello would be checked under the PEER role, responder.
    expect(verifyReconnectHello(PAIRING_ID, CHAL_I, FP_A, FP_B, 'responder', mac)).toBe(false);
  });

  it('is bound to the challenge: a replay with a different challenge fails', () => {
    const mac = reconnectHelloMac(PAIRING_ID, CHAL_I, FP_A, FP_B, 'initiator');
    expect(verifyReconnectHello(PAIRING_ID, CHAL_R, FP_B, FP_A, 'initiator', mac)).toBe(false);
  });

  it('rejects a MAC of the wrong length before comparing', () => {
    expect(verifyReconnectHello(PAIRING_ID, CHAL_I, FP_B, FP_A, 'initiator', new Uint8Array(16))).toBe(false);
  });
});

describe('reconnect wire frames — hello / proof / ok, exact lengths, nothing identifying in the hello', () => {
  it('a hello carries a 16-byte challenge and a 32-byte MAC, and no other field', () => {
    const ok = reconnectFrameSchema.safeParse({ kind: 'reconnect-hello', challenge: 'ab'.repeat(16), mac: 'cd'.repeat(32) });
    expect(ok.success).toBe(true);
    expect(reconnectFrameSchema.safeParse({ kind: 'reconnect-hello', challenge: 'ab'.repeat(16), mac: 'cd'.repeat(31) }).success).toBe(false);
    expect(reconnectFrameSchema.safeParse({ kind: 'reconnect-hello', challenge: 'ab'.repeat(15), mac: 'cd'.repeat(32) }).success).toBe(false);
  });

  it('the old reconnect-init / reconnect-fallback frames are no longer part of the protocol', () => {
    expect(reconnectFrameSchema.safeParse({ kind: 'reconnect-init', pairingId: 'ab'.repeat(16), challenge: 'cd'.repeat(16) }).success).toBe(false);
    expect(reconnectFrameSchema.safeParse({ kind: 'reconnect-fallback' }).success).toBe(false);
    expect(reconnectFrameSchema.safeParse({ kind: 'reconnect-ok' }).success).toBe(true);
  });
});
