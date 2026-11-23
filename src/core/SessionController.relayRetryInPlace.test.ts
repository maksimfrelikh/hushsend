import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

/**
 * "Retry with relay" continues the SAME pairing (README § Max-privacy strict model): two real
 * SessionControllers against a signaling hub and linked PeerConnections that live in this file.
 *
 * The hub is what the server is to the client — rooms by name, ids, relayed frames, peer-left, TURN
 * credentials on request — and it records every room taken, every frame and every credential request,
 * which is what the invariants are stated in: a relay is asked for only after this side's own tap AND
 * a peer at the retry rendezvous; a `relay-retry` frame alone moves nothing; the retried transport is
 * authenticated by the method's own secret over its NEW fingerprints; nothing secret crosses the hub.
 * The crypto is the real one (CPace, key-confirmation, SAS, the reconnect proof); only the transport
 * is a stand-in: `failIce()` is what ICE giving up looks like to the controller, `open()` the channel.
 */

const hoisted = vi.hoisted(() => {
  interface Handlers {
    onWelcome?: (selfId: string, room: string, peers: { id: string; joinedAt: number }[]) => void;
    onPeerJoined?: (peer: { id: string; joinedAt: number }) => void;
    onPeerLeft?: (peerId: string) => void;
    onSignal?: (from: string, data: unknown) => void;
    onRoomClosed?: (reason: string) => void;
    onClose?: (code: number, reason: string) => void;
  }
  const RELAY = { urls: ['turn:relay.test:3478?transport=udp'], username: '1789800671:ab', credential: 'c2VjcmV0' };
  const hub = {
    rooms: new Map<string, FakeSignaling[]>(),
    /** every room taken, in order */
    taken: [] as string[],
    /** every relayed frame */
    frames: [] as { room: string; from: string; to: string; data: unknown }[],
    /** every TURN-credential request, by the id of the socket that made it */
    turnRequests: [] as string[],
    turn: RELAY as { urls: string[]; username: string; credential: string },
    seq: 0,
    reset(): void {
      hub.rooms.clear();
      hub.taken.length = 0;
      hub.frames.length = 0;
      hub.turnRequests.length = 0;
      hub.turn = RELAY;
      hub.seq = 0;
    },
  };

  class FakeSignaling {
    id = '';
    room = '';
    closed = false;
    constructor(
      _url: string,
      public handlers: Handlers,
    ) {}
    async connect(opts: { create: true } | { join: string }): Promise<void> {
      hub.seq += 1;
      this.id = `p${String(hub.seq).padStart(4, '0')}`;
      this.room = 'create' in opts ? `created-${hub.seq}` : opts.join;
      const members = hub.rooms.get(this.room) ?? [];
      hub.rooms.set(this.room, members);
      const earlier = [...members];
      members.push(this);
      hub.taken.push(this.room);
      setTimeout(() => {
        if (this.closed) return;
        this.handlers.onWelcome?.(
          this.id,
          this.room,
          earlier.filter((m) => !m.closed).map((m) => ({ id: m.id, joinedAt: 0 })),
        );
        for (const m of earlier) if (!m.closed) m.handlers.onPeerJoined?.({ id: this.id, joinedAt: 0 });
      }, 0);
    }
    send(to: string, data: unknown): void {
      if (this.closed) return;
      hub.frames.push({ room: this.room, from: this.id, to, data });
      const target = hub.rooms.get(this.room)?.find((m) => m.id === to);
      const from = this.id;
      if (target) setTimeout(() => !target.closed && target.handlers.onSignal?.(from, data), 0);
    }
    destroyRoom(): void {}
    async requestTurnCredentials(): Promise<{ urls: string[]; username: string; credential: string }> {
      hub.turnRequests.push(this.id);
      return hub.turn;
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      const members = hub.rooms.get(this.room) ?? [];
      const at = members.indexOf(this);
      if (at >= 0) members.splice(at, 1);
      const id = this.id;
      for (const m of members) setTimeout(() => !m.closed && m.handlers.onPeerLeft?.(id), 0);
    }
  }

  interface PcHandlers {
    onSignal: (data: unknown) => void;
    onOpen: () => void;
    onClose: (why?: string) => void;
    onMessage: (data: string | ArrayBuffer) => void;
    onIceFailed: () => void;
  }
  const pcs: MockPeerConnection[] = [];
  let certs = 0;
  class MockPeerConnection {
    /** a new certificate per connection, as a browser makes */
    readonly fp = `AA:BB:${String(++certs).padStart(4, '0')}`;
    remoteFp: string | null = null;
    closed = false;
    constructor(
      public handlers: PcHandlers,
      public config: { iceServers: { urls: string | string[] }[]; filterRelay: boolean },
    ) {
      pcs.push(this);
    }
    start(initiator: boolean): void {
      if (initiator) this.handlers.onSignal({ type: 'offer', fp: this.fp });
    }
    async handleSignal(data: unknown): Promise<void> {
      const d = data as { type?: string; fp?: string };
      if (this.closed || !d.fp) return;
      if (d.type === 'offer') {
        this.remoteFp = d.fp;
        this.handlers.onSignal({ type: 'answer', fp: this.fp });
      } else if (d.type === 'answer') this.remoteFp = d.fp;
    }
    async send(data: string | ArrayBuffer): Promise<void> {
      const other = pcs.find((p) => p.fp === this.remoteFp);
      if (other) setTimeout(() => !other.closed && other.handlers.onMessage(data), 0);
    }
    close(): void {
      this.closed = true;
    }
    localFingerprint(): string | null {
      return this.fp;
    }
    remoteFingerprint(): string | null {
      return this.remoteFp;
    }
    maxMessageSize(): number {
      return 16384;
    }
    async localAddresses(): Promise<string[]> {
      return ['192.0.2.7'];
    }
    async selectedRemoteAddress(): Promise<string | null> {
      return '192.0.2.7';
    }
    async selectedPathRelayed(): Promise<boolean> {
      return !this.config.filterRelay;
    }
    /** ICE gave up: the strict side reports it as a direct failure, the other as a closed transport. */
    failIce(): void {
      if (this.config.filterRelay) this.handlers.onIceFailed();
      else this.handlers.onClose('ICE failed');
    }
    open(): void {
      this.handlers.onOpen();
    }
  }
  return { hub, FakeSignaling, MockPeerConnection, pcs };
});

