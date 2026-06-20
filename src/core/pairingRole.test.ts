import { describe, it, expect } from 'vitest';
import { pairingRoleFor } from './pairingRole';
import { sasRoleFor } from './sasRole';
import type { ConfirmationRole } from './crypto/keyConfirmation';

/**
 * The per-pairing transport/crypto role split. The room is a mesh LOBBY where any pair may raise a
 * 1:1 channel — including joiner↔joiner — so the role can NOT be "creator = initiator". It is fixed
 * from the two readable ids: lexicographically smaller id = initiator, the other = responder. These
 * pin:
 *   - the ordering (smaller id initiates);
 *   - that BOTH sides of a pair compute opposite roles (so every pair has exactly one initiator + one
 *     responder, even when neither is the creator — the joiner↔joiner case the old rule deadlocked);
 *   - fail-closed: a missing id yields `null`, which the controller treats as a hard fail rather than
 *     defaulting a side (defaulting could land both on the same role and deadlock again);
 *   - agreement with `sasRoleFor`: the same id ordering, so the initiator is also the SAS reader.
 */
describe('pairingRoleFor', () => {
  it('makes the lexicographically smaller readable id the initiator', () => {
    expect(pairingRoleFor('alpha-fox', 'zeta-owl')).toBe('initiator');
    expect(pairingRoleFor('zeta-owl', 'alpha-fox')).toBe('responder');
    // boundary: equal prefix, differing suffix
    expect(pairingRoleFor('brave-otter', 'brave-otter-9')).toBe('initiator');
    expect(pairingRoleFor('brave-otter-9', 'brave-otter')).toBe('responder');
  });

  it('gives the two sides of a pair OPPOSITE roles (exactly one initiator + one responder)', () => {
    const a = 'calm-lynx';
    const b = 'witty-heron';
    const roleA = pairingRoleFor(a, b); // A computes from (self=a, peer=b)
    const roleB = pairingRoleFor(b, a); // B computes from (self=b, peer=a)
    expect(roleA).not.toBeNull();
    expect(roleB).not.toBeNull();
    expect(roleA).not.toBe(roleB);
    expect([roleA, roleB].filter((r) => r === 'initiator')).toHaveLength(1);
    expect([roleA, roleB].filter((r) => r === 'responder')).toHaveLength(1);
  });

  it('works for a joiner↔joiner pair — never two responders (the deadlock the old create/join rule had)', () => {
    // The old bug: with create/join roles BOTH joiners were `responder` → nobody offers and the SAS
    // commit-reveal deadlocks. From ids alone the pair still resolves to one initiator + one
    // responder, deterministically, on both sides.
    for (const [x, y] of [
      ['joiner-aardvark', 'joiner-zebra'],
      ['nimble-newt', 'plucky-puffin'],
      ['swift-stoat', 'swift-stork'],
    ] as const) {
      const rx = pairingRoleFor(x, y);
      const ry = pairingRoleFor(y, x);
      expect(new Set([rx, ry])).toEqual(new Set(['initiator', 'responder']));
    }
  });

  it('agrees with sasRoleFor ordering on every pair (initiator = reader, responder = picker)', () => {
    // The transport role and the SAS UI role share the SAME id ordering on purpose, so the side that
    // offers/reveals-after is also the side that reads its phrase aloud.
    for (const [x, y] of [
      ['alpha-fox', 'zeta-owl'],
      ['nimble-newt', 'plucky-puffin'],
      ['swift-stoat', 'swift-stork'],
    ] as const) {
      expect(pairingRoleFor(x, y) === 'initiator').toBe(sasRoleFor(x, y) === 'reader');
      expect(pairingRoleFor(y, x) === 'initiator').toBe(sasRoleFor(y, x) === 'reader');
    }
  });

  it('FAILS CLOSED to null when an id is missing (caller must never default a side)', () => {
    expect(pairingRoleFor(null, 'zeta-owl')).toBeNull();
    expect(pairingRoleFor('alpha-fox', null)).toBeNull();
    expect(pairingRoleFor(null, null)).toBeNull();
    expect(pairingRoleFor(undefined, 'alpha-fox')).toBeNull();
    expect(pairingRoleFor('', 'alpha-fox')).toBeNull();
    // degenerate equal ids (impossible in a real room — ids are unique) also fail closed
    expect(pairingRoleFor('same-id', 'same-id')).toBeNull();
  });
});

/**
 * Harness test: the crypto handshakes that have a role-ordering dependency must REACH THE END for a
 * joiner↔joiner pair (the case the old "creator = initiator" rule deadlocked), and must do so with a
 * DETERMINATE one-initiator/one-responder split. We model the two ordering-sensitive handshakes
 * exactly as SessionController drives them — the SAS commit-reveal (`onSasSignal`) and the CPace +
 * WebRTC-offer kickoff — purely from the per-pairing roles, and run them to quiescence. This proves
 * the role assignment removes the deadlock without re-running a full WebRTC stack.
 */

