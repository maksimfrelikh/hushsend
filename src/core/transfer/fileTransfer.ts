/**
 * File transfer over the DataChannel (step 2).
 *
 * The transfer protocol lives ON the DataChannel — never on signaling. We multiplex
 * two kinds of messages on the single channel and tell them apart by JS type:
 *   - control  → JSON **strings**     (`typeof data === 'string'`)
 *   - file data → binary **ArrayBuffer** chunks (everything else)
 *
 * Control messages (the `t` discriminator):
 *   { t:'offer-file', name, size, isZip }  sender → receiver, BEFORE any bytes
 *   { t:'accept' } | { t:'reject', reason } receiver → sender
 *   { t:'eof' }                             sender → receiver, AFTER the last chunk
 *   { t:'cancel' }                          either side — basic cancel
 *
 * Send: one file → `file.stream()`; many files → a single store (no compression) zip
 * stream built on the fly with client-zip (streams; never held whole in RAM). Bytes are
 * re-chunked to CHUNK_SIZE and pushed through the backpressure-aware wire.send().
 *
 * Receive: stream straight to disk via File System Access (`showSaveFilePicker`) where
 * available (Chromium → unbounded size); otherwise buffer in RAM and hand back a Blob
 * download (Safari/iOS, Firefox → capped). The capability + size guard runs BEFORE accept,
 * so an oversize file on the Blob path is rejected without a single byte crossing.
 *
 * INVARIANT: nothing here runs unless the connection status === 'connected'. This module
 * is pure (no React, no store); SessionController drives it and projects events to the UI.
 */
import { z } from 'zod';
import { makeZip, predictLength } from 'client-zip';

// ── tuning constants ────────────────────────────────────────────────────────
/** Chunk-size floor: never send messages smaller than this. */
export const CHUNK_MIN = 16 * 1024; // 16 KiB
/** Chunk-size ceiling: never send messages larger than this. */
export const CHUNK_MAX = 256 * 1024; // 256 KiB
/** Blob-fallback caps (RAM-bound paths only). FSA streaming-to-disk is unbounded. */
export const MAX_BYTES_DESKTOP_BLOB = 1024 * 1024 * 1024; // ~1 GB
export const MAX_BYTES_MOBILE_BLOB = 512 * 1024 * 1024; // ~0.5 GB

/** Final chunk size: the SCTP-negotiated max, clamped to [CHUNK_MIN, CHUNK_MAX]. */
export function chunkSize(maxMessageSize: number): number {
  const m = maxMessageSize > 0 ? maxMessageSize : CHUNK_MAX;
  return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, m));
}

// ── control protocol ─────────────────────────────────────────────────────────
const controlSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('offer-file'), name: z.string(), size: z.number().nonnegative(), isZip: z.boolean() }),
  z.object({ t: z.literal('accept') }),
  z.object({ t: z.literal('reject'), reason: z.string() }),
  z.object({ t: z.literal('eof') }),
  z.object({ t: z.literal('cancel') }),
]);
export type ControlMessage = z.infer<typeof controlSchema>;

/** Validate an already-parsed inbound object as a transfer control message (else null). */
export function parseControl(value: unknown): ControlMessage | null {
  const r = controlSchema.safeParse(value);
  return r.success ? r.data : null;
}

// ── capability / limits ───────────────────────────────────────────────────────
/** Dev/test hook: force the in-memory Blob path even on Chromium (`?forceBlob=1` or a global). */
function forceBlobFallback(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __HUSHSEND_FORCE_BLOB__?: unknown }).__HUSHSEND_FORCE_BLOB__ === true) return true;
    return new URLSearchParams(window.location.search).get('forceBlob') === '1';
  } catch {
    return false;
  }
}

