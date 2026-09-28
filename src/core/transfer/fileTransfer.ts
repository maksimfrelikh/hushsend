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
 *   { t:'accept', window? } | { t:'reject', reason } receiver → sender
 *   { t:'credit', bytes }                   receiver → sender, as its sink takes the bytes
 *   { t:'eof' }                             sender → receiver, AFTER the last chunk
 *   { t:'received' }                        receiver → sender, once the whole file is saved
 *   { t:'cancel' }                          either side — basic cancel
 *
 * "Delivered" on the sender waits for `received` (2026-09-27). It used to fire the moment `eof` was
 * queued — up to a MiB could still be in the send buffer, so a receiver whose tab died in that window
 * left the sender saying "Delivered" about a file that never arrived. A sender whose peer never
 * confirms (a tab still running an older build) ends as the connection-lost path says: not delivered.
 *
 * Send: one file → `file.stream()`; many files → a single store (no compression) zip
 * stream built on the fly with client-zip (streams; never held whole in RAM). Bytes are
 * re-chunked to CHUNK_SIZE and pushed through the backpressure-aware wire.send().
 *
 * Receive — to DISK wherever possible, in this order (owner's rules, 2026-09-27 and -28: disk before
 * RAM, no dialog where disk needs none, and straight into Downloads with no copy where that is possible
 * without RAM; see planReceive):
 *   1. Straight into Downloads (./streamDownload.ts): a service worker streams the file into the
 *      browser's download manager as it arrives — no copy, no RAM, no dialog. Desktop Chromium and
 *      desktop Firefox (measured); not WebKit, whose download never receives a byte.
 *   2. OPFS (./opfs.ts): the site's private folder, written with no dialog, then handed to the user as
 *      a download read from disk, the copy removed after OPFS_HOLD_MS (or after OPFS_EVICT_AFTER_MS
 *      when a new receive needs its room). Its space is RESERVED before
 *      accept: incognito Chrome reports a quota its storage cannot hold. Safari, mobile browsers, and
 *      the fallback everywhere else.
 *   3. File System Access (`showSaveFilePicker`): disk, but through the save dialog — used only when
 *      neither of the above can take the file, since on Android a dialog left open killed the connection.
 *   4. RAM (a Blob) — capped at MAX_BYTES_BLOB, the last resort (a private window with no storage).
 * The plan and its size guard run BEFORE accept, so a file no path can take is refused without a
 * single byte crossing. A finished file on paths 2 and 4 is returned to the caller to hand off
 * (ReceiveEvent `done`): whether to start the download now or wait for a tap is the controller's call.
 *
 * Flow control (2026-09-28): the receiver grants the sender RECEIVE_WINDOW bytes in its `accept` and
 * tops the window up with `credit` as its sink takes the bytes, so a sink that slows down — a download
 * paused in the browser, a slow disk — pauses the sender instead of piling chunks up in the receiver's
 * RAM. A peer on an older build ignores both (zod strips the unknown field, an unknown control message
 * is dropped) and the transfer runs as it did before.
 *
 * INVARIANT: nothing here runs unless the connection is AUTHENTICATED. Both directions are gated in
 * the core on `SessionController.established` — sendFiles always was, and handleIncomingOffer /
 * acceptIncoming were added in the 2026-09-12 audit pass, where this line was an assumption rather
 * than a check and an unauthenticated peer's offer could reach the UI. This module
 * is pure (no React, no store); SessionController drives it and projects events to the UI.
 */
import { z } from 'zod';
import { padBytesFor } from './padding';
import { createIncoming, evictHeld, opfsCanHold, opfsHeldBytes, opfsRoom, opfsUsable, OPFS_HOLD_MS } from './opfs';
import { openStreamSink, prepareDownloadWorker, streamDownloadSupported } from './streamDownload';
import { makeZip, predictLength } from 'client-zip';

