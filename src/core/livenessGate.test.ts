import { describe, it, expect } from 'vitest';
import { peerLeftAbortsPairing } from './livenessGate';

/**
 * The 1:1 (words / link / qr) liveness gate: does a signaling `peer-left` abort the pairing
 * attempt (= count as a guess for words, a single-use abort for link/qr)? It does ONLY before the
 * DataChannel transport is up; after that, liveness is the DataChannel/ICE, never signaling
 * presence. These cases pin the exact arm/disarm boundary so the words anti-bruteforce window can't
 * silently drift.
 */
describe('peerLeftAbortsPairing — signaling peer-left as a 1:1 pairing-abort signal', () => {
  it('COUNTS a peer-left before the transport is up (pre-channel-open): the rendezvous is still the liveness authority', () => {
    // Not established AND no DataChannel yet → a peer abandoning the rendezvous / CPace is a real
    // abort, and (words) the only thing that can observe it. This is the UNCHANGED pre-completion
    // anti-bruteforce window.
    expect(peerLeftAbortsPairing(false, false)).toBe(true);
  });

  it('IGNORES a peer-left once the DataChannel is open, even before `established` (race-safe)', () => {
    // The benign close: the peer (or, in the cross-side race, the faster side) closed its socket on
    // connect. The DataChannel is up, so liveness/abort is the channel's job — a genuine abort here
    // is caught by channel-close (which, for words, still counts the guess). Must NOT abort us.
    expect(peerLeftAbortsPairing(false, true)).toBe(false);
  });

  it('IGNORES a peer-left after completion (`established`) — the channel outlives signaling', () => {
    // Post-completion: a peer-left can no longer be a guess (the attacker would have had to pass
    // key-confirmation, impossible without the secret), and the live P2P channel is untouched.
    expect(peerLeftAbortsPairing(true, true)).toBe(false);
    expect(peerLeftAbortsPairing(true, false)).toBe(false);
  });
});
