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
    /** while true a TURN request stays unanswered, as on the wire, until answerTurn() or the socket's
     *  own close() */
    turnHold: false,
    /** while true connect() stays pending; the socket's close() rejects it (closed while CONNECTING) */
    connectHold: false,
    sockets: [] as FakeSignaling[],
    seq: 0,
    reset(): void {
      hub.rooms.clear();
      hub.taken.length = 0;
      hub.frames.length = 0;
      hub.turnRequests.length = 0;
      hub.turn = RELAY;
      hub.turnHold = false;
      hub.connectHold = false;
      hub.sockets.length = 0;
      hub.seq = 0;
    },
    /** Answer every TURN request that was held. */
    answerTurn(): void {
      for (const socket of hub.sockets) socket.settleTurn(hub.turn);
    },
  };
  const NO_TURN = { urls: [] as string[], username: '', credential: '' };

  class FakeSignaling {
    id = '';
    room = '';
    closed = false;
    /** the SERVER closed it (serverClose) */
    dead = false;
    private turnPending: ((t: typeof NO_TURN) => void) | null = null;
    private rejectConnect: ((err: Error) => void) | null = null;
    constructor(
      _url: string,
      public handlers: Handlers,
    ) {
      hub.sockets.push(this);
    }
    async connect(opts: { create: true } | { join: string }): Promise<void> {
      if (hub.connectHold) {
        return new Promise<void>((_resolve, reject) => {
          this.rejectConnect = reject;
        });
      }
      hub.seq += 1;
      this.id = `p${String(hub.seq).padStart(4, '0')}`;
      this.room = 'create' in opts ? `created-${hub.seq}` : opts.join;
      const members = hub.rooms.get(this.room) ?? [];
      hub.rooms.set(this.room, members);
      const earlier = [...members];
      members.push(this);
      hub.taken.push(this.room);
      setTimeout(() => {
        if (this.closed || this.dead) return;
        this.handlers.onWelcome?.(
          this.id,
          this.room,
          earlier.filter((m) => !m.closed && !m.dead).map((m) => ({ id: m.id, joinedAt: 0 })),
        );
        for (const m of earlier) if (!m.closed && !m.dead) m.handlers.onPeerJoined?.({ id: this.id, joinedAt: 0 });
      }, 0);
    }
    send(to: string, data: unknown): void {
      if (this.closed || this.dead) return;
      hub.frames.push({ room: this.room, from: this.id, to, data });
      const target = hub.rooms.get(this.room)?.find((m) => m.id === to);
      const from = this.id;
      if (target) setTimeout(() => !target.closed && !target.dead && target.handlers.onSignal?.(from, data), 0);
    }
    destroyRoom(): void {}
    async requestTurnCredentials(): Promise<{ urls: string[]; username: string; credential: string }> {
      if (this.closed || this.dead) return NO_TURN;
      hub.turnRequests.push(this.id);
      if (!hub.turnHold) return hub.turn;
      return new Promise((resolve) => {
        this.turnPending = resolve;
      });
    }
    settleTurn(t: typeof NO_TURN): void {
      const pending = this.turnPending;
      this.turnPending = null;
      pending?.(t);
    }
    private leave(): void {
      const members = hub.rooms.get(this.room) ?? [];
      const at = members.indexOf(this);
      if (at >= 0) members.splice(at, 1);
      const id = this.id;
      for (const m of members) setTimeout(() => !m.closed && !m.dead && m.handlers.onPeerLeft?.(id), 0);
    }
    /** Our own close, as SignalingClient.close(): a pending TURN request resolves empty, a pending
     *  connect rejects, and no handler of ours fires. */
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.settleTurn(NO_TURN);
      if (this.rejectConnect) {
        const reject = this.rejectConnect;
        this.rejectConnect = null;
        setTimeout(() => reject(new Error('signaling connection failed')), 0);
        return;
      }
      if (!this.dead) this.leave();
    }
    /** The SERVER closes this socket, after a room-closed frame when the room expired. */
    serverClose(code: number, reason: string, roomClosed = false): void {
      if (this.closed || this.dead) return;
      if (roomClosed) this.handlers.onRoomClosed?.(reason);
      this.dead = true;
      this.leave();
      this.handlers.onClose?.(code, reason);
    }
  }

  interface PcHandlers {
    onSignal: (data: unknown) => void;
    onOpen: () => void;
    onClose: (why?: string) => void;
    onMessage: (data: string | ArrayBuffer) => void;
    onIceFailed: () => void;
    onTampered: (reason: string) => void;
  }
  const TAMPERED =
    'the connection description was tampered with — it must name exactly one certificate (possible man-in-the-middle)';
  const pcs: MockPeerConnection[] = [];
  let certs = 0;
  class MockPeerConnection {
    /** a new certificate per connection, as a browser makes */
    readonly fp = `AA:BB:${String(++certs).padStart(4, '0')}`;
    remoteFp: string | null = null;
    closed = false;
    /** everything this side put on the channel, in order */
    readonly sent: (string | ArrayBuffer)[] = [];
    /** while true, what this side sends is recorded but not delivered — the test delivers something else */
    hold = false;
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
      this.sent.push(data);
      if (this.hold) return;
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
    /** The real wrapper refused the peer's description (core/webrtc/fingerprint.ts). */
    refuseDescription(): void {
      this.handlers.onTampered(TAMPERED);
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
  sas: { myNonce: Uint8Array; localApproved: boolean } | null;
  reconnect: { myChallenge: Uint8Array } | null;
  pendingPeerSignals: unknown[];
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

const realSetTimeout = setTimeout;
const settle = (ms = 20): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
/** The identity key and its signatures are WebCrypto: they finish on the real event loop, which the
 *  fake clock does not turn — so the paths that sign (enrollment, the reconnect proof) are drained.
 *  Where 25 turns are not enough it goes on until `done`, four real seconds at most, moving the fake
 *  clock at the pace of the real one: what the signature unblocks runs on fake timers. */
async function drain(done?: () => boolean): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const deadline = performance.now() + 4000;
  while (done && !done() && performance.now() < deadline) {
    await settle(5);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}
const pc = (s: Side): Pc => {
  if (!s.internals.peer) throw new Error('no PeerConnection on this side');
  return s.internals.peer;
};
const framesOfKind = (kind: string): unknown[] =>
  hub.frames.map((f) => f.data).filter((d) => (d as { kind?: string }).kind === kind);

/** Everything the server saw: every relayed frame AND every room name. */
const seenByHub = (): string => JSON.stringify({ frames: hub.frames, rooms: hub.taken });
/** A secret in every form it could have travelled in. */
function formsOf(secret: Uint8Array): string[] {
  const b64 = btoa(String.fromCharCode(...secret));
  return [bytesToHex(secret), b64, b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')];
}
function expectNotSeenByHub(what: string, ...secrets: string[]): void {
  const seen = seenByHub();
  for (const secret of secrets) expect(seen.includes(secret), `${what} reached the server`).toBe(false);
}
/** Every string the server was handed as a VALUE: the room names and the leaves of each frame, bar
 *  the protocol's own `kind` / `type` labels. A dictionary word is looked for among these whole
 *  values — as a substring of everything it would also "appear" inside a key or a hex run. */
function valuesSeenByHub(): string[] {
  const values: string[] = [...hub.taken];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') values.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) if (key !== 'kind' && key !== 'type') walk(value);
    }
  };
  for (const frame of hub.frames) walk(frame.data);
  return values;
}
/** The `kind` of every JSON frame a connection sent over its channel. */
const kindsSent = (c: Pc): string[] =>
  c.sent.map((d) => (typeof d === 'string' ? ((JSON.parse(d) as { kind?: string; t?: string }).kind ?? 'transfer') : 'bytes'));
const expired = (s: Side): void => s.internals.signaling!.serverClose(4010, 'expired', /* room-closed first */ true);

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

/** The three methods that pair two fresh sides in one call. */
const pairings = { link: pairByLink, words: pairByWords, room: pairByRoom } as const;

/** Two devices that have met (a link pairing, enrolled), reconnecting in Max privacy, both in `pairing`. */
async function pairByReconnect(): Promise<[Side, Side]> {
  const [a, b] = [side('reliable'), side('reliable')];
  await pairByLink(a, b);
  await openChannel(a, b);
  await drain(() => !!a.store.getState().dev.pinnedPeer && !!b.store.getState().dev.pinnedPeer);
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
  return [a, b];
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
    // Nothing secret reached the server — in a frame or as a room name, in any encoding.
    expectNotSeenByHub('the link secret', ...formsOf(secret));
    expect(a.internals.linkSecret).toEqual(secret);
    // And over the retried channel itself: the confirmation tag first, then only what an
    // authenticated channel carries by itself (the path attestation, the enrollment) — no file frame.
    for (const s of [a, b]) {
      expect(kindsSent(pc(s))[0]).toBe('confirm');
      expect(kindsSent(pc(s)).filter((k) => !['confirm', 'path-attest', 'enroll-init', 'enroll-ack'].includes(k))).toEqual([]);
    }
  });

  it('the order of the taps does not matter, and a side that taps twice starts nothing twice', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    const token = relayRetryToken(pc(a).fp, pc(b).fp)!;
    await failIce(a, b);

    void b.sc.retryWithRelay();
    void b.sc.retryWithRelay(); // the same tap, twice
    void a.sc.retryWithRelay();
    await settle();
    void a.sc.retryWithRelay(); // again, while the retry is pairing
    void b.sc.retryWithRelay();
    await settle();

    expect(a.state()).toMatchObject({ status: 'pairing', relayRetry: 'active' });
    expect(hub.taken.filter((r) => r === token)).toHaveLength(2); // one socket each
    expect(hub.turnRequests).toHaveLength(2);
    expect(pcs).toHaveLength(4); // two failed, two retried — not one more

    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');

    // …and once connected: not a way to start over either.
    const rooms = hub.taken.length;
    void a.sc.retryWithRelay();
    await settle();
    expect(a.state().status).toBe('connected');
    expect(hub.taken).toHaveLength(rooms);
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

    const retried = pcs.slice(-2);
    for (const s of [a, b]) {
      expect(s.state().status).toBe('failed');
      expect(s.state().error).toMatch(/key-confirmation mismatch/);
      expect(s.internals.established).toBe(false);
      expect(s.state().relayRetry).toBe('active'); // and no second retry
      expect(s.internals.peer).toBeNull();
    }
    // The channel carried the two tags and nothing after them, and it is closed on both sides.
    for (const c of retried) {
      expect(kindsSent(c)).toEqual(['confirm']);
      expect(c.closed).toBe(true);
    }
    // Neither direction of a transfer exists on the failed session.
    a.sc.sendFiles([new File(['x'], 'x.txt')]);
    expect(a.store.getState().transfer).toMatchObject({ phase: 'error', error: 'not connected' });
    retried[1].handlers.onMessage(JSON.stringify({ t: 'offer-file', name: 'x.txt', size: 1, isZip: false }));
    await settle();
    expect(b.store.getState().transfer.phase).toBe('idle');
    expect(retried.flatMap(kindsSent)).toEqual(['confirm', 'confirm']);
  });

  it('a tag reflected back to its sender is refused', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    pc(b).hold = true; // the peer's own tag never arrives; the server sends ours back instead
    const mine = pc(a);
    await openChannel(a, b);
    expect(kindsSent(mine)).toEqual(['confirm']);

    mine.handlers.onMessage(mine.sent[0]);
    await settle();

    expect(a.state().status).toBe('failed');
    expect(a.state().error).toMatch(/key-confirmation mismatch/);
    expect(a.internals.established).toBe(false);
  });

  it('a tag of the failed attempt, replayed into the retry, is refused: it was made over other fingerprints', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    // The failed attempt got as far as one side's channel opening and its tag going out.
    pc(a).open();
    await settle();
    const oldTag = pc(a).sent[0];
    expect(kindsSent(pc(a))).toEqual(['confirm']);
    await failIce(a, b);
    expect(a.state().relayRetry).toBe('offered');
    expect(b.state().relayRetry).toBe('offered');

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    pc(a).hold = true;
    const theirs = pc(b);
    await openChannel(a, b);
    theirs.handlers.onMessage(oldTag);
    await settle();

    expect(b.state().status).toBe('failed');
    expect(b.state().error).toMatch(/key-confirmation mismatch/);
    expect(b.internals.established).toBe(false);
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

describe('a failed side that has not tapped — nothing else the server sends moves it either', () => {
  /** What must not have changed: failed, no connection, no room taken, no relay asked for. */
  function untouched(s: Side, rooms: number, connections: number, turn: number): void {
    expect(s.state().status).toBe('failed');
    expect(s.internals.peer).toBeNull();
    expect(s.internals.pendingPeerSignals).toHaveLength(0);
    expect(hub.taken).toHaveLength(rooms);
    expect(pcs).toHaveLength(connections);
    expect(hub.turnRequests).toHaveLength(turn);
  }

  it('a forged peer-joined, a replayed offer, a replayed candidate, a second welcome', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    const [rooms, connections] = [hub.taken.length, pcs.length];
    const socket = a.internals.signaling!.handlers;
    const peer = a.internals.peerId!;

    socket.onPeerJoined?.({ id: 'p9999', joinedAt: 0 });
    socket.onSignal?.(peer, { type: 'offer', fp: 'AA:BB:9999' });
    socket.onSignal?.(peer, { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.9 9 typ relay' } });
    socket.onWelcome?.('p0000', 'elsewhere', [{ id: 'p9999', joinedAt: 0 }]);
    socket.onPeerLeft?.(peer);
    await settle();

    untouched(a, rooms, connections, 0);
    expect(a.state()).toMatchObject({ relayRetry: 'offered', error: DIRECT });
    expect(a.internals.privacyMode).toBe('max');
  });

  for (const mode of ['max', 'reliable'] as const) {
    it(`room, ${mode}: a forged busy and pair-request from the failed pairing's peer start no new pairing`, async () => {
      const [a, b] = [side(mode), side('max')];
      await pairByRoom(a, b);
      await failIce(a, b);
      expect(a.state()).toMatchObject({ status: 'failed', relayRetry: 'offered' });
      expect(a.internals.signaling!.closed).toBe(false); // the lobby socket is where the retry notice arrives
      const [rooms, connections, turn] = [hub.taken.length, pcs.length, hub.turnRequests.length];
      const socket = a.internals.signaling!.handlers;
      const peer = a.internals.peerId!;

      socket.onSignal?.(peer, { kind: 'busy' });
      socket.onSignal?.(peer, { kind: 'pair-request' });
      await settle();

      untouched(a, rooms, connections, turn);
      expect(a.state().relayRetry).toBe('offered');
    });
  }

  it('room: another lobby member that picks the failed side is told it is busy, and nothing else happens', async () => {
    const [a, b, c] = [side(), side(), side()];
    void a.sc.createRoomSession();
    await settle();
    void b.sc.joinRoomSession(a.state().room!);
    void c.sc.joinRoomSession(a.state().room!);
    await settle();
    b.sc.pickPeer(a.internals.selfId!);
    await settle();
    await failIce(a, b);
    const [rooms, connections] = [hub.taken.length, pcs.length];

    c.sc.pickPeer(a.internals.selfId!);
    await settle();

    expect(a.state().status).toBe('failed');
    expect(a.internals.peer).toBeNull();
    expect(hub.taken).toHaveLength(rooms);
    expect(pcs).toHaveLength(connections + 1); // c's own attempt, torn down by the busy answer
    expect(c.state()).toMatchObject({ status: 'awaitingPeer', notice: { kind: 'busy', peerId: a.internals.selfId } });
  });

  it('frames from a socket the controller has let go do not reach the next session', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    const old = a.internals.signaling!.handlers;
    const peer = a.internals.peerId!;
    a.sc.dispose();
    const [rooms, connections] = [hub.taken.length, pcs.length];

    old.onSignal?.(peer, { kind: 'relay-retry' });
    old.onPeerJoined?.({ id: 'p9999', joinedAt: 0 });
    old.onSignal?.(peer, { type: 'offer', fp: 'AA:BB:9999' });
    old.onClose?.(4010, 'expired');
    await settle();

    expect(a.state()).toMatchObject({ status: 'idle', peerAsksRelay: false, relayRetry: 'none', roster: [] });
    expect(a.internals.peer).toBeNull();
    expect(hub.taken).toHaveLength(rooms);
    expect(pcs).toHaveLength(connections);
  });

  it('the notice is the engaged peer\'s: a words creator back at its words does not carry an earlier joiner\'s', async () => {
    const [a, c, b] = [side(), side(), side()];
    void a.sc.createWordsSession();
    await settle();
    const words = [...a.state().credential!];
    const wrong = [...words];
    wrong[4] = wrong[4] === wrong[3] ? wrong[2] : wrong[3];
    void c.sc.joinWordsSession(wrong);
    await settle();
    a.internals.signaling!.handlers.onSignal?.(a.internals.peerId!, { kind: 'relay-retry' });
    expect(a.state().peerAsksRelay).toBe(true);
    await openChannel(a, c); // the wrong guess: the creator is back at its words for the next joiner
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', peerAsksRelay: false });

    void b.sc.joinWordsSession(words);
    await settle();
    await failIce(a, b);

    expect(a.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered', peerAsksRelay: false });
  });
});

describe('a peer that never answers', () => {
  it('the wait ends by itself with the no-show reason; the other side was never moved', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);

    void a.sc.retryWithRelay();
    await settle();
    await settle(119_000);
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
    await settle(121_000);
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
    await settle(121_000);
    expect(b.state().error).toBe(NO_SHOW);

    void b.sc.startOverWithRelay();
    await settle();

    expect(b.state().status).toBe('idle');
    expect(b.internals.privacyMode).toBe('reliable');
  });
});