// ── tuning constants ────────────────────────────────────────────────────────
/** Chunk-size floor: never send messages smaller than this. */
export const CHUNK_MIN = 16 * 1024; // 16 KiB
/** Chunk-size ceiling: never send messages larger than this. */
export const CHUNK_MAX = 256 * 1024; // 256 KiB
/**
 * The RAM-only receive path's cap: a Blob held whole in the tab until it is handed off. Reached only
 * when neither disk path can take the file (see planReceive) — a private window without site storage,
 * a browser with neither OPFS nor a save dialog. ONE cap for every device, by the owner's rule
 * (2026-09-27): "a receive that can only go through RAM is capped at 200 MB" — a gigabyte of RAM was
 * judged too much, on a tablet as much as anywhere, and the disk paths now carry the big files.
 *
 * For scale, MEASURED 2026-09-12 (`tests/e2e/limits.spec.ts`, our cap lifted so the ENGINE is what
 * fails): Chromium carried 2 GB in a Blob and died at 3 GB, WebKit carried 1.5 GB and died at 1.75 GB —
 * both at the END, with no error the page could catch. 200 MB sits far below that on purpose.
 */
export const MAX_BYTES_BLOB = 200 * 1024 * 1024;

/** Bytes the receiver lets the sender have in flight before its sink has taken them (see the header).
 *  Far above bandwidth × RTT on any link we see, so it never throttles a healthy transfer. */
export const RECEIVE_WINDOW = 16 * 1024 * 1024;
/** The receiver returns credit in steps of at least this many bytes. */
export const CREDIT_STEP = 1024 * 1024;

/** Final chunk size: the SCTP-negotiated max, clamped to [CHUNK_MIN, CHUNK_MAX]. */
export function chunkSize(maxMessageSize: number): number {
  const m = maxMessageSize > 0 ? maxMessageSize : CHUNK_MAX;
  return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, m));
}

// ── control protocol ─────────────────────────────────────────────────────────
const controlSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('offer-file'), name: z.string(), size: z.number().nonnegative(), isZip: z.boolean() }),
  z.object({ t: z.literal('accept'), window: z.number().int().positive().max(2 ** 31).optional() }),
  z.object({ t: z.literal('reject'), reason: z.string() }),
  z.object({ t: z.literal('eof') }),
  z.object({ t: z.literal('received') }),
  z.object({ t: z.literal('cancel') }),
  z.object({ t: z.literal('credit'), bytes: z.number().int().positive().max(2 ** 31) }),
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
  // DEV-ONLY: shipped live until the 2026-09-12 audit, so `?forceBlob=1` in a crafted link forced a
  // receiver onto the in-memory path instead of streaming to disk — a tab-memory DoS chosen by
  // whoever sends you the link.
  if (!import.meta.env.DEV) return false;
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __HUSHSEND_FORCE_BLOB__?: unknown }).__HUSHSEND_FORCE_BLOB__ === true) return true;
    return new URLSearchParams(window.location.search).get('forceBlob') === '1';
  } catch {
    return false;
  }
}

/** Dev/test hook: skip the straight-to-Downloads path (`?noStream=1` or a global), so the e2e can
 *  exercise site storage on an engine that would otherwise stream. DEV-ONLY, like forceBlob. */
function forceNoStream(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __HUSHSEND_NO_STREAM__?: unknown }).__HUSHSEND_NO_STREAM__ === true) return true;
    return new URLSearchParams(window.location.search).get('noStream') === '1';
  } catch {
    return false;
  }
}