vi.mock('./signaling/SignalingClient', () => ({ SignalingClient: hoisted.FakeSignaling }));
vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));

import { SessionController } from './SessionController';
import { Keystore, MemoryKeystoreBackend } from './keystore';
import { parseLink } from './link/link';
import { relayRetryToken } from './relayRetry';
import { bytesToHex } from '@noble/curves/utils.js';
import connection from '../store/connectionSlice';
import transfer from '../store/transferSlice';
import history from '../store/historySlice';
import dev from '../store/devSlice';
import type { PrivacyMode } from './iceServers';

const { hub, pcs } = hoisted;
type Pc = InstanceType<typeof hoisted.MockPeerConnection>;

const DIRECT = "couldn't connect directly (Max privacy)";
const NO_PATH = 'no path worked, even through the relay';
const NO_SHOW = 'the peer did not join the retry';

interface Internals {
  keystore: Keystore;
  identityPromise: unknown;
  privacyMode: PrivacyMode;
  peer: Pc | null;
  peerId: string | null;
  selfId: string | null;
  signaling: InstanceType<typeof hoisted.FakeSignaling> | null;
  linkSecret: Uint8Array | null;
  sessionKey: Uint8Array | null;
  sas: { myNonce: Uint8Array } | null;
  established: boolean;
}

function side(mode: PrivacyMode = 'max') {
  const store = configureStore({ reducer: { connection, transfer, history, dev } });
  const sc = new SessionController(store.dispatch);
  const internals = sc as unknown as Internals;
  internals.keystore = new Keystore(new MemoryKeystoreBackend());
  internals.identityPromise = null;
  sc.setPrivacyMode(mode);
  return { sc, store, internals, state: () => store.getState().connection, log: () => store.getState().dev.log };
}
type Side = ReturnType<typeof side>;

