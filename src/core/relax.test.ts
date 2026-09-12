import { describe, it, expect } from 'vitest';
import {
  endpointKey,
  isForbiddenRemoteCandidate,
  isRelayCandidate,
  relayCandidateEndpoint,
  selectedRemoteCandidate,
  shouldDropCandidate,
  type StatsEntry,
} from './relax';

/**
 * The Max-privacy STRICT relay filter (step 6d): the relay-candidate predicate. In Max-privacy the
 * PeerConnection drops the peer's TURN-relay candidates (and never requests local TURN), so we are
 * NEVER relayed — a direct connection that can't come up fails terminally (no consent escalation). In
 * Reliable the filter is off (relay allowed).
 */

const HOST = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 51556 typ host generation 0' };
const SRFLX = { candidate: 'candidate:2 1 udp 1686052607 203.0.113.7 51556 typ srflx raddr 192.168.1.5 rport 51556' };
const RELAY = { candidate: 'candidate:3 1 udp 41885439 198.51.100.9 60000 typ relay raddr 203.0.113.7 rport 51556' };

describe('relay-candidate filter (Max-privacy strict model)', () => {
  it('isRelayCandidate matches ONLY `typ relay` candidates', () => {
    expect(isRelayCandidate(RELAY)).toBe(true);
    expect(isRelayCandidate(HOST)).toBe(false);
    expect(isRelayCandidate(SRFLX)).toBe(false);
    // `relay` must be the candidate TYPE, not just any substring (e.g. a host named "relay.local").
    expect(isRelayCandidate({ candidate: 'candidate:9 1 udp 1 relay.example 5000 typ host' })).toBe(false);
  });

  it('isRelayCandidate is safe on empty / null / missing candidate strings (end-of-candidates marker)', () => {
    expect(isRelayCandidate({ candidate: '' })).toBe(false);
    expect(isRelayCandidate({ candidate: null })).toBe(false);
    expect(isRelayCandidate(null)).toBe(false);
    expect(isRelayCandidate(undefined)).toBe(false);
  });

  it('Max-privacy (filtering on) DROPS a relay candidate but keeps host/srflx', () => {
    expect(shouldDropCandidate(true, RELAY)).toBe(true);
    expect(shouldDropCandidate(true, HOST)).toBe(false);
    expect(shouldDropCandidate(true, SRFLX)).toBe(false);
  });

  it('Reliable (filtering off) ACCEPTS every candidate, including relay', () => {
    expect(shouldDropCandidate(false, RELAY)).toBe(false);
    expect(shouldDropCandidate(false, HOST)).toBe(false);
    expect(shouldDropCandidate(false, SRFLX)).toBe(false);
  });
});

/**
 * Mechanism 3 (audit 2026-09-12): dropping the peer's SIGNALLED relay candidates does not stop ICE
 * from LEARNING the same endpoint as a peer-reflexive candidate from the peer's connectivity checks,
 * so the selected pair is verified at channel-open. These cover the two pure halves of that check.
 */

const RELAY_V6 = {
  candidate: 'candidate:4 1 udp 41885439 2001:DB8::A1 60001 typ relay raddr 2001:db8::5 rport 51556',
};
const DROPPED = new Set(['198.51.100.9|60000']);

describe('relayCandidateEndpoint / endpointKey', () => {
  it('extracts address|port from a relay candidate only', () => {
    expect(relayCandidateEndpoint(RELAY)).toBe('198.51.100.9|60000');
    expect(relayCandidateEndpoint(HOST)).toBeNull();
    expect(relayCandidateEndpoint(SRFLX)).toBeNull();
  });

  it('lower-cases the address (IPv6 hex casing is not significant) and accepts an `a=` prefix', () => {
    expect(relayCandidateEndpoint(RELAY_V6)).toBe('2001:db8::a1|60001');
    expect(relayCandidateEndpoint({ candidate: `a=${RELAY.candidate}` })).toBe('198.51.100.9|60000');
  });

  it('is safe on empty / null / malformed candidates', () => {
    expect(relayCandidateEndpoint({ candidate: '' })).toBeNull();
    expect(relayCandidateEndpoint({ candidate: null })).toBeNull();
    expect(relayCandidateEndpoint(null)).toBeNull();
    expect(relayCandidateEndpoint({ candidate: 'candidate:bogus typ relay' })).toBeNull();
  });

  it('endpointKey needs both halves', () => {
    expect(endpointKey('203.0.113.7', 51556)).toBe('203.0.113.7|51556');
    expect(endpointKey('203.0.113.7', null)).toBeNull();
    expect(endpointKey(null, 51556)).toBeNull();
    expect(endpointKey('203.0.113.7', 0)).toBe('203.0.113.7|0'); // port 0 is a value, not "missing"
  });
});