/** Dev/test hook: override the Blob-path byte cap so the limit branch is testable cheaply. */
function blobMaxOverride(): number | null {
  if (!import.meta.env.DEV) return null; // DEV-ONLY — never let a page-global relax the receive cap
  try {
    const v = (window as unknown as { __HUSHSEND_MAX_BYTES__?: unknown }).__HUSHSEND_MAX_BYTES__;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Where a received file is written — see the header and planReceive. */
export type ReceivePath = 'stream' | 'opfs' | 'fsa' | 'blob';
/** What an incoming offer can be received through, decided BEFORE accept: a path and the most it
 *  can hold, or a refusal whose text goes back to the sender. */
export type ReceivePlan = { path: ReceivePath; maxBytes: number } | { refused: string };

/**
 * Pick the receive path for a file of `size` bytes (the order and why: the header): straight into
 * Downloads if this browser can stream a download, else OPFS if site storage really holds it (a
 * reservation, not just the estimate), else the save dialog if the browser has one, else RAM up to
 * MAX_BYTES_BLOB — else refuse, naming the largest thing that would have fitted. Never throws.
 */
export async function planReceive(size: number): Promise<ReceivePlan> {
  const cap = blobMaxOverride() ?? MAX_BYTES_BLOB;
  let room = 0;
  let held = 0;
  if (!forceBlobFallback()) {
    if (!forceNoStream() && streamDownloadSupported() && (await prepareDownloadWorker())) {
      return { path: 'stream', maxBytes: Infinity };
    }
    if (await opfsUsable()) {
      let estimate = await opfsRoom();
      let fits = size <= estimate && (await opfsCanHold(size));
      if (!fits && (await evictHeld()) > 0) {
        // Copies of files received minutes ago made the room (owner's decision). Safari reports freed
        // space late, so the reservation alone decides now.
        estimate = await opfsRoom();
        fits = await opfsCanHold(size);
      }
      if (fits) return { path: 'opfs', maxBytes: Math.max(estimate, size) };
      // Name the estimate in a refusal only when a failed reservation did not just prove it wrong.
      if (size > estimate) {
        room = estimate;
        held = await opfsHeldBytes();
      }
    }
    const fsa = fsaPlan();
    if (fsa) return fsa;
  }
  if (size <= cap) return { path: 'blob', maxBytes: cap };
  // It would fit but for the copies of files received a moment ago: say so, not "free up disk space".
  if (held > 0 && size <= room + held) return { refused: heldReason(size) };
  return { refused: tooBigReason(size, Math.max(room, cap)) };
}

/** Site storage, if it is usable and can hold `size` — checked with a reservation (see opfsCanHold). */
async function opfsPlan(size: number): Promise<{ path: ReceivePath; maxBytes: number } | null> {
  if (!(await opfsUsable())) return null;
  const room = await opfsRoom();
  if (size > room || !(await opfsCanHold(size))) return null;
  return { path: 'opfs', maxBytes: room };
}

function fsaPlan(): { path: ReceivePath; maxBytes: number } | null {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window ? { path: 'fsa', maxBytes: Infinity } : null;
}

/** Where a receive goes if its planned path fails to open at accept after all (see openReceive):
 *  the download worker went away, or site storage refused the reservation it granted a moment ago. */
async function nextPlan(failed: ReceivePath, size: number): Promise<{ path: ReceivePath; maxBytes: number } | null> {
  if (failed === 'stream') {
    const opfs = await opfsPlan(size);
    if (opfs) return opfs;
  }
  if (failed === 'stream' || failed === 'opfs') {
    const fsa = fsaPlan();
    if (fsa) return fsa;
    const cap = blobMaxOverride() ?? MAX_BYTES_BLOB;
    return size <= cap ? { path: 'blob', maxBytes: cap } : null;
  }
  return null;
}

/** The refusal when site storage is full of files received moments ago (a copy younger than
 *  OPFS_EVICT_AFTER_MS is kept while its download may still be reading it): wait, not free disk space. */
function heldReason(size: number): string {
  return `This file is ${formatBytes(size)}, and this browser's storage is still holding the last file it received while its download finishes. Try again in a couple of minutes, or receive it in another browser.`;
}

/** The refusal the sender sees. Both sizes print to the same string just over a limit ("1.0 GB —
 *  larger than the 1.0 GB"), which reads as nonsense — then they are given in bytes. */
function tooBigReason(size: number, limit: number): string {
  let a = formatBytes(size);
  let b = formatBytes(limit);
  if (a === b) {
    a = `${size} bytes`;
    b = `${limit} bytes`;
  }
  return `This file is ${a} — larger than the ${b} this browser can take right now. Free up disk space, or receive it in another browser or in a normal (not private) window.`;
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

/** What the receiver has room for (see the header's flow control). `take` waits until the receiver
 *  has granted enough; `close` releases anyone waiting when the transfer ends. */
class Credit {
  private waiters: Array<() => void> = [];
  private closed = false;
  constructor(private avail: number) {}
  add(n: number): void {
    this.avail += n;
    this.wake();
  }
  async take(n: number): Promise<void> {
    while (!this.closed && this.avail < n) await new Promise<void>((r) => this.waiters.push(r));
    this.avail -= n;
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
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
  /** The channel died under this send: stop and end with `reason`. Tells no one — nobody is left. */
  fail(reason: string): void;
}

/**
 * Begin a send: packs a zip when given >1 file, emits `offered`, and sends the
 * `offer-file` control. Returns immediately; the actual byte pump starts on `accept`.
 */
export function sendFiles(
  wire: TransferWire,
  files: File[],
  emit: (e: SendEvent) => void,
  opts: { pad?: boolean } = {},
): ActiveSend {
  const source = prepareSource(files);
  let phase: 'offering' | 'sending' | 'confirming' | 'ended' = 'offering';
  let aborted = false;
  let ended = false;
  /** Set when the receiver's `accept` carried a window; null — a receiver without flow control. */
  let credit: Credit | null = null;

  const finalize = (e: SendEvent): void => {
    if (ended) return;
    ended = true;
    phase = 'ended';
    credit?.close();
    emit(e);
  };
  /** Every byte on the wire counts against the receiver's window — the filler too. */
  const put = async (piece: Uint8Array): Promise<void> => {
    if (credit) await credit.take(piece.length);
    if (aborted) return;
    await wire.send(piece);
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
          await put(piece);
          if (aborted) return; // cancelled while this piece waited — no progress after the end
          sent += piece.length;
          emit({ t: 'progress', transferredBytes: sent });
        }
      }
      let piece: Uint8Array | null;
      while (!aborted && (piece = rc.pull(CHUNK, true)) !== null) {
        await put(piece);
        if (aborted) return;
        sent += piece.length;
        emit({ t: 'progress', transferredBytes: sent });
      }
      if (aborted) return;
      // Volume padding (see ./padding.ts): filler AFTER the real bytes, so the number of bytes an
      // observer counts lands on a bucket edge instead of naming the file. The receiver stops writing
      // at the size we DECLARED in the offer and discards the rest, so no field is added to the wire
      // protocol and the two sides need not agree on the ladder.
      //
      // Progress is deliberately NOT emitted for the filler: the UI computes a percentage against the
      // real size, and reporting more than 100% would be worse than briefly sitting at it. Above
      // 1 MiB the tail is at most 12.5% of the transfer.
      if (opts.pad) {
        let left = padBytesFor(source.size);
        if (left > 0) {
          // Zeros, not CSPRNG bytes: this rides inside DTLS, which neither compresses nor reveals
          // plaintext structure, so random filler would cost CPU and buy nothing.
          const filler = new Uint8Array(Math.min(CHUNK, left));
          while (!aborted && left > 0) {
            const piece = left >= filler.length ? filler : filler.subarray(0, left);
            await put(piece);
            left -= piece.length;
          }
        }
      }
      if (aborted) return;
      // Every byte is in the send buffer, which is not the same as every byte arrived: "done" waits
      // for the receiver's `received` (handleControl). The phase flips BEFORE the await — with a full
      // buffer the eof send waits for a drain, and the confirmation can overtake it.
      phase = 'confirming';
      await wire.send(JSON.stringify({ t: 'eof' }));
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
      if (msg.t === 'received') {
        if (phase === 'confirming') finalize({ t: 'done' });
        return;
      }
      if (msg.t === 'credit') {
        credit?.add(msg.bytes);
        return;
      }
      if (phase !== 'offering') return;
      if (msg.t === 'accept') {
        phase = 'sending';
        if (msg.window) credit = new Credit(msg.window);
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
    fail(reason: string): void {
      if (ended) return;
      aborted = true;
      finalize({ t: 'error', reason });
    },
  };
}

// ── receiver ───────────────────────────────────────────────────────────────────
/** A storage failure in words a person can act on (the engines' own text is for developers). */
function storageError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return "not enough space in this browser's storage — free up disk space, or receive in a normal (not private) window";
  }
  return errMsg(err);
}

/** A finished file still to be given to the user (OPFS / RAM paths), and how to let it go. */
export interface Handoff {
  file: Blob;
  name: string;
  /** How long the file stays readable once the download is started — the download's link lives as
   *  long (OPFS: the whole hold; RAM: a minute, so the Blob is let go soon). */
  holdMs: number;
  /** The download has been started: let go of the file (OPFS: removed after the hold). */
  release: () => void;
  /** Nobody will save it: let go of it now (OPFS: removed at once). */
  discard: () => void;
}

export type ReceiveEvent =
  | { t: 'progress'; transferredBytes: number }
  /** `handoff` is null on the stream and save-dialog paths: the file is already where it belongs. */
  | { t: 'done'; handoff: Handoff | null }
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
  /** The channel died under this receive: discard the partial and end with `reason`. A no-op once
   *  `eof` has arrived — every byte is here by then, and the save is allowed to finish. */
  fail(reason: string): void;
  /** Drop the session silently — discard the sink, emit nothing. For a receive whose session ended
   *  while the save picker was still open, where anything emitted would land on the NEXT session. */
  discard(): void;
}

