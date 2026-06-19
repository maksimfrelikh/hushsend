import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/curves/utils.js';
import {
  makeConfirmation,
  verifyConfirmation,
  CPACE_CONFIRM_DOMAIN,
  LINK_CONFIRM_DOMAIN,
} from './keyConfirmation';

const ISK = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff); // deterministic fixture
const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const FP_B = 'sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('key confirmation', () => {
  it('is deterministic for identical inputs', () => {
    const t1 = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    const t2 = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    expect(bytesToHex(t1)).toBe(bytesToHex(t2));
    expect(t1.length).toBe(32); // HMAC-SHA256
  });

  it('the matching tag verifies', () => {
    const tag = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'initiator', tag)).toBe(true);
  });

  it('binds both DTLS fingerprints (a changed fingerprint changes the tag)', () => {
    const base = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    const changedRemote = makeConfirmation(ISK, FP_A, FP_B.replace('AB', 'AC'), 'initiator');
    const changedLocal = makeConfirmation(ISK, FP_A.replace('11', '12'), FP_B, 'initiator');
    expect(bytesToHex(changedRemote)).not.toBe(bytesToHex(base));
    expect(bytesToHex(changedLocal)).not.toBe(bytesToHex(base));
  });

  it('binds the ISK (a different session key changes the tag)', () => {
    const other = new Uint8Array(64).map((_, i) => (i * 7 + 4) & 0xff);
    const t1 = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    const t2 = makeConfirmation(other, FP_A, FP_B, 'initiator');
    expect(bytesToHex(t1)).not.toBe(bytesToHex(t2));
  });

  it('rejects a forged / tampered tag', () => {
    const tag = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    const tampered = tag.slice();
    tampered[0] ^= 0x01;
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'initiator', tampered)).toBe(false);
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'initiator', new Uint8Array(32))).toBe(false);
  });

  it('uses a canonical fingerprint order (peers labelling local/remote oppositely agree)', () => {
    // Initiator sees (local=A, remote=B); responder sees (local=B, remote=A).
    // For the SAME role label the tags must match thanks to canonical ordering.
    const fromInitiatorView = makeConfirmation(ISK, FP_A, FP_B, 'responder');
    const fromResponderView = makeConfirmation(ISK, FP_B, FP_A, 'responder');
    expect(bytesToHex(fromInitiatorView)).toBe(bytesToHex(fromResponderView));
  });

  it('completes a mutual confirmation between initiator and responder', () => {
    // Initiator: local=A, remote=B, role=initiator.
    const tagInitiator = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    // Responder: local=B, remote=A, role=responder.
    const tagResponder = makeConfirmation(ISK, FP_B, FP_A, 'responder');

    // Each side verifies the other's tag using the peer's role.
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'responder', tagResponder)).toBe(true);
    expect(verifyConfirmation(ISK, FP_B, FP_A, 'initiator', tagInitiator)).toBe(true);
  });

  it('defeats reflection: a tag echoed back fails under the expected peer role', () => {
    // Initiator makes its tag (role=initiator) and sends it. An attacker reflects
    // it back to the initiator, who expects the responder's tag (role=responder).
    const tagInitiator = makeConfirmation(ISK, FP_A, FP_B, 'initiator');
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'responder', tagInitiator)).toBe(false);
    // Sanity: it only verifies under its own role label.
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'initiator', tagInitiator)).toBe(true);
  });

  // Cheap MITM coverage: this is the whole point of binding the tag to the DTLS fingerprints.
  // A man-in-the-middle terminates DTLS on each leg, so A and B end up validating against
  // DIFFERENT certificates — their (local, remote) fingerprint PAIRS diverge — even if (worst
  // case) the same ISK were somehow shared. The confirmation must then fail on both sides.
  it('rejects when the two sides hold DIFFERENT fingerprint pairs under the SAME ISK (MITM)', () => {
    const FP_M = 'sha-256 99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA'; // the MITM's cert

    // A's honest leg validates the MITM's cert as "remote"; B's honest leg likewise. The two
    // pairs are {FP_A, FP_M} and {FP_B, FP_M} — and FP_A ≠ FP_B, so the pairs differ.
    const tagA = makeConfirmation(ISK, FP_A, FP_M, 'initiator'); // A: local=FP_A, remote=FP_M
    const tagB = makeConfirmation(ISK, FP_B, FP_M, 'responder'); // B: local=FP_B, remote=FP_M

    // Each verifies the other's tag against ITS OWN observed pair → mismatch → reject.
    expect(verifyConfirmation(ISK, FP_B, FP_M, 'initiator', tagA)).toBe(false); // B checks A's tag
    expect(verifyConfirmation(ISK, FP_A, FP_M, 'responder', tagB)).toBe(false); // A checks B's tag
  });

  it('accepts when the two sides hold the SAME fingerprint pair (no MITM, honest channel)', () => {
    // Control for the MITM case: identical {FP_A, FP_B} pair on both sides ⇒ both tags verify.
    const tagA = makeConfirmation(ISK, FP_A, FP_B, 'initiator'); // A: local=FP_A, remote=FP_B
    const tagB = makeConfirmation(ISK, FP_B, FP_A, 'responder'); // B: local=FP_B, remote=FP_A
    expect(verifyConfirmation(ISK, FP_B, FP_A, 'initiator', tagA)).toBe(true);
    expect(verifyConfirmation(ISK, FP_A, FP_B, 'responder', tagB)).toBe(true);
  });
});

