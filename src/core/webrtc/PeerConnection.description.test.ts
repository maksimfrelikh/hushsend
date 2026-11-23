import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_TAMPERED_REASON, PeerConnection, type SignalPayload } from './PeerConnection';

/**
 * The peer's description is the one thing the untrusted server relays that the authentication is
 * bound to. These tests drive the real PeerConnection wrapper against a stand-in RTCPeerConnection
 * that records what it was handed and can be told what to serialize back and which certificate DTLS
 * "accepted" — the three places where an engine and this code could disagree about WHICH certificate
 * a description names (core/webrtc/fingerprint.ts has the measurement).
 */

const A = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const OWN = '0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F:20:21:22:23:24:25:26:27:28:29';

function sdp(session: string[], media: string[]): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...session,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...media,
    'a=setup:actpass',
    '',
  ].join('\r\n');
}
const fp = (value: string): string => `a=fingerprint:sha-256 ${value}`;
const offer = (s: string): SignalPayload => ({ kind: 'offer', description: { type: 'offer', sdp: s } });
const answer = (s: string): SignalPayload => ({ kind: 'answer', description: { type: 'answer', sdp: s } });

class FakeChannel {
  readyState = 'connecting';
  binaryType = '';
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  close(): void {}
}

class FakeRtc {
  static last: FakeRtc;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  /** every description handed to the engine */
  readonly applied: { type: string; sdp: string }[] = [];
  /** what the engine serializes back for a description it was given */
  keep: (sdp: string) => string = (s) => s;
  /** the certificate DTLS accepted, if the engine tells */
  certificate: ArrayBuffer | null = null;
  /** certificates the engine lists before it (a chain) */
  before: ArrayBuffer[] = [];
  connectionState = 'new';
  iceConnectionState = 'new';
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  readonly sctp = {
    maxMessageSize: 65536,
    transport: {
      getRemoteCertificates: (): ArrayBuffer[] => (this.certificate ? [...this.before, this.certificate] : []),
    },
  };
  constructor() {
    FakeRtc.last = this;
  }
  createDataChannel(): FakeChannel {
    return new FakeChannel();
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: sdp([], [fp(OWN)]) };
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: sdp([], [fp(OWN)]) };
  }
  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.applied.push(d);
    this.remoteDescription = { type: d.type, sdp: this.keep(d.sdp) };
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {}
}

function peer(initiator: boolean) {
  const signals: SignalPayload[] = [];
  const tampered: string[] = [];
  const onOpen = vi.fn();
  const pc = new PeerConnection(
    { onSignal: (d) => signals.push(d), onTampered: (r) => tampered.push(r), onOpen },
    { iceServers: [] },
  );
  pc.start(initiator);
  return { pc, rtc: FakeRtc.last, signals, tampered, onOpen };
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => vi.stubGlobal('RTCPeerConnection', FakeRtc));
afterEach(() => vi.unstubAllGlobals());

