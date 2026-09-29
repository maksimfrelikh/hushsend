import { describe, it, expect, vi } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * A room that expires while THIS side waits in it (BACKLOG § UX bugs, copy nits). The server's TTL
 * close — a `room-closed` frame, then the socket closing 4010 `expired` — reaches the creator of a
 * words / link / 4-digit room, and a lobby member, exactly as it reaches a joiner of a dead code, and
 * used to fail all of them with the joiner's "not found or expired — check the digits". The waiting
 * side now fails with WAIT_EXPIRED_REASON (FailedScreen: "Your words / link / the room expired");
 * a joiner keeps the old reason.
 */

vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: class {} }));
import { SessionController } from './SessionController';

interface SCInternals {
  method: 'room' | 'words' | 'link' | 'qr' | 'reconnect' | null;
  isCreator: boolean;
  onWelcome(selfId: string, room: string, peers: Array<{ id: string; joinedAt: number }>): void;
  onRoomClosed(reason: string): void;
  onSignalingClose(code: number, reason: string): void;
  waitingInRoom: boolean;
  sas: unknown;
}

type Action = { type: string; payload?: { reason?: string } };

function controller(method: SCInternals['method'], isCreator: boolean) {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const internals = sc as unknown as SCInternals;
  internals.method = method;
  internals.isCreator = isCreator;
  const failures = (): string[] =>
    (dispatch.mock.calls as Array<[Action]>)
      .map(([a]) => a)
      .filter((a) => a.type === 'connection/failed')
      .map((a) => a.payload?.reason ?? '');
  return { internals, failures };
}

const WAIT = 'nobody joined before the code expired';

describe('a room that expires while we wait in it', () => {
  it('words creator: the room-closed frame fails with the wait reason, not the joiner’s', () => {
    const { internals, failures } = controller('words', true);
    internals.onWelcome('self-a', 'bathrobe', []);
    expect(internals.waitingInRoom).toBe(true);
    internals.onRoomClosed('expired');
    expect(failures()).toEqual([WAIT]);
  });

  it('link creator and room lobby member: the 4010 close fails with the wait reason', () => {
    const link = controller('link', true);
    link.internals.onWelcome('self-a', 'k7Qm2vXa9LpR4nTdE0wYc3', []);
    link.internals.onSignalingClose(4010, 'expired');
    expect(link.failures()).toEqual([WAIT]);

    const lobby = controller('room', false); // a joiner sitting in the 4-digit lobby
    lobby.internals.sas = { settled: false }; // what joinRoomSession sets up: the room is a SAS lobby
    lobby.internals.onWelcome('self-b', '4827', [{ id: 'self-a', joinedAt: 1 }]);
    expect(lobby.internals.waitingInRoom).toBe(true);
    lobby.internals.onSignalingClose(4010, 'expired');
    expect(lobby.failures()).toEqual([WAIT]);
  });

  it('a side that is NOT waiting in its own room keeps the old reasons', () => {
    // a words joiner in an empty room (it never showed a credential or a lobby)
    const joiner = controller('words', false);
    joiner.internals.onWelcome('self-b', 'bathrobe', []);
    expect(joiner.internals.waitingInRoom).toBe(false);
    joiner.internals.onRoomClosed('expired');
    expect(joiner.failures()).toEqual(['expired']);
    // any other close code is the plain signaling failure, waiting or not
    const other = controller('link', true);
    other.internals.onWelcome('self-a', 'k7Qm2vXa9LpR4nTdE0wYc3', []);
    other.internals.onSignalingClose(1006, '');
    expect(other.failures()).toEqual(['signaling closed (code 1006)']);
  });
});
