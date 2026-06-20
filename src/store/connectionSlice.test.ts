import { describe, it, expect } from 'vitest';
import reducer, { connectionActions } from './connectionSlice';
import type { PeerInfo } from '../types/protocol';

/**
 * Mesh-lobby roster projection + the lobby FSM affordances (room method). The roster is a plain
 * serializable list maintained from welcome (set) / peer-joined (add) / peer-left (remove); the
 * "busy" notice is a transient rejection; `returnToLobby` brings a bounced pick back to the lobby
 * WITHOUT leaving the room; and `joining → awaitingPeer` lets a room joiner land in the lobby.
 */

const peer = (id: string, device = 'Desktop', joinedAt = 1000): PeerInfo => ({ id, device, joinedAt });

describe('connection slice — lobby roster', () => {
  it('rosterSet replaces the roster (the existing-room peers from welcome)', () => {
    const s = reducer(undefined, connectionActions.rosterSet([peer('alpha-fox'), peer('zeta-owl')]));
    expect(s.roster.map((p) => p.id)).toEqual(['alpha-fox', 'zeta-owl']);
    // a later set wins (e.g. a fresh welcome)
    const s2 = reducer(s, connectionActions.rosterSet([peer('calm-lynx')]));
    expect(s2.roster.map((p) => p.id)).toEqual(['calm-lynx']);
  });

  it('rosterAdd appends a newcomer and is idempotent on id', () => {
    let s = reducer(undefined, connectionActions.rosterSet([peer('alpha-fox')]));
    s = reducer(s, connectionActions.rosterAdd(peer('zeta-owl', 'Mobile', 2000)));
    expect(s.roster.map((p) => p.id)).toEqual(['alpha-fox', 'zeta-owl']);
    expect(s.roster[1]).toMatchObject({ device: 'Mobile', joinedAt: 2000 });
    // a duplicate peer-joined for the same id does not double it
    s = reducer(s, connectionActions.rosterAdd(peer('zeta-owl')));
    expect(s.roster.filter((p) => p.id === 'zeta-owl')).toHaveLength(1);
  });

  it('rosterRemove drops the leaver and clears a stale "busy" notice naming it', () => {
    let s = reducer(undefined, connectionActions.rosterSet([peer('alpha-fox'), peer('zeta-owl')]));
    s = reducer(s, connectionActions.lobbyNotice({ kind: 'busy', peerId: 'zeta-owl' }));
    expect(s.notice).toEqual({ kind: 'busy', peerId: 'zeta-owl' });
    s = reducer(s, connectionActions.rosterRemove({ peerId: 'zeta-owl' }));
    expect(s.roster.map((p) => p.id)).toEqual(['alpha-fox']);
    expect(s.notice).toBeNull(); // the busy peer left → notice cleared
  });

  it('rosterRemove of a DIFFERENT peer keeps an unrelated busy notice', () => {
    let s = reducer(undefined, connectionActions.rosterSet([peer('a'), peer('b')]));
    s = reducer(s, connectionActions.lobbyNotice({ kind: 'busy', peerId: 'b' }));
    s = reducer(s, connectionActions.rosterRemove({ peerId: 'a' }));
    expect(s.notice).toEqual({ kind: 'busy', peerId: 'b' });
  });

  it('lobbyNotice sets and clears the transient busy notice', () => {
    let s = reducer(undefined, connectionActions.lobbyNotice({ kind: 'busy', peerId: 'x' }));
    expect(s.notice).toEqual({ kind: 'busy', peerId: 'x' });
    s = reducer(s, connectionActions.lobbyNotice(null));
    expect(s.notice).toBeNull();
  });

  it('lets a room joiner land in the lobby: joining → awaitingPeer (roomReady) is allowed', () => {
    let s = reducer(undefined, connectionActions.joinStarted({ method: 'room', room: '1234' }));
    expect(s.status).toBe('joining');
    s = reducer(s, connectionActions.roomReady({ room: '1234', credential: null }));
    expect(s.status).toBe('awaitingPeer'); // the new transition (mesh lobby)
    expect(s.room).toBe('1234');
  });

  it('returnToLobby (busy bounce): pairing → awaitingPeer, clears per-pair fields, keeps room + roster', () => {
    let s = reducer(undefined, connectionActions.joinStarted({ method: 'room', room: '1234' }));
    s = reducer(s, connectionActions.rosterSet([peer('alpha-fox'), peer('zeta-owl')]));
    s = reducer(s, connectionActions.roomReady({ room: '1234', credential: null }));
    // Pick a peer → pairing (the busy bounce arrives HERE: a busy peer never completes the SAS, so
    // the picker never reaches awaitingSas — it is still in `pairing` when `busy` comes back).
    s = reducer(s, connectionActions.pairingStarted({ peerId: 'zeta-owl' }));
    s = reducer(s, connectionActions.sasRoleResolved({ role: 'picker' }));
    expect(s.status).toBe('pairing');
    // bounce back to the lobby
    s = reducer(s, connectionActions.returnToLobby());
    expect(s.status).toBe('awaitingPeer');
    expect(s.peerId).toBeNull();
    expect(s.sas).toBeNull();
    expect(s.sasRole).toBeNull();
    expect(s.room).toBe('1234'); // room + roster survive so the human can pick another peer
    expect(s.roster.map((p) => p.id)).toEqual(['alpha-fox', 'zeta-owl']);
  });

  it('reset clears the roster and the notice', () => {
    let s = reducer(undefined, connectionActions.rosterSet([peer('a')]));
    s = reducer(s, connectionActions.lobbyNotice({ kind: 'busy', peerId: 'a' }));
    s = reducer(s, connectionActions.reset());
    expect(s.roster).toEqual([]);
    expect(s.notice).toBeNull();
    expect(s.status).toBe('idle');
  });
});

