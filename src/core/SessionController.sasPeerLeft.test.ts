import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppDispatch } from '../store';
import { connectionActions } from '../store/connectionSlice';

/**
 * Regression for the room/SAS per-pair WS-close cross-channel race (Part A) + the per-pair close it
 * enables (Part B).
 *
 * Part A — the SAS branch of onPeerLeft is now gated by `peerLeftAbortsPairing(established, channelOpen)`,
 * exactly like words and link/qr (it used to fire on a bare `!established`). The motivation: once room/SAS
 * ALSO closes its own signaling socket on `connected` (Part B), each close makes the OTHER side observe a
 * signaling `peer-left`. That `peer-left` can RACE the DataChannel `sas-confirm` (the two travel different
 * channels): a side that has clicked "matches" and is waiting for the peer's confirm could see the peer's
 * post-connect socket close FIRST and — without the gate — tear down a pair where both humans already
 * agreed. SAS has no online-guessing budget, so gating on channelOpen weakens nothing: a REAL abort after
 * channel-open still tears the channel down and is caught by onChannelClose.
 *
 * Part B — a connected room/SAS pair closes its own signaling socket on `established` (in trySasSettle),
 * via the same closeSignalingAfterConnect as the 1:1 methods, now that the room exclusion is lifted
 * (reconnect stays excluded). The close is a WS close ONLY — no room-destroy / leave frame.
 *
 * Driven deterministically at the SessionController level with a mock PeerConnection (the real one needs
 * RTCPeerConnection, absent under Node) and the controller's private hooks reached through a typed cast.
 */

// Mock the real PeerConnection so importing SessionController doesn't touch RTCPeerConnection. These
// tests set `internals.peer` directly (they never construct it), so the mock only needs to exist + carry
// the few methods the settle/teardown paths may touch.
const hoisted = vi.hoisted(() => {
  class MockPeerConnection {
    closed = false;
    readonly sent: unknown[] = [];
    constructor(_handlers: unknown, _config: unknown) {}
    start(_initiator: boolean): void {}
    async handleSignal(_data: unknown): Promise<void> {}
    async send(data: unknown): Promise<void> {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
    }
    localFingerprint(): string | null {
      return 'AA:BB';
    }
    remoteFingerprint(): string | null {
      return 'CC:DD';
    }
    maxMessageSize(): number {
      return 0;
    }
  }
  return { MockPeerConnection };
});
vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));

// Imported AFTER vi.mock (vitest hoists the mock above imports) so SessionController binds the mock.
import { SessionController } from './SessionController';

