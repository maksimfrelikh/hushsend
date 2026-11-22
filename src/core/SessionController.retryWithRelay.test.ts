import { describe, it, expect, vi } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * Two halves of one case — a pair that could not connect directly.
 *
 * The MAX side ends on the direct-failure screen, whose "Retry with relay" calls `retryWithRelay`:
 * the failed session is disposed and a NEW one starts in Reliable — what this side can start alone.
 * The RELIABLE side of a mixed pair (its peer in Max privacy drops relay candidates) used to end on
 * "channel closed during pairing"; with a relay in hand and ICE failing before any channel, it now
 * ends on the reason FailedScreen turns into "ask your peer to switch to Reliable too".
 */

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

import { SessionController } from './SessionController';
import type { TurnCredentials } from './iceServers';
import { connectionActions } from '../store/connectionSlice';

const RELAY: TurnCredentials = {
  urls: ['turn:turn.example.org:3478?transport=udp'],
  username: '1789800671',
  credential: 'ceGB5QfakeBase64HmacValue==',
};
const PAIRING_ID = 'ab'.repeat(16);

interface Internals {
  method: 'room' | 'words' | 'link' | 'qr' | 'reconnect' | null;
  isCreator: boolean;
  privacyMode: 'max' | 'reliable';
  reconnect: { pairingId: Uint8Array; settled: boolean; timer: null } | null;
  sas: { settled: boolean; timer: null } | null;
  turnCreds: TurnCredentials | null;
  channelOpen: boolean;
  established: boolean;
  onChannelClose(why?: string): void;
}

function controller() {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const starts = {
    words: vi.spyOn(sc, 'createWordsSession').mockResolvedValue(),
    link: vi.spyOn(sc, 'createLinkSession').mockResolvedValue(),
    room: vi.spyOn(sc, 'createRoomSession').mockResolvedValue(),
    reconnect: vi.spyOn(sc, 'reconnectTo').mockResolvedValue(),
  };
  const dispose = vi.spyOn(sc, 'dispose');
  return { sc, internals: sc as unknown as Internals, dispatch, starts, dispose };
}

const failureReasons = (dispatch: ReturnType<typeof vi.fn>): string[] =>
  dispatch.mock.calls
    .map(([a]) => a as { type: string; payload?: { reason: string } })
    .filter((a) => a.type === connectionActions.failed.type)
    .map((a) => a.payload!.reason);

describe('retryWithRelay — the Max side starts over in Reliable', () => {
  it('the creator of a link gets a NEW link, in Reliable, after the failed session is disposed', async () => {
    const { sc, internals, starts, dispose } = controller();
    Object.assign(internals, { method: 'qr', isCreator: true, privacyMode: 'max' });

    await sc.retryWithRelay();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(internals.privacyMode).toBe('reliable');
    expect(starts.link).toHaveBeenCalledExactlyOnceWith('qr');
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(starts.link.mock.invocationCallOrder[0]);
  });

  it('the creator of words gets new words, the creator of a room a new room', async () => {
    const words = controller();
    Object.assign(words.internals, { method: 'words', isCreator: true });
    await words.sc.retryWithRelay();
    expect(words.starts.words).toHaveBeenCalledTimes(1);

    const room = controller();
    Object.assign(room.internals, { method: 'room', isCreator: true });
    await room.sc.retryWithRelay();
    expect(room.starts.room).toHaveBeenCalledTimes(1);
  });

  it('a reconnect is tried again with the SAME device', async () => {
    const { sc, internals, starts } = controller();
    const pairingId = Uint8Array.from({ length: 16 }, () => 0xab);
    Object.assign(internals, { method: 'reconnect', isCreator: false, reconnect: { pairingId, settled: true, timer: null } });

    await sc.retryWithRelay();

    expect(starts.reconnect).toHaveBeenCalledExactlyOnceWith(PAIRING_ID);
    expect(internals.privacyMode).toBe('reliable');
  });

  it('a joiner cannot restart alone: it goes home in Reliable and starts nothing', async () => {
    for (const method of ['link', 'words', 'room'] as const) {
      const { sc, internals, starts, dispose } = controller();
      Object.assign(internals, { method, isCreator: false });

      await sc.retryWithRelay();

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(internals.privacyMode).toBe('reliable');
      for (const start of Object.values(starts)) expect(start).not.toHaveBeenCalled();
    }
  });
});

describe('the Reliable side of a pair that found no path', () => {
  function reliableLink() {
    const c = controller();
    Object.assign(c.internals, { method: 'link', isCreator: true, privacyMode: 'reliable', turnCreds: RELAY });
    return c;
  }

  it('ICE failing before the channel, with a relay in hand, ends on the relay reason — not "channel closed"', () => {
    const { internals, dispatch } = reliableLink();
    internals.onChannelClose('ICE failed');
    expect(failureReasons(dispatch)).toEqual(['no path worked, even through the relay']);
  });

  it('the same on the room and the reconnect methods', () => {
    const room = controller();
    Object.assign(room.internals, { method: 'room', turnCreds: RELAY, sas: { settled: false, timer: null } });
    room.internals.onChannelClose('ICE failed');
    expect(failureReasons(room.dispatch)).toEqual(['no path worked, even through the relay']);

    const rc = controller();
    const pairingId = new Uint8Array(16);
    Object.assign(rc.internals, { method: 'reconnect', turnCreds: RELAY, reconnect: { pairingId, settled: false, timer: null } });
    rc.internals.onChannelClose('ICE failed');
    expect(failureReasons(rc.dispatch)).toEqual(['no path worked, even through the relay']);
  });

  it('NEGATIVE CONTROL — a channel the peer closed is still "channel closed during pairing"', () => {
    const { internals, dispatch } = reliableLink();
    internals.onChannelClose('data channel closed');
    expect(failureReasons(dispatch)).toEqual(['channel closed during pairing']);
  });

  it('NEGATIVE CONTROL — without a relay the reason stays generic: the missing-relay hint explains it', () => {
    const { internals, dispatch } = reliableLink();
    internals.turnCreds = { urls: [], username: '', credential: '' };
    internals.onChannelClose('ICE failed');
    expect(failureReasons(dispatch)).toEqual(['channel closed during pairing']);
  });

  it('NEGATIVE CONTROL — once the channel has opened, an ICE failure is not "no path"', () => {
    const { internals, dispatch } = reliableLink();
    internals.channelOpen = true;
    internals.onChannelClose('ICE failed');
    expect(failureReasons(dispatch)).toEqual(['channel closed during pairing']);
  });
});
