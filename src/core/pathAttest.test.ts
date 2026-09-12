import { describe, it, expect } from 'vitest';
import { localCandidateAddresses, normalizeAddress, pathVerdict, type StatsEntry } from './pathAttest';

/**
 * Path attestation closes the one thing candidate filtering provably cannot: a signaling server that
 * relays the SDP holds both sides' ICE credentials, so it can answer connectivity checks itself and
 * inject its own `typ host` candidate at its own address — and a client cannot tell that apart from
 * the peer's, because the peer's real address is only ever learned FROM the server. These pin the
 * two pure halves: what we attest to, and how a verdict is reached.
 */
const local = (address: string, extra: Record<string, unknown> = {}): StatsEntry => ({
  type: 'local-candidate',
  address,
  ...extra,
});

describe('localCandidateAddresses', () => {
  it('collects host and srflx addresses alike — the peer may have selected either', () => {
    const addrs = localCandidateAddresses([
      local('192.168.1.19', { candidateType: 'host' }),
      local('203.0.113.7', { candidateType: 'srflx' }),
      { type: 'remote-candidate', address: '198.51.100.9' },
      { type: 'transport', selectedCandidatePairId: 'p1' },
    ]);
    expect(addrs).toEqual(['192.168.1.19', '203.0.113.7']);
  });

  it("reads Firefox's `ip` when `address` is absent", () => {
    expect(localCandidateAddresses([{ type: 'local-candidate', ip: '10.0.0.4' }])).toEqual(['10.0.0.4']);
  });

  it('drops mDNS host candidates — `<uuid>.local` identifies nothing the peer could have selected', () => {
    const addrs = localCandidateAddresses([
      local('b3f1c2d4-0000-4a1b-9c3d-000000000000.local'),
      local('203.0.113.7'),
    ]);
    expect(addrs).toEqual(['203.0.113.7']);
  });

  it('dedupes, lower-cases IPv6, and caps the list', () => {
    expect(localCandidateAddresses([local('203.0.113.7'), local('203.0.113.7')])).toEqual(['203.0.113.7']);
    expect(localCandidateAddresses([local('2001:DB8::A1')])).toEqual(['2001:db8::a1']);
    expect(localCandidateAddresses([local('1.1.1.1'), local('2.2.2.2'), local('3.3.3.3')], 2)).toHaveLength(2);
  });

  it('returns an empty list rather than throwing on junk (stats shapes vary by engine)', () => {
    expect(localCandidateAddresses([{ type: 'local-candidate' }, { type: 'local-candidate', address: 42 }])).toEqual([]);
    expect(localCandidateAddresses([])).toEqual([]);
  });
});

describe('pathVerdict', () => {
  const PEER = ['192.168.1.19', '203.0.113.7'];

  it('ok when the address we selected is one the peer attested to', () => {
    expect(pathVerdict('203.0.113.7', PEER)).toBe('ok');
    expect(pathVerdict('192.168.1.19', PEER)).toBe('ok');
  });

  it('MISMATCH when it is not — this is the interposer', () => {
    // The server injected its own `typ host` candidate; the peer names only its real addresses.
    expect(pathVerdict('198.51.100.9', PEER)).toBe('mismatch');
  });

  it('compares the address only, never the port — honest NATs vary the port per destination', () => {
    // Both halves of the pair see the same IP; a port-varying NAT must not be called an attacker.
    expect(pathVerdict('203.0.113.7', ['203.0.113.7'])).toBe('ok');
  });

  it('is case- and whitespace-insensitive for IPv6', () => {
    expect(pathVerdict('2001:DB8::A1', [' 2001:db8::a1 '])).toBe('ok');
  });

  it('unknown — never mismatch — when there is nothing to judge on', () => {
    // A missing API must not tear down a working connection. The downgrade this would otherwise
    // open (drop the frame, never be judged) is closed by the deadline in SessionController.
    expect(pathVerdict(null, PEER)).toBe('unknown');
    expect(pathVerdict(undefined, PEER)).toBe('unknown');
    expect(pathVerdict('', PEER)).toBe('unknown');
    expect(pathVerdict('203.0.113.7', [])).toBe('unknown');
    expect(pathVerdict('203.0.113.7', null)).toBe('unknown');
    // a peer that could only offer mDNS names attests nothing comparable
    expect(pathVerdict('203.0.113.7', ['abc.local'])).toBe('unknown');
  });

  it('a peer that attests a DIFFERENT real address is still a mismatch, not unknown', () => {
    expect(pathVerdict('203.0.113.7', ['198.51.100.9'])).toBe('mismatch');
  });
});

describe('normalizeAddress', () => {
  it('trims and lower-cases so both peers compare identically', () => {
    expect(normalizeAddress('  2001:DB8::1  ')).toBe('2001:db8::1');
  });
});