describe('one retry per pairing', () => {
  for (const [method, pair] of Object.entries(pairings)) {
    it(`${method}: a retry that finds no path either is terminal — no second offer; its socket, its secret and its timers are gone`, async () => {
      const [a, b] = [side(), side()];
      await pair(a, b);
      await failIce(a, b);
      void a.sc.retryWithRelay();
      void b.sc.retryWithRelay();
      await settle();
      const token = a.internals.signaling!.room;

      await failIce(a, b);

      for (const s of [a, b]) {
        expect(s.state()).toMatchObject({ status: 'failed', error: NO_PATH, relayRetry: 'active' });
        expect(s.internals.signaling!.closed).toBe(true);
        expect(s.internals.linkSecret).toBeNull();
        expect(s.internals.sessionKey).toBeNull();
        expect(s.internals.peer).toBeNull();
      }
      expect(hub.rooms.get(token)).toHaveLength(0);
      await settle();
      expect(vi.getTimerCount()).toBe(0);

      // The button is not a second retry, and not a way to start over: that is "Start over"'s.
      const rooms = hub.taken.length;
      void a.sc.retryWithRelay();
      await settle();
      expect(a.state()).toMatchObject({ status: 'failed', error: NO_PATH });
      expect(hub.taken).toHaveLength(rooms);

      void a.sc.startOverWithRelay();
      await settle();
      expect(a.state()).toMatchObject({ status: 'awaitingPeer', relayRetry: 'none' }); // a NEW invite — the fallback
      expect(hub.taken).toHaveLength(rooms + 1);
    });
  }

  it('the other ways a retry ends drop the secret too: nobody came, the socket lost mid-pairing', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    await settle(121_000);
    expect(a.state().error).toBe(NO_SHOW);
    expect(a.internals.linkSecret).toBeNull();

    const [c, d] = [side(), side()];
    await pairByWords(c, d);
    await failIce(c, d);
    void c.sc.retryWithRelay();
    void d.sc.retryWithRelay();
    await settle();
    c.internals.signaling!.serverClose(1006, '');
    await settle();
    expect(c.state().error).toBe('signaling closed during the retry');
    expect(c.internals.sessionKey).toBeNull();
  });

  it('whichever side gives up on the path first, the other reads "no path" too, not "peer left"', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    await failIce(a); // a's ICE fails first and closes the retry socket; b's is still trying

    expect(a.state().error).toBe(NO_PATH);
    expect(b.state()).toMatchObject({ status: 'failed', error: NO_PATH, relayRetry: 'active' });
  });
});