const settle = (ms = 20): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
/** The identity key and its signatures are WebCrypto: they finish on the real event loop, which the
 *  fake clock does not turn — so the paths that sign (enrollment, the reconnect proof) are drained. */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const pc = (s: Side): Pc => {
  if (!s.internals.peer) throw new Error('no PeerConnection on this side');
  return s.internals.peer;
};
const framesOfKind = (kind: string): unknown[] =>
  hub.frames.map((f) => f.data).filter((d) => (d as { kind?: string }).kind === kind);

async function pairByLink(a: Side, b: Side): Promise<void> {
  void a.sc.createLinkSession('link');
  await settle();
  const url = a.state().credential![0];
  const link = parseLink(url.slice(url.indexOf('#')))!;
  void b.sc.joinLinkSession(link.rendezvous, link.secret, 'link');
  await settle();
}

async function pairByWords(a: Side, b: Side, wrong = false): Promise<void> {
  void a.sc.createWordsSession();
  await settle();
  const words = [...a.state().credential!];
  if (wrong) words[4] = words[4] === words[3] ? words[2] : words[3];
  void b.sc.joinWordsSession(words);
  await settle();
}

async function pairByRoom(a: Side, b: Side): Promise<void> {
  void a.sc.createRoomSession();
  await settle();
  void b.sc.joinRoomSession(a.state().room!);
  await settle();
  b.sc.pickPeer(a.internals.selfId!);
  await settle();
}

async function failIce(...sides: Side[]): Promise<void> {
  for (const s of sides) pc(s).failIce();
  await settle();
}

async function openChannel(a: Side, b: Side): Promise<void> {
  pc(a).open();
  pc(b).open();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  hub.reset();
  pcs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a link pairing that could not connect directly', () => {
  it('both sides are offered the retry, and nothing has asked for a relay', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    for (const s of [a, b]) {
      expect(s.state().status).toBe('failed');
      expect(s.state().error).toBe(DIRECT);
      expect(s.state().relayRetry).toBe('offered');
      expect(s.state().peerAsksRelay).toBe(false);
      expect(s.internals.signaling!.closed).toBe(false);
    }
    expect(hub.turnRequests).toEqual([]);
  });

  it('one tap: that side waits at the derived rendezvous; the other only learns it was asked', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    const token = relayRetryToken(pc(a).fp, pc(b).fp)!;
    await failIce(a, b);

    void a.sc.retryWithRelay();
    await settle();

    expect(a.state()).toMatchObject({ status: 'awaitingPeer', method: 'link', relayRetry: 'active' });
    expect(a.internals.signaling!.room).toBe(token);
    expect(a.internals.privacyMode).toBe('reliable');
    // The other side: a line of copy. Still failed, still Max, no socket taken, no connection built.
    expect(b.state()).toMatchObject({ status: 'failed', relayRetry: 'offered', peerAsksRelay: true });
    expect(b.internals.privacyMode).toBe('max');
    expect(b.internals.peer).toBeNull();
    expect(hub.taken.filter((r) => r === token)).toHaveLength(1);
    // Nobody has asked for a relay: the one who tapped is alone, the other has not tapped.
    expect(hub.turnRequests).toEqual([]);
  });

  it('both tap: the same pairing connects in Reliable — no new invite, the secret authenticates the new channel', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    const secret = a.internals.linkSecret!;
    const failed = [pc(a).fp, pc(b).fp];
    await failIce(a, b);

    void a.sc.retryWithRelay();
    await settle();
    void b.sc.retryWithRelay();
    await settle();

    expect(a.state().status).toBe('pairing');
    expect(b.state().status).toBe('pairing');
    // Each side asked for credentials once, on the retry socket, after the peer was there.
    expect(hub.turnRequests.sort()).toEqual([a.internals.signaling!.id, b.internals.signaling!.id].sort());
    for (const s of [a, b]) {
      expect(pc(s).config.filterRelay).toBe(false);
      expect(JSON.stringify(pc(s).config.iceServers)).toContain('turn:relay.test');
      expect(failed).not.toContain(pc(s).fp); // a new certificate
    }

    await openChannel(a, b);

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
    // Two rooms in all: the link's and the retry's. No second invite was ever made.
    expect(new Set(hub.taken).size).toBe(2);
    expect(a.state().credential).toBeNull();
    // Nothing secret crossed the hub.
    expect(JSON.stringify(hub.frames)).not.toContain(bytesToHex(secret));
    expect(a.internals.linkSecret).toEqual(secret);
  });

  it('the order of the taps does not matter, and a side that taps twice starts nothing twice', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    void b.sc.retryWithRelay();
    void a.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
    expect(hub.turnRequests).toHaveLength(2);
  });

  it('a peer at the rendezvous without the link secret fails the confirmation — no bytes', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    b.internals.linkSecret = crypto.getRandomValues(new Uint8Array(16)); // whoever the server let in

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);

    for (const s of [a, b]) {
      expect(s.state().status).toBe('failed');
      expect(s.state().error).toMatch(/key-confirmation mismatch/);
      expect(s.internals.established).toBe(false);
      expect(s.state().relayRetry).toBe('active'); // and no second retry
    }
  });
});

