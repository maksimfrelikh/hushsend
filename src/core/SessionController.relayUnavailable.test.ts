import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * Reliable mode degrading to direct-only must be VISIBLE.
 *
 * `ensureTurnReady` already logged "turn: relay unavailable — staying direct-only", but that line goes
 * to the DEV diagnostics strip, which is tree-shaken out of production. So on the live site a Reliable
 * user whose relay was undeployed, whose `TURN_SECRET` had drifted from coturn's, or whose fetch timed
 * out got Max-privacy connectivity with none of its guarantees and NO indication — and the failure that
 * followed read as ordinary bad luck. The fix projects it into real connection state
 * (`connectionSlice.relayUnavailable`) so FailedScreen can name the cause.
 *
 * The assertions that matter here are the NEGATIVE ones. "Relay missing ⇒ flag set" passes just as well
 * against a controller that sets the flag unconditionally, so this file also pins both directions it
 * must NOT fire: a relay that IS available, and Max privacy (which never asks for creds at all, so the
 * flag would be an outright lie about a mode that promises never to relay).
 */

// Mock the real PeerConnection (it needs RTCPeerConnection, absent under Node).
const hoisted = vi.hoisted(() => {
  class MockPeerConnection {
    constructor(
      public handlers: unknown,
      public config: unknown,
    ) {}
    start(): void {}
    async handleSignal(): Promise<void> {}
    close(): void {}
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
  return { MockPeerConnection };
});

vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));

// Imported AFTER vi.mock (vitest hoists it above imports) so SessionController binds the mock.
import { SessionController } from './SessionController';
import { NO_TURN, type TurnCredentials } from './iceServers';
import { connectionActions } from '../store/connectionSlice';

const RELAY_AVAILABLE: TurnCredentials = {
  urls: ['turn:turn.example.org:3478?transport=udp'],
  username: '1789800671',
  credential: 'ceGB5QfakeBase64HmacValue==',
};

interface SCInternals {
  signaling: unknown;
  startPeer(peerId: string, initiator: boolean): Promise<void>;
}

/** Drive one pairing start in `mode`, with the signaling server answering `turn-request` with `creds`. */
async function startPairing(mode: 'max' | 'reliable', creds: TurnCredentials) {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const internals = sc as unknown as SCInternals;
  sc.setPrivacyMode(mode);
  const requestTurnCredentials = vi.fn(() => Promise.resolve(creds));
  internals.signaling = { requestTurnCredentials, send: vi.fn(), close: vi.fn() };
  await internals.startPeer('peer-a', true);
  const dispatched = dispatch.mock.calls.map((c) => (c[0] as { type?: string })?.type);
  return { requestTurnCredentials, dispatched };
}

const RELAY_UNAVAILABLE = connectionActions.relayUnavailable().type;

describe('SessionController — Reliable mode must SAY when the relay is missing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Reliable + no relay (empty urls) ⇒ projects relayUnavailable into connection state', async () => {
    const { requestTurnCredentials, dispatched } = await startPairing('reliable', NO_TURN);
    expect(requestTurnCredentials).toHaveBeenCalledTimes(1);
    expect(dispatched).toContain(RELAY_UNAVAILABLE);
  });

  it('NEGATIVE CONTROL — Reliable + a relay that IS there ⇒ the flag stays off', async () => {
    const { requestTurnCredentials, dispatched } = await startPairing('reliable', RELAY_AVAILABLE);
    expect(requestTurnCredentials).toHaveBeenCalledTimes(1);
    expect(dispatched).not.toContain(RELAY_UNAVAILABLE);
  });

  it('NEGATIVE CONTROL — Max privacy never asks for creds, so it can never claim a relay went missing', async () => {
    const { requestTurnCredentials, dispatched } = await startPairing('max', NO_TURN);
    // Max-privacy is strict: the relay is never contacted at all (see ensureTurnReady's early return).
    expect(requestTurnCredentials).not.toHaveBeenCalled();
    expect(dispatched).not.toContain(RELAY_UNAVAILABLE);
  });
});
