import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sendFiles,
  openReceive,
  type ReceiveEvent,
  type SendEvent,
  type TransferWire,
} from './fileTransfer';

/**
 * What a transfer does when the channel dies under it (TESTPLAN F2 / F3). SessionController calls
 * `fail(reason)` on the live send or receive the moment a loss is reported, BEFORE it tears the
 * session down; these pin what that must and must not do on each side. The browser half — a drain
 * wait that used to hang forever on a closed channel — lives in PeerConnection and is exercised end to
 * end in tests/e2e/connection-lost.spec.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A wire that records every send; with `hangAfter`, every send past that many never resolves — the
 *  shape of a channel whose buffer stopped draining — until `closeChannel` rejects it. */
function makeWire(opts: { hangAfter?: number } = {}): {
  wire: TransferWire;
  sent: (string | ArrayBufferView)[];
  closeChannel: () => void;
} {
  const sent: (string | ArrayBufferView)[] = [];
  const hung: ((err: Error) => void)[] = [];
  const wire: TransferWire = {
    maxMessageSize: 16 * 1024,
    send(d) {
      sent.push(d);
      if (opts.hangAfter !== undefined && sent.length > opts.hangAfter) {
        return new Promise<void>((_, reject) => hung.push(reject));
      }
      return Promise.resolve();
    },
  };
  return {
    wire,
    sent,
    closeChannel: () => hung.forEach((reject) => reject(new Error('data channel closed'))),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const EOF = JSON.stringify({ t: 'eof' });
const RECEIVED = JSON.stringify({ t: 'received' });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Stand-in DOM for the Blob path's hand-off (an <a download> click). */
function stubDownloadDom(): ReturnType<typeof vi.fn> {
  const click = vi.fn();
  vi.stubGlobal('document', {
    createElement: () => ({ click, remove: () => {} }),
    body: { appendChild: () => {} },
  });
  return click;
}

describe('a send whose channel dies', () => {
  it('ends with the reason at once, even while its pump is stuck on a buffer that never drains', async () => {
    // offer + two chunks go out, the third chunk's send never returns: the F3 freeze, reproduced.
    const { wire, sent, closeChannel } = makeWire({ hangAfter: 3 });
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File([new Uint8Array(256 * 1024)], 'big.bin')], (e) =>
      events.push(e),
    );
    tx.handleControl({ t: 'accept' });
    await until(() => sent.length === 4);

    tx.fail('connection lost');
    expect(events.at(-1)).toEqual({ t: 'error', reason: 'connection lost' });

    // The stuck send is released the way PeerConnection releases it on close — the pump must stay
    // quiet: no second outcome, no "done", nothing more on the wire.
    closeChannel();
    await tick();
    await tick();
    expect(events.filter((e) => e.t === 'error' || e.t === 'done')).toHaveLength(1);
    expect(sent).toHaveLength(4);
  });

  it('a send still waiting for Accept ends too', () => {
    const { wire } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File(['hi'], 'a.txt')], (e) => events.push(e));
    tx.fail('connection lost');
    expect(events.map((e) => e.t)).toEqual(['offered', 'error']);
    // A late accept from a peer that is gone cannot start a pump.
    tx.handleControl({ t: 'accept' });
    expect(events.map((e) => e.t)).toEqual(['offered', 'error']);
  });

  it('changes nothing once the receiver confirmed — a delivered file stays delivered', async () => {
    const { wire, sent } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File(['hello'], 'a.txt')], (e) => events.push(e));
    tx.handleControl({ t: 'accept' });
    await until(() => sent.includes(EOF));
    tx.handleControl({ t: 'received' });
    tx.fail('connection lost');
    expect(events.map((e) => e.t)).toContain('done');
    expect(events.some((e) => e.t === 'error')).toBe(false);
  });

  it('a send that has pushed every byte but has no confirmation yet is NOT delivered', async () => {
    const { wire, sent } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File(['hello'], 'a.txt')], (e) => events.push(e));
    tx.handleControl({ t: 'accept' });
    await until(() => sent.includes(EOF));
    tx.fail('connection lost');
    expect(events.at(-1)).toEqual({ t: 'error', reason: 'connection lost' });
    expect(events.some((e) => e.t === 'done')).toBe(false);
  });
});

