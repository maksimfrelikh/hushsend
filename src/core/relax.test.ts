import { describe, it, expect } from 'vitest';
import {
  classifySelectedPath,
  endpointKey,
  isForbiddenRemoteCandidate,
  isRelayCandidate,
  relayCandidateEndpoint,
  selectedRemoteCandidate,
  shouldDropCandidate,
  stripRelayCandidates,
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

describe('stripRelayCandidates — relay candidates carried inside the SDP', () => {
  const HOST = 'a=candidate:1 1 udp 2130706431 192.168.1.19 54321 typ host';
  const SRFLX = 'a=candidate:2 1 udp 1694498815 203.0.113.7 54321 typ srflx raddr 192.168.1.19 rport 54321';
  const RELAY = 'a=candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 54321';

  it('removes only the relay lines and reports their endpoints', () => {
    const sdp = ['v=0', 'a=fingerprint:sha-256 AA:BB', HOST, RELAY, SRFLX].join('\r\n');
    const out = stripRelayCandidates(sdp);
    expect(out.sdp).not.toMatch(/typ relay/);
    expect(out.sdp).toContain(HOST);
    expect(out.sdp).toContain(SRFLX);
    expect(out.sdp).toContain('a=fingerprint:sha-256 AA:BB'); // nothing else touched
    expect(out.endpoints).toEqual(['198.51.100.9|3478']);
  });

  it('feeds the SAME endpoint key the trickled path records, so prflx is still caught', () => {
    const { endpoints } = stripRelayCandidates(['v=0', RELAY].join('\r\n'));
    // The peer-reflexive check compares against exactly this set.
    expect(isForbiddenRemoteCandidate(true, { candidateType: 'prflx', address: '198.51.100.9', port: 3478 }, new Set(endpoints))).toBe(true);
  });

  it('is a no-op (identical string, no copy) when the SDP carries no relay candidate', () => {
    const sdp = ['v=0', HOST, SRFLX].join('\r\n');
    const out = stripRelayCandidates(sdp);
    expect(out.sdp).toBe(sdp);
    expect(out.endpoints).toEqual([]);
  });

  it('preserves the line ending the engine used', () => {
    expect(stripRelayCandidates(['v=0', RELAY, HOST].join('\r\n')).sdp).toContain('\r\n');
    expect(stripRelayCandidates(['v=0', RELAY, HOST].join('\n')).sdp).not.toContain('\r');
  });

  it('does not strip a candidate merely mentioning "relay" outside the typ field', () => {
    const odd = 'a=candidate:4 1 udp 2130706431 relay.example.org 9 typ host';
    const out = stripRelayCandidates(['v=0', odd].join('\r\n'));
    expect(out.sdp).toContain(odd);
    expect(out.endpoints).toEqual([]);
  });
});

/**
 * F1 REGRESSION (2026-09-13) — the Max-privacy channel-open gate used to read "cannot tell" as
 * "not relayed" and open the channel.
 *
 * The old gate was `isForbiddenRemoteCandidate(true, selectedRemoteCandidate(entries), dropped)`,
 * whose `!remote → false` branch collapses "ICE has not published a selection yet" into "safe" — the
 * exact reading `selectedRemoteCandidate`'s own docstring forbids. The first test below reproduces
 * that: a relayed endpoint we ALREADY dropped, on a pair still `in-progress`, was waved through.
 */
describe('classifySelectedPath (F1)', () => {
  const RELAY_ADDR = '203.0.113.99';
  const RELAY_PORT = 49200;
  const dropped = new Set([endpointKey(RELAY_ADDR, RELAY_PORT)!]);

  /** A stats snapshot where the only pair is the relayed one, in the given state. */
  const snapshot = (state: string, selected: boolean): StatsEntry[] => [
    { type: 'transport', id: 'T1', ...(selected ? { selectedCandidatePairId: 'P1' } : {}) },
    { type: 'candidate-pair', id: 'P1', state, nominated: selected, selected, remoteCandidateId: 'R1' },
    { type: 'remote-candidate', id: 'R1', candidateType: 'prflx', address: RELAY_ADDR, port: RELAY_PORT },
  ];

  /** Deterministic clock + no real waiting, so these are ordinary fast unit tests. */
  const run = (reads: Array<StatsEntry[] | null>, timeoutMs = 500, pollMs = 100) => {
    let clock = 0;
    let i = 0;
    return classifySelectedPath({
      readStats: () => Promise.resolve(reads[Math.min(i++, reads.length - 1)]),
      droppedRelayEndpoints: dropped,
      timeoutMs,
      pollMs,
      aborted: () => false,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
  };

  it('THE BUG: a not-yet-selected relayed pair is no longer waved through as safe', async () => {
    // The old one-shot reading of the same snapshot:
    expect(isForbiddenRemoteCandidate(true, selectedRemoteCandidate(snapshot('in-progress', false)), dropped)).toBe(
      false,
    );
    // ...and what the gate concludes now, when the selection never lands:
    await expect(run([snapshot('in-progress', false)])).resolves.toBe('undetermined');
  });

  it('waits, then answers once the selection lands', async () => {
    await expect(run([snapshot('in-progress', false), snapshot('succeeded', true)])).resolves.toBe('relayed');
  });

  it('a genuinely direct selected pair is direct', async () => {
    const direct: StatsEntry[] = [
      { type: 'transport', id: 'T1', selectedCandidatePairId: 'P1' },
      { type: 'candidate-pair', id: 'P1', state: 'succeeded', nominated: true, selected: true, remoteCandidateId: 'R1' },
      { type: 'remote-candidate', id: 'R1', candidateType: 'srflx', address: '198.51.100.4', port: 51000 },
    ];
    await expect(run([direct])).resolves.toBe('direct');
  });

  it('a relay-TYPED selected candidate is relayed even on an endpoint we never dropped', async () => {
    const relayTyped: StatsEntry[] = [
      { type: 'transport', id: 'T1', selectedCandidatePairId: 'P1' },
      { type: 'candidate-pair', id: 'P1', state: 'succeeded', nominated: true, selected: true, remoteCandidateId: 'R1' },
      { type: 'remote-candidate', id: 'R1', candidateType: 'relay', address: '198.51.100.7', port: 52000 },
    ];
    await expect(run([relayTyped])).resolves.toBe('relayed');
  });

  it('a transient getStats() rejection is retried, not taken as an answer', async () => {
    await expect(run([null, null, snapshot('succeeded', true)])).resolves.toBe('relayed');
  });

  it('an engine with no getStats() at all yields undetermined — never a silent open', async () => {
    await expect(run([null])).resolves.toBe('undetermined');
  });

  it('empty stats yield undetermined, not direct', async () => {
    await expect(run([[]])).resolves.toBe('undetermined');
  });

  it('stops immediately when the owner tore the connection down', async () => {
    await expect(
      classifySelectedPath({
        readStats: () => Promise.reject(new Error('must not be read after teardown')),
        droppedRelayEndpoints: dropped,
        timeoutMs: 5000,
        pollMs: 100,
        aborted: () => true,
      }),
    ).resolves.toBe('undetermined');
  });

  it('bounds its own wait rather than hanging the channel forever', async () => {
    let clock = 0;
    const verdict = await classifySelectedPath({
      readStats: () => Promise.resolve([]),
      droppedRelayEndpoints: dropped,
      timeoutMs: 5000,
      pollMs: 100,
      aborted: () => false,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    expect(verdict).toBe('undetermined');
    expect(clock).toBeLessThanOrEqual(5000 + 100); // terminated at the deadline, not spinning
  });
});