type SasMsg = { kind: 'commit'; from: 0 | 1 } | { kind: 'nonce'; from: 0 | 1 };

interface SasSide {
  role: ConfirmationRole;
  /** the peer committed (initiator only consumes a commit). */
  peerCommitted: boolean;
  /** we already revealed our own nonce. */
  revealedMine: boolean;
  /** we received the peer's revealed nonce. */
  havePeerNonce: boolean;
}

/**
 * Mirror of SessionController.onSasSignal's ordering, role-driven:
 *   - the RESPONDER commits first (emitted at pairing start);
 *   - the INITIATOR reveals its nonce upon receiving a commit;
 *   - the RESPONDER reveals its nonce only after the initiator's reveal arrives.
 * Returns the messages this side emits in response to `msg` (undefined `msg` = the pairing-start
 * kickoff, where a responder emits its commit).
 */
function sasStep(side: SasSide, self: 0 | 1, msg?: SasMsg): SasMsg[] {
  const out: SasMsg[] = [];
  if (!msg) {
    if (side.role === 'responder') out.push({ kind: 'commit', from: self });
    return out;
  }
  if (msg.kind === 'commit') {
    if (side.role === 'initiator' && !side.peerCommitted) {
      side.peerCommitted = true;
      side.revealedMine = true;
      out.push({ kind: 'nonce', from: self });
    }
    return out;
  }
  // a revealed nonce from the peer
  side.havePeerNonce = true;
  if (side.role === 'responder' && !side.revealedMine) {
    side.revealedMine = true;
    out.push({ kind: 'nonce', from: self });
  }
  return out;
}

/** Run the commit-reveal between two role-driven sides to quiescence (a bounded queue, so a deadlock
 *  simply drains to empty without both sides ever holding the peer nonce). */
function runSasHandshake(roleA: ConfirmationRole, roleB: ConfirmationRole): { a: SasSide; b: SasSide } {
  const a: SasSide = { role: roleA, peerCommitted: false, revealedMine: false, havePeerNonce: false };
  const b: SasSide = { role: roleB, peerCommitted: false, revealedMine: false, havePeerNonce: false };
  const sides = [a, b] as const;
  // Kickoff: each side emits whatever it sends at pairing start, addressed to the other.
  const queue: { to: 0 | 1; msg: SasMsg }[] = [];
  for (const self of [0, 1] as const) {
    for (const m of sasStep(sides[self], self)) queue.push({ to: (1 - self) as 0 | 1, msg: m });
  }
  let guard = 0;
  while (queue.length && guard++ < 100) {
    const { to, msg } = queue.shift()!;
    for (const m of sasStep(sides[to], to, msg)) queue.push({ to: (1 - to) as 0 | 1, msg: m });
  }
  return { a, b };
}

describe('joiner↔joiner crypto handshake reaches the end (no "both responder" deadlock)', () => {
  it('SAS commit-reveal completes: both sides end up holding the peer nonce', () => {
    const a = 'joiner-aardvark';
    const b = 'joiner-zebra';
    const roleA = pairingRoleFor(a, b)!;
    const roleB = pairingRoleFor(b, a)!;
    const { a: sideA, b: sideB } = runSasHandshake(roleA, roleB);
    // Both have the peer's nonce ⇒ both can compute the SAS triple ⇒ the comparison can proceed.
    expect(sideA.havePeerNonce).toBe(true);
    expect(sideB.havePeerNonce).toBe(true);
  });

  it('the OLD create/join rule (both joiners → both responder) is exactly what deadlocks', () => {
    // Regression guard: drive the SAME simulation with the broken assignment and show it hangs
    // (neither side ever reveals, so neither holds the peer nonce).
    const { a, b } = runSasHandshake('responder', 'responder');
    expect(a.havePeerNonce).toBe(false);
    expect(b.havePeerNonce).toBe(false);
  });

  it('exactly one side sends the WebRTC offer / the CPace first frame (no glare, no stall)', () => {
    // The WebRTC offer and the CPace `sid` frame are both sent by the `initiator`. For ANY pair the
    // id split yields exactly one initiator, so exactly one offer/first-frame is sent — no glare
    // (two offers) and no stall (zero offers).
    for (const [x, y] of [
      ['joiner-aardvark', 'joiner-zebra'],
      ['calm-lynx', 'witty-heron'],
      ['swift-stoat', 'swift-stork'],
    ] as const) {
      const initiators = [pairingRoleFor(x, y), pairingRoleFor(y, x)].filter((r) => r === 'initiator');
      expect(initiators).toHaveLength(1);
    }
  });
});
