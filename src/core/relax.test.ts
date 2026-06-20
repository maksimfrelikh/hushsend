import { describe, it, expect } from 'vitest';
import {
  newRelaxState,
  relaxOnIceFail,
  relaxOnLocal,
  relaxOnPeer,
  shouldRestartForRelay,
  isRelayCandidate,
  shouldDropCandidate,
} from './relax';

/**
 * The Max-privacy STRICT relax model (step 6d, relax-retry): the relay-candidate filter and the relax
 * state machine. The filter drops the peer's TURN-relay candidates while filtering (Max-privacy, not
 * relaxed) so we are never relayed without consent; the state machine gates the ICE restart on BOTH
 * sides having relaxed AND this side being the per-pairing initiator (self-enforcing bilateral relay).
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

  it('after relax / in Reliable (filtering off) ACCEPTS every candidate, including relay', () => {
    expect(shouldDropCandidate(false, RELAY)).toBe(false);
    expect(shouldDropCandidate(false, HOST)).toBe(false);
    expect(shouldDropCandidate(false, SRFLX)).toBe(false);
  });
});

describe('relax state machine', () => {
  it('starts inert (nothing offered, neither side relaxed)', () => {
    expect(newRelaxState()).toEqual({
      available: false,
      localRelaxed: false,
      peerRelaxed: false,
      iceFailed: false,
      restarted: false,
    });
  });

  it('relaxOnIceFail surfaces the offer; is idempotent; and is a no-op once we relaxed', () => {
    const failed = relaxOnIceFail(newRelaxState());
    expect(failed).toMatchObject({ available: true, iceFailed: true, localRelaxed: false });
    expect(relaxOnIceFail(failed)).toBe(failed); // idempotent — same reference
    const relaxed = relaxOnLocal(newRelaxState());
    expect(relaxOnIceFail(relaxed)).toBe(relaxed); // already relaxed → unchanged
  });

  it('relaxOnLocal marks us relaxed (and keeps the offer available); idempotent', () => {
    const s = relaxOnLocal(newRelaxState());
    expect(s).toMatchObject({ localRelaxed: true, available: true });
    expect(relaxOnLocal(s)).toBe(s);
  });

  it('relaxOnPeer records the peer; surfaces the offer to us if we have NOT relaxed; idempotent', () => {
    const s = relaxOnPeer(newRelaxState());
    expect(s).toMatchObject({ peerRelaxed: true, available: true }); // peer relaxed, we have not → offer us too
    expect(relaxOnPeer(s)).toBe(s);
    // if we ALREADY relaxed, a peer relax doesn't need to (re)surface our own offer — but stays available
    const weRelaxed = relaxOnLocal(newRelaxState());
    expect(relaxOnPeer(weRelaxed)).toMatchObject({ peerRelaxed: true, available: true });
  });

  it('restart fires ONLY when BOTH relaxed AND we are the initiator — never one-sided, never the responder', () => {
    let s = newRelaxState();
    expect(shouldRestartForRelay(s, 'initiator')).toBe(false); // neither relaxed
    s = relaxOnLocal(s);
    expect(shouldRestartForRelay(s, 'initiator')).toBe(false); // only us relaxed → other side still filters
    s = relaxOnPeer(s);
    expect(shouldRestartForRelay(s, 'responder')).toBe(false); // both relaxed but we answer, not offer
    expect(shouldRestartForRelay(s, null)).toBe(false); // unresolved role never restarts
    expect(shouldRestartForRelay(s, 'initiator')).toBe(true); // both relaxed + initiator → restart
    // one-shot: once marked restarted, it won't fire again
    expect(shouldRestartForRelay({ ...s, restarted: true }, 'initiator')).toBe(false);
  });

  it('order-independent: peer-first then local reaches the same both-relaxed restart condition', () => {
    let s = relaxOnPeer(newRelaxState()); // peer relaxed first (offered to us)
    expect(shouldRestartForRelay(s, 'initiator')).toBe(false);
    s = relaxOnLocal(s); // then we accept
    expect(shouldRestartForRelay(s, 'initiator')).toBe(true);
  });
});