describe('the retry does not depend on the rooms of the server', () => {
  it('words: the word room expires under the two failure screens — the CPace key stays, and both taps still connect', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b);
    const key = a.internals.sessionKey!;
    await failIce(a, b);

    expired(a); // 180 s after the words were made
    expired(b);
    await settle();

    for (const s of [a, b]) {
      expect(s.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered' });
      expect(s.internals.sessionKey).toEqual(key);
    }

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
  });

  it('link, room and reconnect keep theirs through the same expiry', async () => {
    const pairs: [string, Side, Side, string][] = [];
    const [l1, l2] = [side(), side()];
    await pairByLink(l1, l2);
    pairs.push(['link', l1, l2, 'connected']);
    const [r1, r2] = [side(), side()];
    await pairByRoom(r1, r2);
    pairs.push(['room', r1, r2, 'awaitingSas']);
    const [p1, p2] = await pairByReconnect();
    pairs.push(['reconnect', p1, p2, 'connected']);

    for (const [method, a, b, reached] of pairs) {
      await failIce(a, b);
      expired(a);
      expired(b);
      await settle();
      expect(a.state(), method).toMatchObject({ status: 'failed', relayRetry: 'offered' });

      void a.sc.retryWithRelay();
      void b.sc.retryWithRelay();
      await settle();
      await openChannel(a, b);
      await drain(() => a.state().status === reached && b.state().status === reached);
      expect(a.state().status, method).toBe(reached);
      expect(b.state().status, method).toBe(reached);
    }
  });

  it('room: the retry room expires in the middle of the comparison — the pairing goes on over the channel', async () => {
    const [a, b] = [side(), side()];
    await pairByRoom(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay(); // the retry room is made now, and lives 180 s
    await settle();
    await settle(110_000);
    void b.sc.retryWithRelay(); // the peer taps late, inside the wait
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('awaitingSas');

    await settle(70_000); // two people comparing three words; the room is 180 s old
    expired(a);
    expired(b);
    await settle();

    expect(a.state()).toMatchObject({ status: 'awaitingSas', error: null });
    expect(b.state()).toMatchObject({ status: 'awaitingSas', error: null });
    a.sc.confirmSas(true);
    b.sc.confirmSas(true);
    await settle();
    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
  });

  it('link: the socket closing after the channel opened does not end the confirmation', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    pc(b).hold = true; // b's tag is still on its way when the room goes
    await openChannel(a, b);
    expect(a.state().status).toBe('confirming');

    expired(a);
    await settle();
    expect(a.state().status).toBe('confirming');

    pc(a).handlers.onMessage(pc(b).sent[0]);
    await settle();
    expect(a.state().status).toBe('connected');
  });

  for (const [method, pair] of Object.entries(pairings)) {
    it(`${method}: before the channel is up the socket IS needed — its close ends the retry for good, connection and all`, async () => {
      const [a, b] = [side(), side()];
      await pair(a, b);
      await failIce(a, b);
      void a.sc.retryWithRelay();
      void b.sc.retryWithRelay();
      await settle();
      const [mine, theirs] = [pc(a), pc(b)];

      a.internals.signaling!.serverClose(1006, '');
      await settle();

      expect(a.state()).toMatchObject({ status: 'failed', error: 'signaling closed during the retry' });
      expect(mine.closed).toBe(true);
      expect(a.internals.peer).toBeNull();

      // A channel that opens afterwards authenticates nothing: the screen says failed, and so does the core.
      mine.open();
      theirs.open();
      await settle();
      expect(a.state().status).toBe('failed');
      expect(a.internals.established).toBe(false);
      expect(kindsSent(mine)).toEqual([]);
    });
  }
});

