import { describe, it, expect } from 'vitest';
import { checkNat, judgeNat, parseCandidate, type Candidate } from './natCheck';

/**
 * The decision policy. The part that talks to WebRTC was measured in three engines against two STUN
 * servers that answer one socket with two different ports (the header of natCheck.ts has the
 * figures) and runs for real in tests/e2e/nat-check.spec.ts; the candidate lines below are the ones
 * those runs produced.
 */
const HOST = 'candidate:1552981478 1 udp 2113937151 e4da16af-2ff9-4e19-8f4b-49e41e86a5de.local 56944 typ host generation 0 ufrag y5hk network-cost 999';
const SRFLX_A = 'candidate:3375607070 1 udp 1677729535 203.0.113.7 56944 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag y5hk network-cost 999';
const SRFLX_B = 'candidate:3375607070 1 udp 1677729535 203.0.113.7 56945 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag y5hk network-cost 999';
const FIREFOX_HOST = 'candidate:0 1 UDP 2122187007 b3a4c2fe-bf6d-41cd-87a3-a92aa3e58065.local 59284 typ host';
const FIREFOX_OTHER_HOST = 'candidate:2 1 UDP 2122252543 6bdc4b6c-6719-413c-a108-d3bf48acd4d8.local 64279 typ host';
const FIREFOX_A = 'candidate:1 1 UDP 1685987327 203.0.113.7 59284 typ srflx raddr 0.0.0.0 rport 0';
const FIREFOX_B = 'candidate:1 1 UDP 1685987071 203.0.113.7 59285 typ srflx raddr 0.0.0.0 rport 0';
const IPV6 = 'candidate:2987080936 1 udp 1677732095 2001:DB8::7 56352 typ srflx raddr :: rport 0 generation 0';

const seen = (...lines: string[]): Candidate[] => lines.map((l) => parseCandidate(l)!);
/** A host candidate as `getStats()` lists it: a foundation and a port, no address. */
const socket = (foundation: string, port: number): Candidate => ({ type: 'host', foundation, address: '', port });
const mapped = (foundation: string, port: number): Candidate => ({ type: 'srflx', foundation, address: '203.0.113.7', port });

describe('parseCandidate', () => {
  it('reads a srflx line from Chromium / WebKit and from Firefox', () => {
    expect(parseCandidate(SRFLX_A)).toEqual({ type: 'srflx', foundation: '3375607070', address: '203.0.113.7', port: 56944 });
    expect(parseCandidate(FIREFOX_B)).toEqual({ type: 'srflx', foundation: '1', address: '203.0.113.7', port: 59285 });
  });

  it('reads a host line: the foundation and the port are what count sockets', () => {
    expect(parseCandidate(HOST)).toMatchObject({ type: 'host', foundation: '1552981478', port: 56944 });
    expect(parseCandidate(FIREFOX_HOST)).toMatchObject({ type: 'host', foundation: '0', port: 59284 });
  });

  it('accepts the SDP form and lower-cases an IPv6 address', () => {
    expect(parseCandidate(`a=${IPV6}`)).toEqual({ type: 'srflx', foundation: '2987080936', address: '2001:db8::7', port: 56352 });
  });

  it('is null for relay, TCP and anything that is not a candidate', () => {
    expect(parseCandidate('candidate:2 1 udp 41885439 198.51.100.9 49170 typ relay raddr 203.0.113.7 rport 5')).toBeNull();
    expect(parseCandidate('candidate:3 1 tcp 1518280447 203.0.113.7 9 typ srflx tcptype active')).toBeNull();
    expect(parseCandidate('candidate:3 1 TCP 2105458943 b3a4c2fe.local 9 typ host tcptype active')).toBeNull();
    expect(parseCandidate('')).toBeNull();
    expect(parseCandidate(null)).toBeNull();
  });
});

