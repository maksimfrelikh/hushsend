import { describe, it, expect } from 'vitest';
import {
  CREDIT_STEP,
  RECEIVE_WINDOW,
  openReceive,
  sendFiles,
  type SendEvent,
  type TransferWire,
} from './fileTransfer';

/**
 * Flow control (2026-09-28). A DataChannel cannot push back on its sender: every chunk the network
 * delivers lands in the receiving page, so a sink that slows down — a download paused in the browser,
 * a slow disk — used to pile chunks up in the receiver's RAM. Now the receiver grants a window in its
 * `accept` and tops it up with `credit` as its sink takes the bytes, and the sender never runs ahead
 * of it. A peer on an older build sends neither, and the transfer then runs as before.
 */

const KiB = 1024;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await tick();
};

function makeWire(): { wire: TransferWire; sent: (string | ArrayBufferView)[] } {
  const sent: (string | ArrayBufferView)[] = [];
  return {
    sent,
    wire: { maxMessageSize: 16 * KiB, send: async (d) => void sent.push(d) },
  };
}
const chunks = (sent: (string | ArrayBufferView)[]): number =>
  sent.filter((d) => typeof d !== 'string').length;

describe('the sender stays inside the window the receiver granted', () => {
  it('sends exactly what the window holds, and one chunk more per chunk of credit', async () => {
    const { wire, sent } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File([new Uint8Array(160 * KiB)], 'f.bin')], (e) =>
      events.push(e),
    );
    tx.handleControl({ t: 'accept', window: 32 * KiB });
    await settle();
    expect(chunks(sent)).toBe(2); // 2 × 16 KiB — then it waits

    tx.handleControl({ t: 'credit', bytes: 16 * KiB });
    await settle();
    expect(chunks(sent)).toBe(3);

    tx.handleControl({ t: 'credit', bytes: 1024 * KiB });
    await settle();
    expect(chunks(sent)).toBe(10);
    expect(sent.at(-1)).toBe(JSON.stringify({ t: 'eof' }));
  });

  it('a receiver on an older build grants no window — the sender runs unthrottled, as it always did', async () => {
    const { wire, sent } = makeWire();
    const tx = sendFiles(wire, [new File([new Uint8Array(160 * KiB)], 'f.bin')], () => {});
    tx.handleControl({ t: 'accept' });
    await settle();
    expect(chunks(sent)).toBe(10);
  });

  it('the padding filler counts against the window too', async () => {
    const { wire, sent } = makeWire();
    // 1 byte of file, padded up to its bucket: every byte on the wire needs credit.
    const tx = sendFiles(wire, [new File([new Uint8Array(1)], 'f.bin')], () => {}, { pad: true });
    tx.handleControl({ t: 'accept', window: 16 * KiB });
    await settle();
    const bytes = sent
      .filter((d) => typeof d !== 'string')
      .reduce((n, d) => n + (d as ArrayBufferView).byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(16 * KiB);
  });

  it('a cancel while waiting for credit ends the send and sends nothing more', async () => {
    const { wire, sent } = makeWire();
    const events: SendEvent[] = [];
    const tx = sendFiles(wire, [new File([new Uint8Array(160 * KiB)], 'f.bin')], (e) =>
      events.push(e),
    );
    tx.handleControl({ t: 'accept', window: 16 * KiB });
    await settle();
    expect(chunks(sent)).toBe(1);
    tx.handleControl({ t: 'cancel' });
    await settle();
    tx.handleControl({ t: 'credit', bytes: 1024 * KiB });
    await settle();
    expect(chunks(sent)).toBe(1);
    expect(events.at(-1)).toEqual({ t: 'cancelled' });
  });
});

describe('the receiver grants credit as its sink takes the bytes', () => {
  const RAM = { path: 'blob' as const, maxBytes: 64 << 20 };

  it('announces the window in accept and returns credit in CREDIT_STEP steps, padding included', async () => {
    const { wire, sent } = makeWire();
    const size = 2 * CREDIT_STEP;
    const rx = await openReceive(wire, { name: 'f.bin', size, isZip: false }, RAM, () => {});
    await rx.start();
    expect(sent[0]).toBe(JSON.stringify({ t: 'accept', window: RECEIVE_WINDOW }));

    const piece = 256 * KiB;
    for (let i = 0; i < CREDIT_STEP / piece - 1; i++) rx.handleChunk(new ArrayBuffer(piece));
    await settle();
    expect(sent.filter((d) => typeof d === 'string' && d.includes('credit'))).toEqual([]); // not a step yet

    rx.handleChunk(new ArrayBuffer(piece));
    await settle();
    expect(sent.at(-1)).toBe(JSON.stringify({ t: 'credit', bytes: CREDIT_STEP }));

    // The rest of the file, then filler past the declared size: dropped, but credited all the same,
    // or a padded transfer would stall on its own filler.
    for (let i = 0; i < CREDIT_STEP / piece; i++) rx.handleChunk(new ArrayBuffer(piece));
    for (let i = 0; i < CREDIT_STEP / piece; i++) rx.handleChunk(new ArrayBuffer(piece));
    await settle();
    const credits = sent.filter((d) => typeof d === 'string' && d.includes('credit'));
    expect(credits).toEqual(Array(3).fill(JSON.stringify({ t: 'credit', bytes: CREDIT_STEP })));
  });
});