describe('a socket the server closes once the channel is open — outside the retry', () => {
  it('words creator, wrong words: the attempt ends and there is no room to wait in — the session ends, it does not go back to its words', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b, /* wrong */ true);
    pc(a).open(); // the joiner's channel is up; the tags are on their way
    await settle(0);
    a.internals.signaling!.serverClose(1006, ''); // a server restart: no room-closed frame, no expiry to come

    pc(b).open();
    await settle();

    expect(a.state().status).toBe('failed');
    expect(a.state().error).toBe('signaling closed (code 1006)');
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('words creator, a joiner that goes silent: the confirmation deadline ends the session the same way', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b);
    pc(b).hold = true; // its tag never arrives
    await openChannel(a, b);
    expect(a.state().status).toBe('confirming');
    a.internals.signaling!.serverClose(1006, '');
    await settle();
    expect(a.state().status).toBe('confirming'); // the attempt itself does not need the socket

    await settle(121_000);

    expect(a.state()).toMatchObject({ status: 'failed', error: 'signaling closed (code 1006)' });
  });

  it('words, the right words: the same close costs nothing — that is what the rule is for', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b);
    pc(b).hold = true;
    await openChannel(a, b);
    a.internals.signaling!.serverClose(1006, '');
    await settle();

    pc(a).handlers.onMessage(pc(b).sent[0]);
    await settle();

    expect(a.state().status).toBe('connected');
  });
});