describe('the `relay-retry` frame — from the untrusted server it is a line of copy, never a trigger', () => {
  const forge = (to: Side, from = to.internals.peerId!): void => {
    to.internals.signaling!.handlers.onSignal?.(from, { kind: 'relay-retry' });
  };

  it('forged at a failed Max side: the prompt, and nothing else', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    const rooms = hub.taken.length;

    forge(a);
    await settle();

    expect(a.state()).toMatchObject({ status: 'failed', relayRetry: 'offered', peerAsksRelay: true });
    expect(a.internals.privacyMode).toBe('max');
    expect(a.internals.peer).toBeNull();
    expect(hub.taken).toHaveLength(rooms);
    expect(hub.turnRequests).toEqual([]);
    expect(b.state().peerAsksRelay).toBe(false);
  });

  it('repeated: one prompt', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    forge(a);
    forge(a);
    forge(a);
    await settle();

    expect(a.log().filter((l) => l.includes('the peer asks to continue'))).toHaveLength(1);
    expect(a.state().status).toBe('failed');
  });

  it('early, while the direct attempt still runs: remembered for the failure screen, the attempt goes on', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);

    forge(a);
    await settle();
    expect(a.state()).toMatchObject({ status: 'pairing', peerAsksRelay: true, relayRetry: 'none' });
    expect(pc(a).closed).toBe(false);

    await failIce(a, b);
    expect(a.state()).toMatchObject({ status: 'failed', relayRetry: 'offered', peerAsksRelay: true });
    expect(hub.turnRequests).toEqual([]);
  });

  it('from anyone but the paired peer: ignored', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    forge(a, 'p9999');
    await settle();

    expect(a.state().peerAsksRelay).toBe(false);
  });

  it('late — in the retry itself, and on an authenticated channel: ignored', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    forge(a);
    await settle();
    expect(a.state().peerAsksRelay).toBe(false);

    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
    const before = hub.taken.length;
    a.internals.signaling!.handlers.onSignal?.(a.internals.peerId!, { kind: 'relay-retry' });
    await settle();
    expect(a.state()).toMatchObject({ status: 'connected', peerAsksRelay: false });
    expect(hub.taken).toHaveLength(before);
  });
});

