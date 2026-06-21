import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * Regression for the mixed-privacy room deadlock (and the latent link/qr race): a WebRTC offer that
 * reaches a side BEFORE its PeerConnection exists was silently dropped at the `this.peer?.handleSignal`
 * no-op in onSignal. The window opens for a Reliable-mode ANSWERER still fetching coturn creds
 * (`ensureTurnReady` pending) when a Max-privacy offerer's offer arrives — the answerer's startPeer is
 * suspended on the cred fetch, so `this.peer` is still null. The fix BUFFERS such pre-PC signals
 * (pendingPeerSignals) and REPLAYS them once startPeer builds the PC; teardown/reset/retry paths drop
 * the buffer so a stale signal can't replay into the next attempt's PC.
 *
 * This test drives the race deterministically at the SessionController level: a controllable
 * `ensureTurnReady` (the signaling fake's requestTurnCredentials stays pending until we resolve it) and
 * a mock PeerConnection. It is METHOD-AGNOSTIC — the buffer lives in the shared WebRTC tail of onSignal
 * — so it covers both the room and the link/qr paths (words is already serialized behind its CPace gate
 * and unaffected).
 */

// Mock the real PeerConnection (which needs RTCPeerConnection — absent under Node) with a controllable
// double that records start()/handleSignal() and simulates the answerer emitting an answer for an offer.
const hoisted = vi.hoisted(() => {
  interface MockHandlers {
    onSignal?: (data: unknown) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onIceFailed?: () => void;
    onMessage?: (data: string | ArrayBuffer) => void;
  }
  const instances: MockPeerConnection[] = [];
  class MockPeerConnection {
    handlers: MockHandlers;
    started: boolean | null = null;
    readonly handled: unknown[] = [];
    closed = false;
    constructor(handlers: MockHandlers, _config: unknown) {
      this.handlers = handlers;
      instances.push(this);
    }
    start(initiator: boolean): void {
      this.started = initiator;
    }
    async handleSignal(data: unknown): Promise<void> {
      this.handled.push(data);
      // Stand-in for the answerer path: an offer → setRemoteDescription → createAnswer → emit answer
      // back to the peer (routed through the handlers.onSignal the SessionController wired to signaling).
      if (data && typeof data === 'object' && (data as { kind?: unknown }).kind === 'offer') {
        this.handlers.onSignal?.({ kind: 'answer', description: { type: 'answer', sdp: 'mock-answer-sdp' } });
      }
    }
    close(): void {
      this.closed = true;
    }
    localFingerprint(): string | null {
      return null;
    }
    remoteFingerprint(): string | null {
      return null;
    }
    maxMessageSize(): number {
      return 0;
    }
  }
  return { instances, MockPeerConnection };
});

vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));

// Imported AFTER vi.mock (which vitest hoists above imports) so SessionController binds the mock.
import { SessionController } from './SessionController';
import { NO_TURN } from './iceServers';

/** Narrow view onto the SessionController internals this test drives/inspects (no `any`). */
interface MockPeer {
  started: boolean | null;
  handled: unknown[];
  closed: boolean;
}
interface SCInternals {
  signaling: unknown;
  peer: MockPeer | null;
  pendingPeerSignals: unknown[];
  peerId: string | null;
  role: 'initiator' | 'responder' | null;
  method: 'room' | 'words' | 'link' | 'qr' | null;
  sas: unknown;
  onSignal(from: string, data: unknown): void;
  startPeer(peerId: string, initiator: boolean): Promise<void>;
  resetPairingToLobby(): void;
}

const OFFER = { kind: 'offer', description: { type: 'offer', sdp: 'mock-offer-sdp' } };

function newController(): { sc: SessionController; internals: SCInternals; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  return { sc, internals: sc as unknown as SCInternals, dispatch };
}

describe('SessionController — pre-PC WebRTC signal buffering (mixed-privacy / link-qr race)', () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
    vi.clearAllMocks();
  });

  it('buffers a pre-PC offer and replays it once startPeer builds the PeerConnection', async () => {
    const { sc, internals } = newController();
    sc.setPrivacyMode('reliable'); // Reliable answerer: startPeer awaits coturn creds before building the PC
    internals.method = 'link'; // one of the paths the fix closes (room is the other; buffer is shared)

    // An active pairing (as beginPairing would have set it), but no PC yet — we are the answerer.
    internals.peerId = 'peer-a';
    internals.role = 'responder';

    // Controllable ensureTurnReady: requestTurnCredentials stays PENDING until we resolve it, so
    // startPeer is suspended on the cred fetch while the offer arrives.
    let resolveTurn!: (creds: unknown) => void;
    const requestTurnCredentials = vi.fn(() => new Promise<unknown>((r) => (resolveTurn = r)));
    const send = vi.fn();
    internals.signaling = { requestTurnCredentials, send, close: vi.fn() };

    // Kick off the answerer's PC bring-up — it suspends at `await ensureTurnReady()`.
    const starting = internals.startPeer('peer-a', false);

    // The peer's offer arrives WHILE the PC is still null.
    internals.onSignal('peer-a', OFFER);

    // Not dropped: buffered, PC still not built, nothing sent back yet.
    expect(internals.peer).toBeNull();
    expect(internals.pendingPeerSignals).toEqual([OFFER]);
    expect(send).not.toHaveBeenCalled();

    // Creds resolve → startPeer continues, builds the PC, and replays the buffered offer.
    resolveTurn(NO_TURN);
    await starting;

    // PC built as the answerer; the buffered offer was replayed (→ setRemoteDescription/createAnswer)
    // and the generated answer went out; the queue is now empty.
    expect(internals.peer).not.toBeNull();
    expect(internals.peer!.started).toBe(false);
    expect(internals.peer!.handled).toEqual([OFFER]);
    expect(internals.pendingPeerSignals).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('peer-a', expect.objectContaining({ kind: 'answer' }));

    // Once the PC exists, a further signal flows straight to it — never re-buffered.
    const ice = { kind: 'ice', candidate: null };
    internals.onSignal('peer-a', ice);
    expect(internals.peer!.handled).toEqual([OFFER, ice]);
    expect(internals.pendingPeerSignals).toEqual([]);
  });

  it('clears the buffer on resetPairingToLobby so a stale signal is not replayed into the next PC', () => {
    const { internals } = newController();
    internals.method = 'room';
    internals.sas = { timer: null }; // minimal SAS state: resetPairingToLobby's timer check no-ops, then re-primes
    internals.peerId = 'peer-a';

    // An offer is buffered (no PC yet).
    internals.onSignal('peer-a', OFFER);
    expect(internals.pendingPeerSignals).toEqual([OFFER]);

    // Tearing the half-started pairing back to the lobby (e.g. a `busy` reject) must drop the stale offer
    // so it cannot replay into the PC the next pick builds.
    internals.resetPairingToLobby();
    expect(internals.pendingPeerSignals).toEqual([]);
  });

  it('does not buffer a signal from a peer we are not paired with', () => {
    const { internals } = newController();
    internals.method = 'link';
    internals.peerId = 'peer-a';

    // A signal from a stranger (the 1:1 `from !== peerId` gate must drop it BEFORE the buffer).
    internals.onSignal('someone-else', OFFER);
    expect(internals.pendingPeerSignals).toEqual([]);
  });
});
