import { describe, it, expect } from 'vitest';
import { compareStunViews, probeStunViews } from './stunCheck';

/**
 * The comparison policy. The part that talks to WebRTC is exercised by e2e; this pins the decisions
 * that matter — above all that "cannot tell" and "they disagree" stay different answers, the mistake
 * that had to be undone for the path-attestation verdict (F2).
 */
describe('compareStunViews', () => {
  const v = (url: string, address: string | null) => ({ url, address });

  it('two servers agreeing is `agree`', () => {
    const r = compareStunViews([v('stun:a', '203.0.113.7'), v('stun:b', '203.0.113.7')]);
    expect(r.verdict).toBe('agree');
    expect(r.addresses).toEqual(['203.0.113.7']);
  });

  it('two servers disagreeing is `disagree`, and BOTH addresses are kept for the human', () => {
    const r = compareStunViews([v('stun:a', '203.0.113.7'), v('stun:b', '198.51.100.9')]);
    expect(r.verdict).toBe('disagree');
    expect(r.addresses).toEqual(['203.0.113.7', '198.51.100.9']);
  });

  it('one answer is `unknown`, NOT `agree` — a single operator cross-checks nothing', () => {
    expect(compareStunViews([v('stun:a', '203.0.113.7')]).verdict).toBe('unknown');
    expect(compareStunViews([v('stun:a', '203.0.113.7'), v('stun:b', null)]).verdict).toBe('unknown');
  });

  it('no answers is `unknown`, never a failure', () => {
    expect(compareStunViews([v('stun:a', null), v('stun:b', null)]).verdict).toBe('unknown');
    expect(compareStunViews([]).verdict).toBe('unknown');
  });

  it('ignores mDNS names and blanks — they are not answers about a public address', () => {
    const r = compareStunViews([v('stun:a', 'e4f2.local'), v('stun:b', '  '), v('stun:c', '203.0.113.7')]);
    expect(r.verdict).toBe('unknown'); // only one real answer survives
    expect(r.addresses).toEqual(['203.0.113.7']);
  });

  it('IPv6 casing is not a disagreement', () => {
    const r = compareStunViews([v('stun:a', '2001:DB8::1'), v('stun:b', '2001:db8::1')]);
    expect(r.verdict).toBe('agree');
  });

  it('three servers with one liar is a disagreement (the case the feature exists for)', () => {
    const r = compareStunViews([
      v('stun:honest-1', '203.0.113.7'),
      v('stun:honest-2', '203.0.113.7'),
      v('stun:liar', '198.51.100.9'),
    ]);
    expect(r.verdict).toBe('disagree');
    expect(r.addresses).toHaveLength(2);
  });

  it('probeStunViews short-circuits on fewer than two configured servers', async () => {
    // Must not touch WebRTC at all (there is none in this environment) — proving it returns early.
    await expect(probeStunViews(['stun:only-one'])).resolves.toEqual({
      verdict: 'unknown',
      addresses: [],
      answered: [],
    });
  });
});