describe('the peer description — taken once, and only when it names one certificate', () => {
  it('an honest offer is applied, answered, and its fingerprint is what remoteFingerprint() returns', async () => {
    const { pc, rtc, signals, tampered } = peer(false);
    await pc.handleSignal(offer(sdp([], [fp(A)])));

    expect(rtc.applied).toHaveLength(1);
    expect(signals.map((s) => s.kind)).toEqual(['answer']);
    expect(pc.remoteFingerprint()).toBe(`sha-256 ${A}`);
    expect(pc.localFingerprint()).toBe(`sha-256 ${OWN}`);
    expect(tampered).toEqual([]);
  });

  for (const [name, tamperedSdp] of [
    ['the honest fingerprint first and another second', sdp([], [fp(A), fp(B)])],
    ['another first and the honest one second', sdp([], [fp(B), fp(A)])],
    ['the honest one at session level and another at media level', sdp([fp(A)], [fp(B)])],
    ['another at session level and the honest one at media level', sdp([fp(B)], [fp(A)])],
    ['no fingerprint at all', sdp([], [])],
  ] as const) {
    it(`an offer with ${name} never reaches the engine: refused, unanswered, reported once`, async () => {
      const { pc, rtc, signals, tampered } = peer(false);
      await pc.handleSignal(offer(tamperedSdp));

      expect(rtc.applied).toEqual([]);
      expect(signals).toEqual([]);
      expect(pc.remoteFingerprint()).toBeNull();
      expect(tampered).toEqual([DESCRIPTION_TAMPERED_REASON]);
    });
  }

  it('the same holds for the answer the offering side takes', async () => {
    const { pc, rtc, tampered } = peer(true);
    await tick();
    await pc.handleSignal(answer(sdp([fp(A)], [fp(B)])));

    expect(rtc.applied).toEqual([]);
    expect(pc.remoteFingerprint()).toBeNull();
    expect(tampered).toEqual([DESCRIPTION_TAMPERED_REASON]);
  });

  it('a second offer cannot replace the first — not later, and not while the first is still being applied', async () => {
    const { pc, rtc, signals } = peer(false);
    const first = pc.handleSignal(offer(sdp([], [fp(A)])));
    const racing = pc.handleSignal(offer(sdp([], [fp(B)])));
    await Promise.all([first, racing]);
    await pc.handleSignal(offer(sdp([], [fp(B)])));

    expect(rtc.applied).toHaveLength(1);
    expect(rtc.applied[0].sdp).toContain(A);
    expect(pc.remoteFingerprint()).toBe(`sha-256 ${A}`);
    expect(signals.map((s) => s.kind)).toEqual(['answer']);
  });

  it('a late second answer cannot replace the one that was taken', async () => {
    const { pc, rtc } = peer(true);
    await tick();
    await pc.handleSignal(answer(sdp([], [fp(A)])));
    await pc.handleSignal(answer(sdp([], [fp(B)])));

    expect(rtc.applied).toHaveLength(1);
    expect(pc.remoteFingerprint()).toBe(`sha-256 ${A}`);
  });

  it('each side takes only the kind it is waiting for: no answer for the answerer, no offer for the offerer', async () => {
    const answerer = peer(false);
    await answerer.pc.handleSignal(answer(sdp([], [fp(B)])));
    expect(answerer.rtc.applied).toEqual([]);
    await answerer.pc.handleSignal(offer(sdp([], [fp(A)])));
    expect(answerer.pc.remoteFingerprint()).toBe(`sha-256 ${A}`); // …and that did not use up its one description

    const offerer = peer(true);
    await tick();
    await offerer.pc.handleSignal(offer(sdp([], [fp(B)])));
    expect(offerer.rtc.applied).toEqual([]);
    expect(offerer.signals.map((s) => s.kind)).toEqual(['offer']); // its own; it answered nothing
    await offerer.pc.handleSignal(answer(sdp([], [fp(A)])));
    expect(offerer.pc.remoteFingerprint()).toBe(`sha-256 ${A}`);
  });

  it('what the engine serializes back is not what is read: the value is the one that arrived', async () => {
    const { pc, rtc, tampered } = peer(false);
    rtc.keep = (s) => s.replace(A, A.toLowerCase()); // another spelling of the same certificate
    await pc.handleSignal(offer(sdp([], [fp(A)])));

    expect(pc.remoteFingerprint()).toBe(`sha-256 ${A}`);
    expect(tampered).toEqual([]);
  });

  it('…and an engine that kept ANOTHER certificate than the description named is a refusal', async () => {
    const { pc, rtc, signals, tampered } = peer(false);
    rtc.keep = (s) => s.replace(A, B);
    await pc.handleSignal(offer(sdp([], [fp(A)])));

    expect(tampered).toEqual([DESCRIPTION_TAMPERED_REASON]);
    expect(signals).toEqual([]); // no answer went out
  });

  it('after close() there is no fingerprint to read', async () => {
    const { pc } = peer(false);
    await pc.handleSignal(offer(sdp([], [fp(A)])));
    pc.close();
    expect(pc.remoteFingerprint()).toBeNull();
    expect(pc.localFingerprint()).toBeNull();
  });
});

describe('at channel-open — the certificate DTLS accepted is the one that was named', () => {
  const certificate = new TextEncoder().encode('the certificate the peer presented').buffer;
  async function named(): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', certificate));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  async function openWith(offered: string, presented: ArrayBuffer | null, before: ArrayBuffer[] = []) {
    const p = peer(false);
    await p.pc.handleSignal(offer(sdp([], [fp(offered)])));
    p.rtc.certificate = presented;
    p.rtc.before = before;
    const channel = new FakeChannel();
    p.rtc.ondatachannel!({ channel });
    channel.readyState = 'open';
    channel.onopen!();
    await vi.waitFor(() => expect(p.onOpen.mock.calls.length + p.tampered.length).toBeGreaterThan(0), { timeout: 5000 });
    return p;
  }

  it('the same certificate: the channel is handed to the owner', async () => {
    const { onOpen, tampered } = await openWith(await named(), certificate);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tampered).toEqual([]);
  });

  it('the named certificate anywhere in the chain the engine reports is the same answer', async () => {
    const other = new TextEncoder().encode('an issuer, listed first').buffer;
    const { onOpen, tampered } = await openWith(await named(), certificate, [other]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tampered).toEqual([]);
  });

  it('another certificate: the channel is never handed over, and the owner is told', async () => {
    const { onOpen, tampered } = await openWith(A, certificate);
    expect(onOpen).not.toHaveBeenCalled();
    expect(tampered).toEqual([DESCRIPTION_TAMPERED_REASON]);
  });

  it('an engine that reports no certificate gives no second opinion: the one-fingerprint rule stands alone', async () => {
    const { onOpen, tampered } = await openWith(A, null);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tampered).toEqual([]);
  });
});