/** Minimal view onto a SAS state — only the fields the settle/peer-left paths read/write. */
interface TestSas {
  role: 'initiator' | 'responder';
  myNonce: Uint8Array;
  peerCommit: Uint8Array | null;
  peerNonce: Uint8Array | null;
  revealedMine: boolean;
  fps: { local: string; remote: string } | null;
  words: string[] | null;
  surfaced: boolean;
  localApproved: boolean;
  peerApproved: boolean | null;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A SAS state mid-comparison: this side has clicked "matches" (localApproved), the channel is up, and
 *  it is waiting for the peer's `sas-confirm` (peerApproved still null). Not yet `established`. */
function midComparisonSas(): TestSas {
  return {
    role: 'responder', // responder → runEnrollment returns early (no enroll-init send), keeps the test quiet
    myNonce: new Uint8Array(16),
    peerCommit: null,
    peerNonce: new Uint8Array(16),
    revealedMine: true,
    fps: { local: 'AA:BB', remote: 'CC:DD' },
    words: ['alpha', 'bravo', 'charlie'],
    surfaced: true,
    localApproved: true,
    peerApproved: null,
    settled: false,
    timer: null,
  };
}

interface MockPeer {
  closed: boolean;
  sent: unknown[];
}
interface MockSignaling {
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  destroyRoom: ReturnType<typeof vi.fn>;
}
interface SCInternals {
  method: 'room' | 'words' | 'link' | 'qr' | null;
  sas: TestSas | null;
  reconnect: unknown;
  peer: MockPeer | null;
  peerId: string | null;
  established: boolean;
  channelOpen: boolean;
  signaling: MockSignaling | null;
  onPeerLeft(peerId: string): void;
  onPeerMessage(data: string | ArrayBuffer): void;
  closeSignalingAfterConnect(): void;
}

function newController(): {
  sc: SessionController;
  internals: SCInternals;
  dispatch: ReturnType<typeof vi.fn>;
  failSas: ReturnType<typeof vi.spyOn>;
  signaling: MockSignaling;
  peer: MockPeer;
} {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  // Spy failSas as a no-op so we can assert "called / not called" without running its teardown side
  // effects (peer.close / signaling.close / this.fail). In the race test it is asserted NOT to fire, so
  // call-through vs no-op is moot there; the no-op only matters for the legitimate-abort assertion.
  const failSas = vi
    .spyOn(sc as unknown as { failSas: (reason: string) => void }, 'failSas')
    .mockImplementation(() => {});
  const internals = sc as unknown as SCInternals;
  const signaling: MockSignaling = { close: vi.fn(), send: vi.fn(), destroyRoom: vi.fn() };
  const peer: MockPeer = { closed: false, sent: [] };
  internals.method = 'room';
  internals.reconnect = null;
  internals.peerId = 'peer-a';
  internals.peer = peer;
  internals.signaling = signaling;
  return { sc, internals, dispatch, failSas, signaling, peer };
}

const SAS_CONFIRM_OK = JSON.stringify({ kind: 'sas-confirm', ok: true });

describe('SessionController — SAS peer-left channelOpen gate (Part A) + room per-pair WS-close (Part B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('race fix: a peer-left AFTER channel-open does NOT abort a SAS pair where this side already approved', () => {
    const { internals, failSas, signaling, peer } = newController();
    internals.sas = midComparisonSas(); // localApproved=true, peerApproved=null
    internals.channelOpen = true; // transport up — DataChannel/ICE are now the liveness authority
    internals.established = false; // not yet settled (still awaiting the peer's sas-confirm)

    // The peer's post-connect signaling socket close arrives FIRST (the cross-channel race).
    internals.onPeerLeft('peer-a');

    // The gate disarms: failSas is NOT called, the pair is alive (not settled, channel not torn down).
    expect(failSas).not.toHaveBeenCalled();
    expect(internals.sas!.settled).toBe(false);
    expect(internals.established).toBe(false);
    expect(peer.closed).toBe(false);
    expect(signaling.close).not.toHaveBeenCalled();

    // Now the peer's sas-confirm arrives over the DataChannel — the pair settles to `connected`.
    internals.onPeerMessage(SAS_CONFIRM_OK);
    expect(internals.sas!.peerApproved).toBe(true);
    expect(internals.sas!.settled).toBe(true);
    expect(internals.established).toBe(true);
    // Part B: on `established` the room/SAS pair closes its OWN signaling socket (WS close only — no
    // room-destroy / leave frame), while the live DataChannel survives.
    expect(signaling.close).toHaveBeenCalledTimes(1);
    expect(signaling.destroyRoom).not.toHaveBeenCalled();
    expect(peer.closed).toBe(false);
  });

  it('legitimate abort: a peer-left BEFORE the channel opens still aborts the SAS pairing', () => {
    const { internals, failSas } = newController();
    internals.sas = midComparisonSas();
    internals.channelOpen = false; // still connecting — the rendezvous is the liveness authority
    internals.established = false;

    internals.onPeerLeft('peer-a');

    // Pre-transport, a peer-left is a real abort.
    expect(failSas).toHaveBeenCalledTimes(1);
    expect(failSas).toHaveBeenCalledWith('peer left during SAS pairing');
  });

  it('unrelated: a peer-left from a DIFFERENT peer updates the roster but never fails the SAS pair', () => {
    const { internals, failSas, dispatch } = newController();
    internals.sas = midComparisonSas();
    internals.channelOpen = false; // even pre-transport, an unrelated leaver must not touch us
    internals.established = false;

    internals.onPeerLeft('some-other-peer'); // !== this.peerId ('peer-a')

    expect(dispatch).toHaveBeenCalledWith(connectionActions.rosterRemove({ peerId: 'some-other-peer' }));
    expect(failSas).not.toHaveBeenCalled();
    expect(internals.sas!.settled).toBe(false);
  });

  it('Part B exclusion: a RECONNECT session does NOT close its signaling socket on connect', () => {
    const { internals, signaling } = newController();
    internals.sas = midComparisonSas();
    internals.reconnect = { fellBack: false, settled: false }; // reconnect rides its own fresh socket

    // closeSignalingAfterConnect is a no-op when a reconnect attempt is in play (deferred reconnect-in-lobby).
    internals.closeSignalingAfterConnect();
    expect(signaling.close).not.toHaveBeenCalled();
  });
});