/**
 * link / qr method (step 5b): the SAME construction, fed the high-entropy URL-fragment secret S
 * (LINK domain) instead of the CPace ISK (CPACE domain). The default domain is the CPace one, so
 * the words tags are unchanged; these cases prove the link domain works AND is independent.
 */
describe('key confirmation — link/qr domain over the URL-fragment secret S', () => {
  const S = new Uint8Array(16).map((_, i) => (i * 13 + 5) & 0xff); // a 16-byte fixture secret

  it('the default domain is the CPace/words domain (words tags unchanged)', () => {
    const dflt = makeConfirmation(S, FP_A, FP_B, 'initiator');
    const explicit = makeConfirmation(S, FP_A, FP_B, 'initiator', CPACE_CONFIRM_DOMAIN);
    expect(bytesToHex(dflt)).toBe(bytesToHex(explicit));
  });

  it('binds the fingerprints under the link domain (a MITM with different certs is rejected)', () => {
    const FP_M = 'sha-256 99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA';
    // Honest channel: same pair on both sides ⇒ both tags verify under the link domain.
    const tagA = makeConfirmation(S, FP_A, FP_B, 'initiator', LINK_CONFIRM_DOMAIN);
    const tagB = makeConfirmation(S, FP_B, FP_A, 'responder', LINK_CONFIRM_DOMAIN);
    expect(verifyConfirmation(S, FP_B, FP_A, 'initiator', tagA, LINK_CONFIRM_DOMAIN)).toBe(true);
    expect(verifyConfirmation(S, FP_A, FP_B, 'responder', tagB, LINK_CONFIRM_DOMAIN)).toBe(true);
    // MITM: the two legs see different fingerprint pairs ({FP_A,FP_M} vs {FP_B,FP_M}) → reject.
    const mitmA = makeConfirmation(S, FP_A, FP_M, 'initiator', LINK_CONFIRM_DOMAIN);
    expect(verifyConfirmation(S, FP_B, FP_M, 'initiator', mitmA, LINK_CONFIRM_DOMAIN)).toBe(false);
  });

  it('a wrong / absent secret S fails (no offline-guess shortcut — divergent confirmation keys)', () => {
    const wrong = new Uint8Array(16).map((_, i) => (i * 13 + 6) & 0xff);
    const tag = makeConfirmation(S, FP_A, FP_B, 'initiator', LINK_CONFIRM_DOMAIN);
    expect(verifyConfirmation(wrong, FP_A, FP_B, 'initiator', tag, LINK_CONFIRM_DOMAIN)).toBe(false);
  });

  it('is domain-separated from the words path (same S + fps ⇒ different tag per domain)', () => {
    const link = makeConfirmation(S, FP_A, FP_B, 'initiator', LINK_CONFIRM_DOMAIN);
    const cpace = makeConfirmation(S, FP_A, FP_B, 'initiator', CPACE_CONFIRM_DOMAIN);
    expect(bytesToHex(link)).not.toBe(bytesToHex(cpace));
    // …and a tag from one domain never verifies under the other.
    expect(verifyConfirmation(S, FP_A, FP_B, 'initiator', link, CPACE_CONFIRM_DOMAIN)).toBe(false);
    expect(verifyConfirmation(S, FP_A, FP_B, 'initiator', cpace, LINK_CONFIRM_DOMAIN)).toBe(false);
  });
});