describe('a peer that never answers', () => {
  it('the wait ends by itself with the no-show reason; the other side was never moved', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    void a.sc.retryWithRelay();
    await settle();
    await settle(149_000);
    expect(a.state().status).toBe('awaitingPeer');
    await settle(2_000);

    expect(a.state()).toMatchObject({ status: 'failed', error: NO_SHOW, relayRetry: 'active' });
    expect(a.internals.signaling!.closed).toBe(true);
    expect(b.state()).toMatchObject({ status: 'failed', error: DIRECT });
    expect(b.internals.privacyMode).toBe('max');
    expect(hub.turnRequests).toEqual([]);
  });

  it('the server closing the retry room under the waiting side reads the same', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    await settle();

    a.internals.signaling!.handlers.onClose?.(4010, 'expired');
    await settle();

    expect(a.state()).toMatchObject({ status: 'failed', error: NO_SHOW });
  });

  it('then "Start over" is the fallback: the side that made the invite makes a new one, in Reliable', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    await settle(151_000);
    const rooms = new Set(hub.taken).size;

    void a.sc.startOverWithRelay();
    await settle();

    expect(a.state()).toMatchObject({ status: 'awaitingPeer', method: 'link', relayRetry: 'none' });
    expect(a.state().credential).toHaveLength(1);
    expect(new Set(hub.taken).size).toBe(rooms + 1);
    expect(a.internals.privacyMode).toBe('reliable');
  });

  it('and for the side that was invited it is home, in Reliable', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void b.sc.retryWithRelay();
    await settle(151_000);
    expect(b.state().error).toBe(NO_SHOW);

    void b.sc.startOverWithRelay();
    await settle();

    expect(b.state().status).toBe('idle');
    expect(b.internals.privacyMode).toBe('reliable');
  });
});

describe('one retry per pairing', () => {
  it('a retry that finds no path either is terminal: no second offer, and the button starts over', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    await failIce(a, b);

    for (const s of [a, b]) expect(s.state()).toMatchObject({ status: 'failed', error: NO_PATH, relayRetry: 'active' });

    const rooms = new Set(hub.taken).size;
    void a.sc.retryWithRelay();
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', relayRetry: 'none' });
    expect(a.state().credential).toHaveLength(1); // a NEW link — the fallback
    expect(new Set(hub.taken).size).toBe(rooms + 1);
  });
});

describe('words — the CPace key of the failed attempt, never a second CPace', () => {
  it('both tap: connected, and the retry exchanged no CPace frame', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b);
    const key = a.internals.sessionKey!;
    expect(key).toEqual(b.internals.sessionKey);
    expect(framesOfKind('cpace')).toHaveLength(2);
    await failIce(a, b);
    expect(a.state().relayRetry).toBe('offered');

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
    expect(framesOfKind('cpace')).toHaveLength(2); // still only the failed attempt's two
    expect(a.internals.sessionKey).toEqual(key);
    expect(JSON.stringify(hub.frames)).not.toContain(bytesToHex(key));
  });

  it('a joiner that guessed wrong gets no second guess: the retry ends on the mismatch, for good', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b, /* wrong */ true);
    expect(a.internals.sessionKey).not.toEqual(b.internals.sessionKey);
    await failIce(a, b);

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);

    // The creator does NOT go back to its words for another joiner: this code is over.
    expect(a.state()).toMatchObject({ status: 'failed', relayRetry: 'active' });
    expect(a.state().error).toMatch(/key-confirmation mismatch/);
    expect(a.internals.established).toBe(false);
    expect(framesOfKind('cpace')).toHaveLength(2);
  });
});

describe('room — the SAS runs again over the new fingerprints', () => {
  it('both tap: no pick at the rendezvous, a fresh nonce, the same three words on both sides, connected after both confirm', async () => {
    const [a, b] = [side(), side()];
    await pairByRoom(a, b);
    expect(a.state().status).toBe('pairing');
    const nonce = a.internals.sas!.myNonce;
    await failIce(a, b);
    expect(a.state().relayRetry).toBe('offered');
    expect(b.state().relayRetry).toBe('offered');

    void a.sc.retryWithRelay();
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', method: 'room', relayRetry: 'active' });
    void b.sc.retryWithRelay();
    await settle();
    expect(a.state().status).toBe('pairing'); // paired without anyone picking
    expect(a.internals.sas!.myNonce).not.toEqual(nonce);

    await openChannel(a, b);
    expect(a.state().status).toBe('awaitingSas');
    expect(a.state().sas).toBeTruthy();
    expect(a.state().sas).toBe(b.state().sas);
    expect(a.internals.established).toBe(false);

    a.sc.confirmSas(true);
    b.sc.confirmSas(true);
    await settle();
    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
  });

  it('a third member of the lobby is not taken along', async () => {
    const [a, b, c] = [side(), side(), side()];
    void a.sc.createRoomSession();
    await settle();
    void b.sc.joinRoomSession(a.state().room!);
    void c.sc.joinRoomSession(a.state().room!);
    await settle();
    b.sc.pickPeer(a.internals.selfId!);
    await settle();
    await failIce(a, b);

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    expect(a.state().status).toBe('pairing');
    expect(c.state()).toMatchObject({ status: 'awaitingPeer', relayRetry: 'none', peerAsksRelay: false });
  });
});