describe('a step that comes back to a controller its session has left', () => {
  const starts: Record<string, (s: Side) => void> = {
    'createLinkSession': (s) => void s.sc.createLinkSession('link'),
    'createWordsSession': (s) => void s.sc.createWordsSession(),
    'createRoomSession': (s) => void s.sc.createRoomSession(),
    'joinRoomSession': (s) => void s.sc.joinRoomSession('4827'),
    'joinWordsSession': (s) => void s.sc.joinWordsSession(['bathrobe', 'gadget', 'spider', 'ladder', 'digit']),
    'joinLinkSession': (s) => void s.sc.joinLinkSession('k7Qm2vXa9LpR4nTdE0wYc3', new Uint8Array(16), 'link'),
  };

  for (const [name, start] of Object.entries(starts)) {
    it(`${name}: disposed while its socket was still opening — the rejection fails nothing, and the next invite works`, async () => {
      const a = side();
      hub.connectHold = true;
      start(a);
      await settle();
      a.sc.dispose(); // the socket is closed while CONNECTING: connect() rejects a moment later
      await settle();
      expect(a.state()).toMatchObject({ status: 'idle', error: null });

      hub.connectHold = false;
      void a.sc.createLinkSession('link');
      await settle();
      expect(a.state().status).toBe('awaitingPeer');
      expect(a.state().credential).toHaveLength(1);
    });
  }

  it('…and when the next session has already started, the rejection of the old one does not fail it', async () => {
    const [a, b] = [side(), side()];
    hub.connectHold = true;
    void a.sc.createLinkSession('link');
    await settle();
    a.sc.dispose();
    hub.connectHold = false;
    void a.sc.createLinkSession('link'); // started before the old connect() has rejected
    await settle();

    expect(a.state()).toMatchObject({ status: 'awaitingPeer', error: null });
    const url = a.state().credential![0];
    const link = parseLink(url.slice(url.indexOf('#')))!;
    void b.sc.joinLinkSession(link.rendezvous, link.secret, 'link');
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
  });

  it('a retry abandoned while its socket was opening leaves the controller usable too', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    hub.connectHold = true;
    void a.sc.retryWithRelay();
    await settle();
    a.sc.dispose();
    await settle();
    hub.connectHold = false;

    void a.sc.createLinkSession('link');
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', relayRetry: 'none' });
  });
});