describe('connection slice — relax-retry projection (step 6d)', () => {
  it('starts inert and a fresh pairing resets any prior relax offer', () => {
    // words creator: create → awaitingPeer → a peer joins → pairing (a relay offer surfaces) → the
    // attempt fails below the cap → back to awaitingPeer (roomReady) → next joiner → pairing again.
    let s = reducer(undefined, connectionActions.createStarted({ method: 'words' }));
    s = reducer(s, connectionActions.roomReady({ room: 'word', credential: ['word', 'a', 'b', 'c', 'd'] }));
    expect(s.relax).toEqual({ available: false, localRelaxed: false, peerRelaxed: false });
    s = reducer(s, connectionActions.pairingStarted({ peerId: 'zeta-owl' }));
    s = reducer(s, connectionActions.relaxChanged({ available: true, localRelaxed: true, peerRelaxed: false }));
    expect(s.relax).toEqual({ available: true, localRelaxed: true, peerRelaxed: false });
    // a failed attempt returns to awaitingPeer (roomReady does NOT touch relax — invisible there)…
    s = reducer(s, connectionActions.roomReady({ room: 'word', credential: ['word', 'a', 'b', 'c', 'd'] }));
    expect(s.relax).toEqual({ available: true, localRelaxed: true, peerRelaxed: false });
    // …and the NEXT pairing wipes it back to inert (status `pairing`, no new FSM state).
    s = reducer(s, connectionActions.pairingStarted({ peerId: 'calm-lynx' }));
    expect(s.status).toBe('pairing');
    expect(s.relax).toEqual({ available: false, localRelaxed: false, peerRelaxed: false });
  });

  it('relaxChanged projects the relay-escalation flags without changing status', () => {
    let s = reducer(undefined, connectionActions.joinStarted({ method: 'words', room: 'word' }));
    s = reducer(s, connectionActions.pairingStarted({ peerId: 'p' }));
    s = reducer(s, connectionActions.relaxChanged({ available: true, localRelaxed: false, peerRelaxed: true }));
    expect(s.status).toBe('pairing'); // projection only — no FSM transition
    expect(s.relax).toEqual({ available: true, localRelaxed: false, peerRelaxed: true });
  });

  it('returnToLobby clears a relay offer along with the per-pair fields', () => {
    let s = reducer(undefined, connectionActions.joinStarted({ method: 'room', room: '1234' }));
    s = reducer(s, connectionActions.roomReady({ room: '1234', credential: null }));
    s = reducer(s, connectionActions.pairingStarted({ peerId: 'zeta-owl' }));
    s = reducer(s, connectionActions.relaxChanged({ available: true, localRelaxed: false, peerRelaxed: false }));
    s = reducer(s, connectionActions.returnToLobby());
    expect(s.relax).toEqual({ available: false, localRelaxed: false, peerRelaxed: false });
  });
});
