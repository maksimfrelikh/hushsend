import { describe, it, expect } from 'vitest';
import { sasRoleFor } from './sasRole';

/**
 * The per-pairing SAS reader/picker split. The room method is a mesh LOBBY where any pair may raise
 * a 1:1 channel — including joiner↔joiner — so the role can NOT be "creator = reader". It is fixed
 * from the two readable ids: lexicographically smaller id = reader, the other = picker. These pin:
 *   - the ordering (smaller id reads);
 *   - that BOTH sides of a pair compute opposite roles (so every pair has exactly one reader + one
 *     picker, even when neither is the creator — the joiner↔joiner case the old rule broke);
 *   - fail-closed: a missing id yields `null`, which the SAS screen renders as the restart screen,
 *     never a functional blind picker.
 */
describe('sasRoleFor', () => {
  it('makes the lexicographically smaller readable id the reader', () => {
    expect(sasRoleFor('alpha-fox', 'zeta-owl')).toBe('reader');
    expect(sasRoleFor('zeta-owl', 'alpha-fox')).toBe('picker');
    // boundary: equal prefix, differing suffix
    expect(sasRoleFor('brave-otter', 'brave-otter-9')).toBe('reader');
    expect(sasRoleFor('brave-otter-9', 'brave-otter')).toBe('picker');
  });

  it('gives the two sides of a pair OPPOSITE roles (exactly one reader + one picker)', () => {
    const a = 'calm-lynx';
    const b = 'witty-heron';
    const roleA = sasRoleFor(a, b); // A computes from (self=a, peer=b)
    const roleB = sasRoleFor(b, a); // B computes from (self=b, peer=a)
    expect(roleA).not.toBeNull();
    expect(roleB).not.toBeNull();
    expect(roleA).not.toBe(roleB);
    expect([roleA, roleB].filter((r) => r === 'reader')).toHaveLength(1);
    expect([roleA, roleB].filter((r) => r === 'picker')).toHaveLength(1);
  });

  it('works for a joiner↔joiner pair — never two pickers (the regression the old create/join rule had)', () => {
    // Both peers are joiners (neither is the creator). With ids alone, the pair still resolves to one
    // reader + one picker, deterministically, on both sides.
    for (const [x, y] of [
      ['joiner-aardvark', 'joiner-zebra'],
      ['nimble-newt', 'plucky-puffin'],
      ['swift-stoat', 'swift-stork'],
    ] as const) {
      const rx = sasRoleFor(x, y);
      const ry = sasRoleFor(y, x);
      expect(new Set([rx, ry])).toEqual(new Set(['reader', 'picker']));
    }
  });

  it('FAILS CLOSED to null when an id is missing (→ restart screen, never a functional picker)', () => {
    expect(sasRoleFor(null, 'zeta-owl')).toBeNull();
    expect(sasRoleFor('alpha-fox', null)).toBeNull();
    expect(sasRoleFor(null, null)).toBeNull();
    expect(sasRoleFor(undefined, 'alpha-fox')).toBeNull();
    expect(sasRoleFor('', 'alpha-fox')).toBeNull();
    // degenerate equal ids (impossible in a real room — ids are unique) also fail closed
    expect(sasRoleFor('same-id', 'same-id')).toBeNull();
  });
});
