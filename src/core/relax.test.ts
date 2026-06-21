import { describe, it, expect } from 'vitest';
import { isRelayCandidate, shouldDropCandidate } from './relax';

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