describe('the pairing ends while the TURN credentials are still on their way (Reliable)', () => {
  it('words creator: a joiner that comes and goes during the fetch leaves no connection behind, and the next joiner pairs', async () => {
    const [a, gone, b] = [side('reliable'), side('reliable'), side('reliable')];
    void a.sc.createWordsSession();
    await settle();
    const words = [...a.state().credential!];
    hub.turnHold = true;
    void gone.sc.joinWordsSession(words);
    await settle();
    expect(a.state().status).toBe('pairing');
    gone.sc.dispose(); // left before the credentials came back
    await settle();
    expect(a.state().status).toBe('awaitingPeer');
    const connections = pcs.length;

    hub.answerTurn();
    await settle();
    expect(a.internals.peer).toBeNull();
    expect(pcs).toHaveLength(connections);

    hub.turnHold = false;
    void b.sc.joinWordsSession(words);
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
  });

  it('lobby: a pick answered busy during the fetch leaves none either — the next member that picks this side gets it', async () => {
    const [a, b, c, d] = [side('reliable'), side(), side(), side()];
    void b.sc.createRoomSession();
    await settle();
    for (const s of [a, c, d]) void s.sc.joinRoomSession(b.state().room!);
    await settle();
    c.sc.pickPeer(b.internals.selfId!); // b is taken
    await settle();
    hub.turnHold = true;
    a.sc.pickPeer(b.internals.selfId!);
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', notice: { kind: 'busy' } });
    const connections = pcs.length;

    hub.answerTurn();
    await settle();
    expect(a.internals.peer).toBeNull();
    expect(pcs).toHaveLength(connections);

    hub.turnHold = false;
    d.sc.pickPeer(a.internals.selfId!);
    await settle();
    expect(a.state()).toMatchObject({ status: 'pairing', peerId: d.internals.selfId });
    expect(d.state()).toMatchObject({ status: 'pairing', notice: null });
  });

  it('a retry that fails during the fetch stays as it failed: no connection appears, and "no relay" is not put on its screen', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    hub.turnHold = true;
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    expect(a.state().status).toBe('pairing');
    const connections = pcs.length;

    a.internals.signaling!.serverClose(1006, '');
    await settle();
    expect(a.state()).toMatchObject({ status: 'failed', error: 'signaling closed during the retry' });

    hub.turn = { urls: [], username: '', credential: '' }; // …and the answer, when it comes, is "no relay"
    hub.answerTurn();
    await settle(6_000);
    expect(a.internals.peer).toBeNull();
    expect(pcs.filter((p) => !p.closed)).toHaveLength(0);
    expect(pcs.length).toBeLessThanOrEqual(connections + 1); // b may have built its own before it ended; a built none
    expect(a.state()).toMatchObject({ status: 'failed', relayUnavailable: false });
  });

  it('disposed during the fetch: the idle controller holds nothing, and its next Max-privacy session pairs', async () => {
    const [a, gone, b] = [side('reliable'), side(), side()];
    void a.sc.createLinkSession('link');
    await settle();
    const first = parseLink(a.state().credential![0].slice(a.state().credential![0].indexOf('#')))!;
    hub.turnHold = true;
    void gone.sc.joinLinkSession(first.rendezvous, first.secret, 'link');
    await settle();
    expect(a.state().status).toBe('pairing');
    const connections = pcs.filter((p) => !p.config.filterRelay).length;

    a.sc.dispose(); // its close answers the pending request empty; the continuation runs after this
    await settle();
    expect(a.internals.peer).toBeNull();
    expect(pcs.filter((p) => !p.config.filterRelay)).toHaveLength(connections); // none built without the filter
    expect(a.state()).toMatchObject({ status: 'idle', relayUnavailable: false });

    hub.turnHold = false;
    a.sc.setPrivacyMode('max');
    await pairByLink(a, b);
    expect(pc(a).config.filterRelay).toBe(true);
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');
  });
});