/** Dev/test hook: override the Blob-path byte cap so the limit branch is testable cheaply. */
function blobMaxOverride(): number | null {
  try {
    const v = (window as unknown as { __HUSHSEND_MAX_BYTES__?: unknown }).__HUSHSEND_MAX_BYTES__;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** True when we can stream the received file straight to disk (Chromium File System Access). */
export function canStreamToDisk(): boolean {
  return !forceBlobFallback() && typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/** Largest file we'll accept given the receive path: Infinity when streaming, else a RAM cap. */
export function receiveMaxBytes(canStream: boolean): number {
  if (canStream) return Infinity;
  return blobMaxOverride() ?? (isMobileUA() ? MAX_BYTES_MOBILE_BLOB : MAX_BYTES_DESKTOP_BLOB);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ── the wire (a thin view over PeerConnection — backpressure lives there) ─────
export interface TransferWire {
  /** Backpressure-aware send: resolves once the channel buffer has drained enough. */
  send(data: string | ArrayBufferView): Promise<void>;
  /** SCTP-negotiated max message size in bytes (0 if unknown). */
  readonly maxMessageSize: number;
}

// ── re-chunker: coalesce/split arbitrary source chunks into fixed-size pieces ─
class Rechunker {
  private queue: Uint8Array[] = [];
  private queued = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length) {
      this.queue.push(chunk);
      this.queued += chunk.length;
    }
  }

  /** Pull up to `size` bytes; null unless ≥ `size` queued (or `flush` and any remain). */
  pull(size: number, flush: boolean): Uint8Array | null {
    if (this.queued === 0 || (this.queued < size && !flush)) return null;
    const take = Math.min(size, this.queued);
    const out = new Uint8Array(take);
    let off = 0;
    while (off < take) {
      const head = this.queue[0];
      const need = take - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.queue.shift();
        this.queued -= head.length;
      } else {
        out.set(head.subarray(0, need), off);
        off += need;
        this.queue[0] = head.subarray(need);
        this.queued -= need;
      }
    }
    return out;
  }
}

// ── source preparation ─────────────────────────────────────────────────────────
interface Source {
  name: string;
  size: number;
  isZip: boolean;
  open(): ReadableStream<Uint8Array>;
}

function prepareSource(files: File[]): Source {
  if (files.length === 1) {
    const f = files[0];
    return { name: f.name, size: f.size, isZip: false, open: () => f.stream() as ReadableStream<Uint8Array> };
  }
  // Many files → one store-mode zip, streamed. predictLength is exact for store mode,
  // so the receiver gets a real total for the progress bar before any byte is sent.
  const size = Number(predictLength(files));
  return { name: 'hushsend-files.zip', size, isZip: true, open: () => makeZip(files) };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── sender ───────────────────────────────────────────────────────────────────
export type SendEvent =
  | { t: 'offered'; fileName: string; totalBytes: number }
  | { t: 'accepted' }
  | { t: 'progress'; transferredBytes: number }
  | { t: 'done' }
  | { t: 'rejected'; reason: string }
  | { t: 'cancelled' }
  | { t: 'error'; reason: string };

export interface ActiveSend {
  /** Feed an inbound control message (accept / reject / cancel) to the sender. */
  handleControl(msg: ControlMessage): void;
  /** Local cancel — notifies the peer and stops sending. */
  cancel(): void;
}

/**
 * Begin a send: packs a zip when given >1 file, emits `offered`, and sends the
 * `offer-file` control. Returns immediately; the actual byte pump starts on `accept`.
 */
export function sendFiles(wire: TransferWire, files: File[], emit: (e: SendEvent) => void): ActiveSend {
  const source = prepareSource(files);
  let phase: 'offering' | 'sending' | 'ended' = 'offering';
  let aborted = false;
  let ended = false;

  const finalize = (e: SendEvent): void => {
    if (ended) return;
    ended = true;
    phase = 'ended';
    emit(e);
  };

  emit({ t: 'offered', fileName: source.name, totalBytes: source.size });
  void wire
    .send(JSON.stringify({ t: 'offer-file', name: source.name, size: source.size, isZip: source.isZip }))
    .catch((err) => finalize({ t: 'error', reason: errMsg(err) }));

  async function pump(): Promise<void> {
    const CHUNK = chunkSize(wire.maxMessageSize);
    const reader = source.open().getReader();
    const rc = new Rechunker();
    let sent = 0;
    try {
      for (;;) {
        if (aborted) return;
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) rc.push(value as Uint8Array);
        let piece: Uint8Array | null;
        while (!aborted && (piece = rc.pull(CHUNK, false)) !== null) {
          await wire.send(piece);
          sent += piece.length;
          emit({ t: 'progress', transferredBytes: sent });
        }
      }
      let piece: Uint8Array | null;
      while (!aborted && (piece = rc.pull(CHUNK, true)) !== null) {
        await wire.send(piece);
        sent += piece.length;
        emit({ t: 'progress', transferredBytes: sent });
      }
      if (aborted) return;
      await wire.send(JSON.stringify({ t: 'eof' }));
      finalize({ t: 'done' });
    } catch (err) {
      if (!aborted) finalize({ t: 'error', reason: errMsg(err) });
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }
  }

  return {
    handleControl(msg: ControlMessage): void {
      if (msg.t === 'cancel') {
        aborted = true;
        finalize({ t: 'cancelled' });
        return;
      }
      if (phase !== 'offering') return;
      if (msg.t === 'accept') {
        phase = 'sending';
        emit({ t: 'accepted' });
        void pump();
      } else if (msg.t === 'reject') {
        aborted = true;
        finalize({ t: 'rejected', reason: msg.reason });
      }
    },
    cancel(): void {
      if (ended) return;
      aborted = true;
      void wire.send(JSON.stringify({ t: 'cancel' })).catch(() => {});
      finalize({ t: 'cancelled' });
    },
  };
}

// ── receiver ───────────────────────────────────────────────────────────────────
export type ReceiveEvent =
  | { t: 'progress'; transferredBytes: number }
  | { t: 'done' }
  | { t: 'cancelled' }
  | { t: 'error'; reason: string };

export interface ActiveReceive {
  /** Send `accept` and begin consuming chunks. Call AFTER SessionController stores the ref. */
  start(): Promise<void>;
  /** Feed an inbound binary chunk to the sink. */
  handleChunk(data: ArrayBuffer): void;
  /** Feed an inbound control message (eof / cancel). */
  handleControl(msg: ControlMessage): void;
  /** Local cancel — notifies the peer and discards the partial. */
  cancel(): void;
}

interface ReceiveSink {
  write(chunk: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late — immediate revoke can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function openSink(name: string, canStream: boolean, maxBytes: number): Promise<ReceiveSink> {
  if (canStream) {
    // Must run inside the accept-click user gesture (showSaveFilePicker requires it).
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: async () => {
        try {
          await writable.abort();
        } catch {
          /* ignore */
        }
      },
    };
  }
  // RAM-bound fallback: accumulate chunks, hand back a Blob download on eof.
  const parts: ArrayBuffer[] = [];
  let total = 0;
  return {
    write: async (chunk) => {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`incoming data exceeds the ${formatBytes(maxBytes)} in-memory limit`);
      parts.push(chunk);
    },
    close: async () => triggerDownload(new Blob(parts), name),
    abort: async () => {
      parts.length = 0;
    },
  };
}

/**
 * Open the receive sink (the FSA save picker runs here, in the caller's user gesture)
 * and return a live receive session. The caller stores the reference, then calls
 * `start()` to send `accept` — so a chunk can never arrive before we can route it.
 */
export async function openReceive(
  wire: TransferWire,
  offer: { name: string; size: number; isZip: boolean },
  canStream: boolean,
  maxBytes: number,
  emit: (e: ReceiveEvent) => void,
): Promise<ActiveReceive> {
  const sink = await openSink(offer.name, canStream, maxBytes);
  let received = 0;
  let ended = false;
  // Serialize writes: chunks arrive ordered (the channel is ordered) but writes are async;
  // chaining keeps them in order and bounds concurrency to one outstanding write.
  let tail: Promise<void> = Promise.resolve();

  const finalize = (e: ReceiveEvent): void => {
    if (ended) return;
    ended = true;
    emit(e);
  };
  const sendCancel = (): void => void wire.send(JSON.stringify({ t: 'cancel' })).catch(() => {});

  async function finish(): Promise<void> {
    if (ended) return;
    try {
      await tail; // drain queued writes (eof is the last message, so this is all of them)
      if (ended) return;
      await sink.close();
      finalize({ t: 'done' });
    } catch (err) {
      await sink.abort().catch(() => {});
      finalize({ t: 'error', reason: errMsg(err) });
    }
  }

  async function abort(): Promise<void> {
    if (ended) return;
    finalize({ t: 'cancelled' });
    await sink.abort().catch(() => {});
  }

  return {
    async start(): Promise<void> {
      await wire.send(JSON.stringify({ t: 'accept' }));
    },
    handleChunk(data: ArrayBuffer): void {
      if (ended) return;
      tail = tail.then(async () => {
        if (ended) return;
        try {
          await sink.write(data);
          received += data.byteLength;
          emit({ t: 'progress', transferredBytes: received });
        } catch (err) {
          await sink.abort().catch(() => {});
          sendCancel();
          finalize({ t: 'error', reason: errMsg(err) });
        }
      });
    },
    handleControl(msg: ControlMessage): void {
      if (msg.t === 'eof') void finish();
      else if (msg.t === 'cancel') void abort();
    },
    cancel(): void {
      if (ended) return;
      sendCancel();
      void abort();
    },
  };
}