describe('"Delivered" waits for the receiver', () => {
  it('is reported only once the receiver says `received`', async () => {
    const { wire, sent } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File(['hello'], 'a.txt')], (e) => events.push(e));
    tx.handleControl({ t: 'accept' });
    await until(() => sent.includes(EOF));
    await tick();
    expect(events.some((e) => e.t === 'done')).toBe(false);
    tx.handleControl({ t: 'received' });
    expect(events.at(-1)).toEqual({ t: 'done' });
  });

  it('counts a `received` that overtakes the eof send stuck on a full buffer', async () => {
    // offer + the one data chunk go; the eof send never returns (the buffer is draining).
    const { wire, sent } = makeWire({ hangAfter: 2 });
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File(['hello'], 'a.txt')], (e) => events.push(e));
    tx.handleControl({ t: 'accept' });
    await until(() => sent.includes(EOF));
    tx.handleControl({ t: 'received' });
    expect(events.at(-1)).toEqual({ t: 'done' });
  });

  it('ignores a `received` before the last byte — nothing is confirmed that was not sent', async () => {
    const { wire } = makeWire({ hangAfter: 2 }); // stuck mid-file
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File([new Uint8Array(64 * 1024)], 'a.bin')], (e) =>
      events.push(e),
    );
    tx.handleControl({ t: 'accept' });
    await tick();
    tx.handleControl({ t: 'received' });
    expect(events.some((e) => e.t === 'done')).toBe(false);
  });

  it('the receiver confirms after saving, and never for a file that stopped short', async () => {
    stubDownloadDom();
    const whole = makeWire();
    const rx = await openReceive(
      whole.wire,
      { name: 'f.bin', size: 100, isZip: false },
      false,
      1 << 20,
      () => {},
    );
    rx.handleChunk(new ArrayBuffer(100));
    rx.handleControl({ t: 'eof' });
    await until(() => whole.sent.includes(RECEIVED));

    const short = makeWire();
    const events: ReceiveEvent[] = [];
    const rx2 = await openReceive(
      short.wire,
      { name: 'f.bin', size: 100, isZip: false },
      false,
      1 << 20,
      (e) => events.push(e),
    );
    rx2.handleChunk(new ArrayBuffer(60));
    rx2.handleControl({ t: 'eof' }); // the sender says "that's all" at 60 of 100
    await until(() => events.some((e) => e.t === 'error'));
    expect(short.sent).not.toContain(RECEIVED);
    expect(short.sent).toContain(JSON.stringify({ t: 'cancel' })); // so the sender stops waiting
  });
});

describe('a receive whose channel dies', () => {
  const offer = { name: 'f.bin', size: 100, isZip: false };

  it('ends with the reason, keeps nothing and hands nothing to the browser', async () => {
    const click = stubDownloadDom();
    const { wire, sent } = makeWire();
    const events: ReceiveEvent[] = [];
    const rx = await openReceive(wire, offer, false, 1 << 20, (e) => events.push(e));
    await rx.start();
    expect(sent).toEqual([JSON.stringify({ t: 'accept' })]);

    rx.handleChunk(new ArrayBuffer(40));
    await until(() => events.some((e) => e.t === 'progress'));
    rx.fail('connection lost');
    expect(events.at(-1)).toEqual({ t: 'error', reason: 'connection lost' });

    // Whatever was still in flight when the loss was reported is dropped, not saved.
    rx.handleChunk(new ArrayBuffer(60));
    rx.handleControl({ t: 'eof' });
    await tick();
    await tick();
    expect(events.filter((e) => e.t === 'done')).toHaveLength(0);
    expect(events.filter((e) => e.t === 'progress')).toHaveLength(1);
    expect(click).not.toHaveBeenCalled();
    // And it tells nobody: there is no one left to tell.
    expect(sent).toHaveLength(1);
  });

  it('is a no-op once eof has arrived — every byte is here, so the save finishes', async () => {
    const click = stubDownloadDom();
    const { wire } = makeWire();
    const events: ReceiveEvent[] = [];
    const rx = await openReceive(wire, offer, false, 1 << 20, (e) => events.push(e));
    await rx.start();
    rx.handleChunk(new ArrayBuffer(100));
    rx.handleControl({ t: 'eof' });
    rx.fail('connection lost'); // the channel died in the same breath as the last byte
    await until(() => events.some((e) => e.t === 'done'));
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('discard() drops the session silently — nothing emitted, nothing saved, nothing sent', async () => {
    const click = stubDownloadDom();
    const { wire, sent } = makeWire();
    const events: ReceiveEvent[] = [];
    const rx = await openReceive(wire, offer, false, 1 << 20, (e) => events.push(e));
    rx.discard();
    rx.handleChunk(new ArrayBuffer(100));
    rx.handleControl({ t: 'eof' });
    await tick();
    await tick();
    expect(events).toEqual([]);
    expect(click).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