describe('reconnect — the pin authenticates the retried transport', () => {
  it('both tap: back at the derived rendezvous in Reliable, hello → proof → ok, connected', async () => {
    const [a, b] = [side('reliable'), side('reliable')];
    await pairByLink(a, b);
    await openChannel(a, b);
    await drain();
    const pairingId = a.store.getState().dev.pinnedPeer?.pairingId;
    expect(pairingId).toBeTruthy();
    expect(b.store.getState().dev.pinnedPeer?.pairingId).toBe(pairingId);
    a.sc.dispose();
    b.sc.dispose();
    a.sc.setPrivacyMode('max');
    b.sc.setPrivacyMode('max');
    hub.turnRequests.length = 0;

    void a.sc.reconnectTo(pairingId!);
    void b.sc.reconnectTo(pairingId!);
    await settle();
    expect(a.state()).toMatchObject({ status: 'pairing', method: 'reconnect' });
    await failIce(a, b);
    for (const s of [a, b]) expect(s.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered' });
    expect(hub.turnRequests).toEqual([]);

    void a.sc.retryWithRelay();
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', method: 'reconnect', relayRetry: 'active' });
    expect(b.state()).toMatchObject({ status: 'failed', peerAsksRelay: true });
    void b.sc.retryWithRelay();
    await settle();
    expect(hub.turnRequests).toHaveLength(2);
    await openChannel(a, b);
    await drain();

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
    expect(a.store.getState().dev.reconnect.outcome).toBe('authenticated');
  });
});

describe('a mixed pair — one side already in Reliable', () => {
  it('the Reliable side ends on "no path" with its socket open and the retry offered; both tap, same rendezvous, connected', async () => {
    const [a, b] = [side('reliable'), side('max')];
    await pairByLink(a, b);
    const token = relayRetryToken(pc(a).fp, pc(b).fp)!;
    expect(pc(a).config.filterRelay).toBe(false);
    expect(pc(b).config.filterRelay).toBe(true);
    await failIce(a, b);

    expect(a.state()).toMatchObject({ status: 'failed', error: NO_PATH, relayRetry: 'offered' });
    expect(a.internals.signaling!.closed).toBe(false);
    expect(b.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered' });
    // Only the Reliable side ever asked for credentials; the Max side has not, and does not yet.
    expect(hub.turnRequests).toHaveLength(1);

    void b.sc.retryWithRelay();
    await settle();
    expect(a.state().peerAsksRelay).toBe(true);
    expect(a.state().status).toBe('failed'); // it does not follow by itself
    void a.sc.retryWithRelay();
    await settle();
    expect(a.internals.signaling!.room).toBe(token);
    await openChannel(a, b);

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
  });

  it('a words creator in Reliable no longer returns to its words on "no path": the code is over, the pairing can continue', async () => {
    const [a, b] = [side('reliable'), side('max')];
    await pairByWords(a, b);
    await failIce(a, b);

    expect(a.state()).toMatchObject({ status: 'failed', error: NO_PATH, relayRetry: 'offered' });

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
  });

  it('Reliable with no relay to offer keeps its old reason and is offered nothing', async () => {
    hub.turn = { urls: [], username: '', credential: '' };
    const [a, b] = [side('reliable'), side('max')];
    await pairByLink(a, b);
    await failIce(a, b);

    expect(a.state()).toMatchObject({ status: 'failed', error: 'channel closed during pairing', relayRetry: 'none' });
  });
});

describe('where nothing can be continued', () => {
  it('a failure that left no two fingerprints offers no retry, and the button starts over', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    pc(a).remoteFp = null; // no answer ever arrived
    await failIce(a);

    expect(a.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'none' });

    void a.sc.retryWithRelay();
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', relayRetry: 'none' });
    expect(a.state().credential).toHaveLength(1);
  });
});