describe('"no path even through the relay" is said only where a relay was in hand', () => {
  it('a retry with no relay to use: the side whose ICE gives up reads its plain reason, the other "peer left" — neither names a relay', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    hub.turn = { urls: [], username: '', credential: '' }; // the server has no relay to offer
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    expect(JSON.stringify(pc(a).config.iceServers)).not.toContain('turn:');

    await failIce(a);

    expect(a.state()).toMatchObject({ status: 'failed', error: 'channel closed during pairing', relayUnavailable: true });
    expect(b.state()).toMatchObject({ status: 'failed', error: 'peer left during pairing', relayUnavailable: true });
  });
});

describe('words — the CPace key of the failed attempt, never a second CPace', () => {
  it('both tap: connected, and the retry exchanged no CPace frame', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b);
    const [rendezvous, ...secret] = a.state().credential!;
    const secretWords = secret.filter((w) => w !== rendezvous); // the rendezvous word IS the room's name
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
    // Neither the key nor a secret word reached the server, in a frame or as a room name.
    expectNotSeenByHub('the CPace key', ...formsOf(key));
    const values = valuesSeenByHub();
    for (const word of secretWords) expect(values, `the secret word "${word}"`).not.toContain(word);
    expect(values).toContain(rendezvous); // the check does see words: the public one is there
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

  it('a CPace frame injected into the retry is not answered and changes no key: there is no second run to join', async () => {
    const [a, b] = [side(), side()];
    await pairByWords(a, b, /* wrong */ true);
    const [keyA, keyB] = [a.internals.sessionKey!, b.internals.sessionKey!];
    const first = framesOfKind('cpace')[0] as { sid: string; msg: string };
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    // The server replays the failed attempt's opening frame at both sides, as if a new run began.
    for (const s of [a, b]) s.internals.signaling!.handlers.onSignal?.(s.internals.peerId!, { kind: 'cpace', ...first });
    await settle();

    expect(framesOfKind('cpace')).toHaveLength(2); // nobody answered
    expect(a.internals.sessionKey).toEqual(keyA);
    expect(b.internals.sessionKey).toEqual(keyB);
    await openChannel(a, b);
    expect(a.state().error).toMatch(/key-confirmation mismatch/);
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

  it('an approval given in the failed attempt does not carry over: the retry needs both, again', async () => {
    const [a, b] = [side(), side()];
    await pairByRoom(a, b);
    await openChannel(a, b); // this attempt got as far as the comparison…
    const words = a.state().sas;
    a.sc.confirmSas(true); // …and one "matches"
    await settle();
    await failIce(a, b); // …before the path died
    for (const s of [a, b]) expect(s.state()).toMatchObject({ status: 'failed', relayRetry: 'offered' });

    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);

    expect(a.state().status).toBe('awaitingSas');
    expect(a.state().sas).not.toBe(words); // other certificates, other nonces
    expect(a.internals.sas!.localApproved).toBe(false);
    b.sc.confirmSas(true);
    await settle();
    expect(a.state().status).toBe('awaitingSas'); // a has not said "matches" for THIS channel
    expect(a.internals.established).toBe(false);
    expect(b.internals.established).toBe(false);
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
  it('both tap: at the retry rendezvous, not the pin\'s own; a fresh challenge; hello → proof → ok; connected', async () => {
    const [a, b] = await pairByReconnect();
    const bucketRoom = a.internals.signaling!.room;
    const token = relayRetryToken(pc(a).fp, pc(b).fp)!;
    const challenge = a.internals.reconnect!.myChallenge;
    await failIce(a, b);
    for (const s of [a, b]) expect(s.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered' });
    expect(hub.turnRequests).toEqual([]);

    void a.sc.retryWithRelay();
    await settle();
    expect(a.state()).toMatchObject({ status: 'awaitingPeer', method: 'reconnect', relayRetry: 'active' });
    // The peer's failed socket still sits in the pin's own room: meeting there would pair with it.
    expect(a.internals.signaling!.room).toBe(token);
    expect(token).not.toBe(bucketRoom);
    expect(a.internals.reconnect!.myChallenge).not.toEqual(challenge);
    expect(b.state()).toMatchObject({ status: 'failed', peerAsksRelay: true });
    expect(hub.turnRequests).toEqual([]);
    void b.sc.retryWithRelay();
    await settle();
    expect(hub.turnRequests).toHaveLength(2);
    await openChannel(a, b);
    await drain(() => a.state().status === 'connected' && b.state().status === 'connected');

    expect(a.state().status).toBe('connected');
    expect(b.state().status).toBe('connected');
    expect(a.store.getState().dev.reconnect.outcome).toBe('authenticated');
  });

  it('a hello sent back to its sender is refused — a peer that cannot make its own does not hold the pairing', async () => {
    const [a, b] = await pairByReconnect();
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    pc(b).hold = true;
    const mine = pc(a);
    await openChannel(a, b);
    await drain(() => kindsSent(mine).length > 0);
    expect(kindsSent(mine)).toEqual(['reconnect-hello']);

    mine.handlers.onMessage(mine.sent[0]);
    await drain(() => a.state().status === 'failed');

    expect(a.state().status).toBe('failed');
    expect(a.state().error).toMatch(/does not know this pairing/);
    expect(a.internals.established).toBe(false);
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

describe('a description that names two certificates, arriving in the retry', () => {
  // The retry builds a new PeerConnection, and that connection takes its one description under the
  // one-fingerprint rule like any other (PeerConnection.description.test.ts). What is checked here is
  // what the session does when it reports a refusal.
  for (const [method, pair] of Object.entries(pairings)) {
    it(`${method}: the retry fails closed as tampered — socket closed, nothing authenticated, no second retry`, async () => {
      const [a, b] = [side(), side()];
      await pair(a, b);
      await failIce(a, b);
      void a.sc.retryWithRelay();
      void b.sc.retryWithRelay();
      await settle();
      const [mine, theirs] = [pc(a), pc(b)];
      const token = a.internals.signaling!.room;

      mine.refuseDescription();
      await settle();

      expect(a.state()).toMatchObject({ status: 'failed', relayRetry: 'active' });
      expect(a.state().error).toMatch(/tampered with/);
      expect(a.internals.signaling!.closed).toBe(true);
      expect(a.internals.peer).toBeNull();
      expect(mine.closed).toBe(true);
      expect(a.internals.established).toBe(false);
      // The peer is left alone in the retry room and ends too; nobody is left there.
      expect(b.state().status).toBe('failed');
      expect(hub.rooms.get(token)).toHaveLength(0);

      // A channel on that connection, were it to open now, is nobody's.
      mine.open();
      theirs.open();
      await settle();
      expect(a.state().status).toBe('failed');
      expect(kindsSent(mine)).toEqual([]);

      const rooms = hub.taken.length;
      void a.sc.retryWithRelay();
      await settle();
      expect(hub.taken).toHaveLength(rooms);
    });
  }

  it('the rendezvous is derived from the validated fingerprints, and their spelling does not move it', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    const [fpA, fpB] = [pc(a).fp, pc(b).fp];
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();

    const token = a.internals.signaling!.room;
    expect(b.internals.signaling!.room).toBe(token);
    // The wrapper hands out `sha-256 AB:…`; a bundle that read the raw SDP text handed out the same
    // characters in whatever case the engine wrote. Both give this token.
    expect(relayRetryToken(`sha-256 ${fpA}`, `sha-256 ${fpB}`)).toBe(relayRetryToken(`SHA-256 ${fpA.toLowerCase()}`, `sha-256 ${fpB}`));
    expect(token).toBe(relayRetryToken(fpA, fpB));
  });
});

describe('after the retry — the next pairing of the same controller', () => {
  it('in Max privacy it is strict again: no relay asked for, relay candidates filtered, its own retry to offer', async () => {
    const [a, b] = [side(), side()];
    await pairByLink(a, b);
    await failIce(a, b);
    void a.sc.retryWithRelay();
    void b.sc.retryWithRelay();
    await settle();
    await openChannel(a, b);
    expect(a.state().status).toBe('connected');

    a.sc.dispose();
    b.sc.dispose();
    a.sc.setPrivacyMode('max'); // what the stored preference says after a reload
    b.sc.setPrivacyMode('max');
    hub.turnRequests.length = 0;
    await pairByLink(a, b);

    for (const s of [a, b]) {
      expect(s.state()).toMatchObject({ status: 'pairing', relayRetry: 'none', peerAsksRelay: false });
      expect(pc(s).config.filterRelay).toBe(true);
      expect(JSON.stringify(pc(s).config.iceServers)).not.toContain('turn:');
    }
    expect(hub.turnRequests).toEqual([]);

    await failIce(a, b);
    for (const s of [a, b]) expect(s.state()).toMatchObject({ status: 'failed', error: DIRECT, relayRetry: 'offered' });
    expect(hub.turnRequests).toEqual([]);
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