interface ReceiveSink {
  write(chunk: ArrayBuffer): Promise<void>;
  /** Finish the file; returns what is still to be handed to the user (null: already saved). */
  close(): Promise<Omit<Handoff, 'name'> | null>;
  abort(): Promise<void>;
}

/** Hand a finished file to the browser as a download — no dialog on any engine we ship to. The link
 *  stays valid for `revokeAfterMs`: a browser that asks first ("allow downloads?", iOS's "Download?")
 *  fetches it only after the human answers, which can take longer than a minute. */
export function triggerDownload(blob: Blob, name: string, revokeAfterMs = 60_000): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late — immediate revoke can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

async function openSink(name: string, size: number, plan: { path: ReceivePath; maxBytes: number }): Promise<ReceiveSink> {
  if (plan.path === 'stream') {
    // Straight into Downloads through the download worker (./streamDownload.ts): nothing to hand off.
    const stream = await openStreamSink(name, size);
    return {
      write: (chunk) => stream.write(chunk),
      close: async () => {
        await stream.close();
        return null;
      },
      abort: () => stream.abort('transfer stopped'),
    };
  }
  if (plan.path === 'opfs') {
    // Disk, no dialog: the site's private folder (./opfs.ts), then a download read from it. The space
    // is reserved here, before `accept`, so a store that cannot hold the file says so now.
    const incoming = await createIncoming(size);
    const { writable } = incoming;
    return {
      write: (chunk) => writable.write(chunk),
      close: async () => {
        await writable.close();
        return {
          file: await incoming.file(),
          holdMs: OPFS_HOLD_MS,
          release: () => incoming.releaseLater(),
          discard: () => void incoming.remove(),
        };
      },
      abort: async () => {
        try {
          await writable.abort();
        } catch {
          /* already closed */
        }
        await incoming.remove(); // a failed receive leaves nothing on disk
      },
    };
  }
  if (plan.path === 'fsa') {
    // Must run inside the accept-click user gesture (showSaveFilePicker requires it).
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: async () => {
        await writable.close();
        return null; // already where the user chose to put it
      },
      abort: async () => {
        try {
          await writable.abort();
        } catch {
          /* ignore */
        }
      },
    };
  }
  // RAM-bound last resort: accumulate chunks, hand back one Blob on eof.
  const { maxBytes } = plan;
  const parts: ArrayBuffer[] = [];
  let total = 0;
  return {
    write: async (chunk) => {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`incoming data exceeds the ${formatBytes(maxBytes)} in-memory limit`);
      parts.push(chunk);
    },
    close: async () => {
      const file = new Blob(parts);
      parts.length = 0; // the Blob holds its own copy — do not keep two
      return { file, holdMs: 60_000, release: () => {}, discard: () => {} };
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

/**
 * Open the receive sink for `plan` (on the save-dialog path the picker runs here, in the caller's
 * user gesture) and return a live receive session. The caller stores the reference, then calls
 * `start()` to send `accept` — so a chunk can never arrive before we can route it.
 */
export async function openReceive(
  wire: TransferWire,
  offer: { name: string; size: number; isZip: boolean },
  plan: { path: ReceivePath; maxBytes: number },
  emit: (e: ReceiveEvent) => void,
): Promise<ActiveReceive> {
  let sink: ReceiveSink;
  try {
    sink = await openSink(offer.name, offer.size, plan);
  } catch (err) {
    // The planned path did not open after all — the download worker went away, or site storage
    // refused the reservation it granted a moment ago (quota taken meanwhile, storage cleared, a
    // transient engine failure): take the next path, as planReceive would have.
    if (err instanceof DOMException && err.name === 'AbortError') throw err; // the save dialog: a "no"
    const next = await nextPlan(plan.path, offer.size);
    if (!next) {
      if (plan.path === 'opfs' || plan.path === 'stream') {
        throw new Error(`this browser could not store the file and it is too big to hold in memory (${storageError(err)})`);
      }
      throw err;
    }
    sink = await openSink(offer.name, offer.size, next);
  }
  let received = 0;
  let ended = false;
  /** `eof` arrived: all the bytes are here and only the sink's close is left (see `fail`). */
  let closing = false;
  // Serialize writes: chunks arrive ordered (the channel is ordered) but writes are async;
  // chaining keeps them in order and bounds concurrency to one outstanding write.
  let tail: Promise<void> = Promise.resolve();
  /** Bytes the sink has taken since the last credit (flow control — see the header). */
  let owed = 0;
  const grant = (n: number): void => {
    owed += n;
    if (owed < CREDIT_STEP) return;
    const bytes = owed;
    owed = 0;
    void wire.send(JSON.stringify({ t: 'credit', bytes })).catch(() => {});
  };

  const finalize = (e: ReceiveEvent): void => {
    if (ended) return;
    ended = true;
    emit(e);
  };
  const sendCancel = (): void => void wire.send(JSON.stringify({ t: 'cancel' })).catch(() => {});

  async function finish(): Promise<void> {
    if (ended || closing) return;
    closing = true;
    try {
      await tail; // drain queued writes (eof is the last message, so this is all of them)
      if (ended) return;
      // Confirm only what was promised: an eof before every declared byte is a broken transfer,
      // not a smaller file (padding past the declared size is already dropped, so "complete" is exact).
      if (received !== offer.size) throw new Error(`incomplete — ${received} of ${offer.size} bytes arrived`);
      const left = await sink.close();
      // The sender's "Delivered" waits for this (see the header).
      void wire.send(JSON.stringify({ t: 'received' })).catch(() => {});
      if (ended) {
        left?.discard(); // failed in the same breath — nobody will hand this off
        return;
      }
      finalize({ t: 'done', handoff: left ? { ...left, name: offer.name } : null });
    } catch (err) {
      await sink.abort().catch(() => {});
      sendCancel(); // or the sender would wait for a `received` that is never coming
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
      await wire.send(JSON.stringify({ t: 'accept', window: RECEIVE_WINDOW }));
    },
    handleChunk(data: ArrayBuffer): void {
      if (ended) return;
      tail = tail.then(async () => {
        if (ended) return;
        try {
          // Write AT MOST the size the sender declared in its offer, and silently drop the rest.
          //
          // Two things depend on this. It is what makes volume padding invisible to the user: the
          // filler after the real bytes (see sendFiles) is simply not written. And it closes a hole
          // that predates padding — the size guard ran BEFORE accept, against the DECLARED size, and
          // nothing enforced it afterwards, so on the streaming path (Chromium File System Access,
          // which has no RAM ceiling to stop it) a sender could declare 2 MB and write whatever it
          // liked to the user's disk. The peer is authenticated and the humans trust each other, so
          // this was never a stranger attack — but "you accepted 2 MB" must not be able to become
          // 50 GB on disk.
          const room = Math.max(0, offer.size - received);
          if (room > 0) {
            const usable = data.byteLength <= room ? data : data.slice(0, room);
            await sink.write(usable);
            received += usable.byteLength;
            emit({ t: 'progress', transferredBytes: received });
          }
          grant(data.byteLength); // taken — written, or dropped as padding
        } catch (err) {
          await sink.abort().catch(() => {});
          sendCancel();
          finalize({ t: 'error', reason: storageError(err) });
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
    fail(reason: string): void {
      if (ended || closing) return;
      finalize({ t: 'error', reason });
      void sink.abort().catch(() => {});
    },
    discard(): void {
      if (ended) return;
      ended = true;
      void sink.abort().catch(() => {});
    },
  };
}