describe('isForbiddenRemoteCandidate (the path we actually got)', () => {
  it('refuses a remote candidate typed relay', () => {
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'relay', address: '198.51.100.9', port: 60000 }, new Set())).toBe(true);
  });

  it('refuses a PEER-REFLEXIVE candidate whose endpoint we dropped as relay (the bypass)', () => {
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'prflx', address: '198.51.100.9', port: 60000 }, DROPPED)).toBe(true);
    // Firefox has reported the address under `ip` — same verdict.
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'prflx', ip: '198.51.100.9', port: 60000 }, DROPPED)).toBe(true);
  });

  it('ALLOWS a peer-reflexive candidate we never dropped (legitimate NAT mapping on a direct path)', () => {
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'prflx', address: '203.0.113.7', port: 51556 }, DROPPED)).toBe(false);
  });

  it('allows plain direct paths, and allows everything in Reliable (filtering off)', () => {
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'host', address: '192.168.1.5', port: 51556 }, DROPPED)).toBe(false);
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'srflx', address: '203.0.113.7', port: 51556 }, DROPPED)).toBe(false);
    expect(isForbiddenRemoteCandidate(false, { candidateType: 'relay', address: '198.51.100.9', port: 60000 }, DROPPED)).toBe(false);
    expect(isForbiddenRemoteCandidate(true, null, DROPPED)).toBe(false);
  });
});

describe('selectedRemoteCandidate (getStats shapes)', () => {
  const remote = (id: string, candidateType: string, address: string, port: number): StatsEntry => ({
    id,
    type: 'remote-candidate',
    candidateType,
    address,
    port,
  });

  it('follows the transport`s selectedCandidatePairId (the standard / Chromium shape)', () => {
    const entries: StatsEntry[] = [
      { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
      { id: 'P1', type: 'candidate-pair', state: 'succeeded', remoteCandidateId: 'R1' },
      { id: 'P2', type: 'candidate-pair', state: 'succeeded', remoteCandidateId: 'R2' },
      remote('R1', 'host', '192.168.1.5', 51556),
      remote('R2', 'prflx', '198.51.100.9', 60000),
    ];
    expect(selectedRemoteCandidate(entries)).toMatchObject({ candidateType: 'prflx', address: '198.51.100.9' });
  });

  it('falls back to a pair flagged `selected` (Firefox), then nominated+succeeded, then succeeded', () => {
    const ff: StatsEntry[] = [
      { id: 'P1', type: 'candidate-pair', state: 'succeeded', remoteCandidateId: 'R1' },
      { id: 'P2', type: 'candidate-pair', selected: true, state: 'succeeded', remoteCandidateId: 'R2' },
      remote('R1', 'host', '192.168.1.5', 51556),
      remote('R2', 'relay', '198.51.100.9', 60000),
    ];
    expect(selectedRemoteCandidate(ff)).toMatchObject({ candidateType: 'relay' });

    const nominated: StatsEntry[] = [
      { id: 'P1', type: 'candidate-pair', state: 'in-progress', remoteCandidateId: 'R1' },
      { id: 'P2', type: 'candidate-pair', nominated: true, state: 'succeeded', remoteCandidateId: 'R2' },
      remote('R1', 'host', '192.168.1.5', 51556),
      remote('R2', 'srflx', '203.0.113.7', 51556),
    ];
    expect(selectedRemoteCandidate(nominated)).toMatchObject({ candidateType: 'srflx' });

    const succeededOnly: StatsEntry[] = [
      { id: 'P1', type: 'candidate-pair', state: 'succeeded', remoteCandidateId: 'R1' },
      remote('R1', 'host', '192.168.1.5', 51556),
    ];
    expect(selectedRemoteCandidate(succeededOnly)).toMatchObject({ candidateType: 'host' });
  });

  it('returns null when nothing is selected or the remote record is missing — "unknown", not "safe"', () => {
    expect(selectedRemoteCandidate([])).toBeNull();
    expect(
      selectedRemoteCandidate([{ id: 'P1', type: 'candidate-pair', state: 'in-progress', remoteCandidateId: 'R1' }]),
    ).toBeNull();
    expect(
      selectedRemoteCandidate([{ id: 'P1', type: 'candidate-pair', state: 'succeeded', remoteCandidateId: 'GONE' }]),
    ).toBeNull();
    // ...and "unknown" must not be read as a relay by the caller:
    expect(isForbiddenRemoteCandidate(true, selectedRemoteCandidate([]), DROPPED)).toBe(false);
  });
});