describe('judgeNat', () => {
  it('two mappings of one socket is `symmetric` — in Chromium / WebKit and in Firefox', () => {
    expect(judgeNat(seen(HOST, SRFLX_A, SRFLX_B), []).verdict).toBe('symmetric');
    expect(judgeNat(seen(FIREFOX_HOST, FIREFOX_OTHER_HOST, FIREFOX_A, FIREFOX_B), []).verdict).toBe('symmetric');
  });

  it('`symmetric` does not wait for the per-server answers: two mappings prove two answers', () => {
    expect(judgeNat(seen(HOST, SRFLX_A, SRFLX_B), [true, false]).verdict).toBe('symmetric');
  });

  it('a different ADDRESS for the same socket is `symmetric` too', () => {
    const other = { ...parseCandidate(SRFLX_A)!, address: '198.51.100.9' };
    expect(judgeNat([...seen(HOST, SRFLX_A), other], []).verdict).toBe('symmetric');
  });

  it('one socket, one mapping, both servers answering is `direct`', () => {
    expect(judgeNat(seen(HOST, SRFLX_A), [true, true]).verdict).toBe('direct');
  });

  it('one mapping with a silent server is `unknown`, NOT `direct` — nothing was compared', () => {
    expect(judgeNat(seen(HOST, SRFLX_A), [true, false]).verdict).toBe('unknown');
    expect(judgeNat(seen(HOST, SRFLX_A), [false, true]).verdict).toBe('unknown');
    expect(judgeNat(seen(HOST, SRFLX_A), []).verdict).toBe('unknown');
    expect(judgeNat(seen(HOST, SRFLX_A), [true]).verdict).toBe('unknown');
  });

  it('no mapping at all is `unknown`, whatever the servers answered elsewhere', () => {
    expect(judgeNat(seen(HOST), [true, true]).verdict).toBe('unknown');
    expect(judgeNat([], [false, false]).verdict).toBe('unknown');
  });

  // WebKit, measured 2026-11-22: three connections started together, an HONEST pair of servers, and
  // one connection reported three sockets and three mappings on one base.
  it('re-gathered sockets on one base are NOT `symmetric`: as many mappings as sockets', () => {
    const webkit = [
      socket('3869500916', 63932),
      socket('3869500916', 52470),
      socket('3869500916', 61692),
      socket('3614344494', 65185),
      mapped('3830633856', 63932),
      mapped('3830633856', 52470),
      mapped('3830633856', 61692),
    ];
    expect(judgeNat(webkit, []).verdict).toBe('unknown');
    // …and not `direct` either: with several sockets a lost answer could hide a second mapping.
    expect(judgeNat(webkit, [true, true]).verdict).toBe('unknown');
  });

  it('re-gathered sockets behind a symmetric NAT still read `symmetric`: more mappings than sockets', () => {
    const webkit = [
      socket('3869500916', 63932),
      socket('3869500916', 52470),
      mapped('3830633856', 40001),
      mapped('3830633856', 40002),
      mapped('3830633856', 40003),
    ];
    expect(judgeNat(webkit, []).verdict).toBe('symmetric');
  });

  it('two mappings with no visible socket is `unknown` — nothing to count them against', () => {
    expect(judgeNat(seen(SRFLX_A, SRFLX_B), [true, true]).verdict).toBe('unknown');
  });

  it('two interfaces behind one NAT are not `symmetric`: one socket and one mapping each', () => {
    const two = [socket('10', 5000), socket('20', 5001), mapped('11', 40001), mapped('21', 40002)];
    expect(judgeNat(two, [true, true]).verdict).toBe('direct');
  });

  it('the same socket and mapping reported twice (the event and the stats) count once', () => {
    expect(judgeNat([...seen(HOST, SRFLX_A, SRFLX_A), socket('1552981478', 56944)], [true, true]).verdict).toBe('direct');
  });

  it('IPv6 is noted and never compared', () => {
    expect(judgeNat(seen(HOST, SRFLX_A, IPV6), [true, true])).toEqual({ verdict: 'direct', ipv6: true });
    expect(judgeNat(seen(HOST, SRFLX_A, SRFLX_B, IPV6), [])).toEqual({ verdict: 'symmetric', ipv6: true });
    // IPv6 alone: the IPv4 mapping was never seen.
    expect(judgeNat(seen(HOST, IPV6), [true, true])).toEqual({ verdict: 'unknown', ipv6: true });
    // Two IPv6 answers that differ in port are not a NAT mapping.
    const again = { ...parseCandidate(IPV6)!, port: 56353 };
    expect(judgeNat([...seen(HOST, IPV6), again], [true, true]).verdict).toBe('unknown');
  });

  it('a unique-local or link-local IPv6 answer is not usable IPv6', () => {
    const ula: Candidate = { type: 'srflx', foundation: '9', address: 'fdbb:fe03::1', port: 5 };
    const linkLocal: Candidate = { type: 'srflx', foundation: '9', address: 'fe80::1', port: 5 };
    expect(judgeNat([ula, linkLocal], [true, true]).ipv6).toBe(false);
  });
});

describe('checkNat', () => {
  it('is `unknown` without contacting anything when there are not two destinations', async () => {
    expect(await checkNat([])).toEqual({ verdict: 'unknown', ipv6: false });
    expect(await checkNat(['stun:a.example:3479'])).toEqual({ verdict: 'unknown', ipv6: false });
    expect(await checkNat(['stun:a.example:3479', ''])).toEqual({ verdict: 'unknown', ipv6: false });
  });

  it('is `unknown` where there is no WebRTC (this test runs under Node)', async () => {
    expect(await checkNat(['stun:a.example:3479', 'stun:b.example:3478'])).toEqual({ verdict: 'unknown', ipv6: false });
  });
});
