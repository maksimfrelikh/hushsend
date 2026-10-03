import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const stream = vi.hoisted(() => ({ supported: false, worker: true }));
vi.mock('./streamDownload', () => ({
  streamDownloadSupported: () => stream.supported,
  prepareDownloadWorker: async () => (stream.worker ? ({} as ServiceWorkerRegistration) : null),
  openStreamSink: async () => {
    throw new Error('not in unit tests');
  },
}));

// What the stubbed site storage holds right now — read at call time, so an eviction can change it.
const store = vi.hoisted(() => ({
  room: 0,
  holds: 0,
  held: 0,
  evict: async (): Promise<number> => 0,
}));
vi.mock('./opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./opfs')>()),
  evictHeld: () => store.evict(),
}));

import { CHUNK_MAX, CHUNK_MIN, MAX_BYTES_BLOB, READ_WINDOW, Rechunker, chunkSize, formatBytes, planReceive, readInWindows } from './fileTransfer';

/**
 * The receive-path POLICY (owner's rules, 2026-09-27 and -28): disk wherever possible — straight into
 * Downloads where the browser can stream a download (no copy, no RAM, no dialog), else OPFS (no
 * dialog) when site storage REALLY holds the file, the save dialog only when neither can take it, RAM
 * last and capped at 200 MB — and how a refusal is worded. The engines' real support was measured on
 * the live origin (transfer/opfs.ts, transfer/streamDownload.ts); these are the cheap, deterministic
 * half of the decision.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const GiB = 1024 ** 3;

beforeEach(() => {
  stream.supported = false;
  stream.worker = true;
  store.evict = async () => 0; // no copy old enough to drop
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Just enough of an OPFS folder for the write probe (opfsUsable) and the reservation (opfsCanHold):
 *  `holds` is what the storage can REALLY take, whatever the estimate says. */
function writableDir(): unknown {
  const dir = {
    // The incoming folder's contents: one delivered copy still in its hold, if any.
    async *keys() {
      if (store.held) yield '1700000000000-deadbeefdeadbeef';
    },
    getDirectoryHandle: async () => dir,
    getFileHandle: async () => ({
      getFile: async () => ({ size: store.held }),
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
        abort: async () => {},
        truncate: async (n: number) => {
          if (n > store.holds)
            throw new DOMException('would exceed its storage quota', 'QuotaExceededError');
        },
      }),
    }),
    removeEntry: async () => {},
  };
  return dir;
}

/** A browser with (or without) OPFS, a site quota (and what its storage really holds), and (or
 *  without) the save dialog. */
function browser(opts: {
  opfs?: boolean;
  room?: number;
  holds?: number;
  /** Bytes of just-received files still held in site storage. */
  held?: number;
  estimateFails?: boolean;
  dialog?: boolean;
  ua?: string;
}) {
  const { opfs = false, room = 0, estimateFails = false, dialog = false, ua = MAC } = opts;
  store.room = room;
  store.holds = opts.holds ?? room;
  store.held = opts.held ?? 0;
  vi.stubGlobal('navigator', {
    userAgent: ua,
    storage: {
      ...(opfs ? { getDirectory: async () => writableDir() } : {}),
      estimate: async () => {
        if (estimateFails) throw new Error('no estimate');
        return { quota: store.room + 64 * 1024 * 1024, usage: 0 }; // opfsRoom keeps 64 MiB of headroom
      },
    },
  });
  vi.stubGlobal(
    'FileSystemFileHandle',
    opfs
      ? class {
          createWritable(): void {}
        }
      : undefined,
  );
  vi.stubGlobal('window', dialog ? { showSaveFilePicker: async () => ({}) } : {});
}

describe('which path a file is received through', () => {
  it('straight into Downloads first, wherever the browser can stream a download — no copy at all', async () => {
    stream.supported = true;
    browser({ opfs: true, room: 10 * GiB, dialog: true });
    expect(await planReceive(50 * GiB)).toEqual({ path: 'stream', maxBytes: Infinity });
  });

  it('a download worker that cannot come up hands the file to site storage instead', async () => {
    stream.supported = true;
    stream.worker = false;
    browser({ opfs: true, room: 10 * GiB, dialog: true });
    expect(await planReceive(5 * GiB)).toEqual({ path: 'opfs', maxBytes: 10 * GiB });
  });

  it('incognito Chrome reports a quota its storage cannot hold — the reservation catches it before accept', async () => {
    // Measured 2026-09-28: estimate() says 10 GiB, the storage takes ~430 MiB. Planned from the
    // estimate, a 600 MiB file was accepted and died at 74 %; planned by reservation it never starts.
    browser({ opfs: true, room: 10 * GiB, holds: 430 * 1024 * 1024, dialog: true });
    expect(await planReceive(600 * 1024 * 1024)).toEqual({ path: 'fsa', maxBytes: Infinity });
    browser({ opfs: true, room: 10 * GiB, holds: 430 * 1024 * 1024, dialog: false });
    const r = (await planReceive(600 * 1024 * 1024)) as { refused: string };
    // The refusal names the RAM cap — not the 10 GB the failed reservation just proved false.
    expect(r.refused).toMatch(/larger than the 200 MB/);
    browser({ opfs: true, room: 10 * GiB, holds: 430 * 1024 * 1024, dialog: false });
    expect(await planReceive(300 * 1024 * 1024)).toEqual({ path: 'opfs', maxBytes: 10 * GiB });
  });

  it('storage full of the file just received says so — wait a few minutes, not "free up disk space"', async () => {
    // Firefox's 10 GiB quota with 6 GiB still held from the last receive (measured on the live build):
    // a 5 GiB offer would fit but for that copy.
    browser({ opfs: true, room: 4 * GiB, held: 6 * GiB, dialog: false });
    const r = (await planReceive(5 * GiB)) as { refused: string };
    expect(r.refused).toMatch(/still holding the last file it received/);
    expect(r.refused).toMatch(/couple of minutes/);
    expect(r.refused).not.toMatch(/Free up disk space/);
    // Past what even an emptied store could take, the plain reason stands.
    browser({ opfs: true, room: 4 * GiB, held: 6 * GiB, dialog: false });
    expect(((await planReceive(20 * GiB)) as { refused: string }).refused).toMatch(/larger than the 4\.0 GB/);
  });

  it('a copy held for two minutes gives way to the next big file (owner, 2026-09-28)', async () => {
    // The same 6 GiB copy, now old enough to drop: it goes, and the 5 GiB file takes its room.
    browser({ opfs: true, room: 4 * GiB, held: 6 * GiB, dialog: false });
    store.evict = async () => {
      store.room += store.held;
      store.holds += store.held;
      store.held = 0;
      return 1;
    };
    expect(await planReceive(5 * GiB)).toEqual({ path: 'opfs', maxBytes: 10 * GiB });
  });

  it('OPFS first — disk with no dialog — whenever the site quota can hold the file', async () => {
    browser({ opfs: true, room: 10 * GiB, dialog: true });
    expect(await planReceive(5 * GiB)).toEqual({ path: 'opfs', maxBytes: 10 * GiB });
  });

  it('the save dialog only when OPFS cannot take it — still disk, and unbounded', async () => {
    browser({ opfs: true, room: 1 * GiB, dialog: true });
    expect(await planReceive(5 * GiB)).toEqual({ path: 'fsa', maxBytes: Infinity });
  });

  it('RAM is the last resort, capped at 200 MB', async () => {
    browser({ opfs: false, dialog: false });
    expect(await planReceive(150 * 1024 * 1024)).toEqual({ path: 'blob', maxBytes: MAX_BYTES_BLOB });
    const over = await planReceive(MAX_BYTES_BLOB + 1024 * 1024);
    expect(over).toHaveProperty('refused');
    expect((over as { refused: string }).refused).toMatch(/larger than the 200 MB/);
  });

  it('one RAM cap for every device — a phone, a tablet and a desktop alike', async () => {
    for (const ua of [IPHONE, ANDROID, MAC]) {
      browser({ ua });
      expect(await planReceive(1024), ua).toEqual({ path: 'blob', maxBytes: MAX_BYTES_BLOB });
    }
  });

  it('OPFS the browser has but will not WRITE (the probe fails) is skipped — Playwright\'s WebKit, a private window', async () => {
    browser({ opfs: true, room: 10 * GiB, dialog: false });
    const n = navigator as unknown as { storage: { getDirectory: () => Promise<unknown> } };
    n.storage.getDirectory = async () => {
      throw new DOMException('The operation failed for an unknown transient reason', 'UnknownError');
    };
    expect(await planReceive(1024)).toEqual({ path: 'blob', maxBytes: MAX_BYTES_BLOB });
  });

  it('a quota the browser will not report counts as none — the next path takes over', async () => {
    browser({ opfs: true, estimateFails: true, dialog: false });
    expect(await planReceive(1024)).toEqual({ path: 'blob', maxBytes: MAX_BYTES_BLOB });
  });

  it('a refusal names the biggest thing that would have fitted, and never "1.0 GB — larger than 1.0 GB"', async () => {
    browser({ opfs: true, room: 3 * GiB, dialog: false });
    const r = (await planReceive(8 * GiB)) as { refused: string };
    expect(r.refused).toMatch(/This file is 8\.0 GB — larger than the 3\.0 GB/);
    browser({ opfs: false, dialog: false });
    const tight = (await planReceive(MAX_BYTES_BLOB + 1)) as { refused: string };
    expect(tight.refused).toContain(`${MAX_BYTES_BLOB + 1} bytes — larger than the ${MAX_BYTES_BLOB} bytes`);
  });
});

describe('how the ceiling is worded to the human', () => {
  it('names the RAM cap in units a person reads, since the refusal text quotes it', () => {
    expect(formatBytes(MAX_BYTES_BLOB)).toBe('200 MB');
  });

  it('handles the unbounded case and small sizes', () => {
    expect(formatBytes(Infinity)).toBe('∞');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('chunk sizing against the SCTP limit', () => {
  it('clamps the negotiated maximum into [CHUNK_MIN, CHUNK_MAX]', () => {
    expect(chunkSize(4 * 1024 * 1024)).toBe(CHUNK_MAX); // engine offers more than we will use
    expect(chunkSize(1024)).toBe(CHUNK_MIN); // engine offers less than is worth sending
    expect(chunkSize(64 * 1024)).toBe(64 * 1024); // in range — taken as-is
  });

  it('falls back to the maximum when the negotiated size is unknown (0)', () => {
    expect(chunkSize(0)).toBe(CHUNK_MAX);
  });
});

describe('reading the file for the wire (2026-10-03 — WebKit streams a Blob as ONE chunk)', () => {
  const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) & 255);
  const collect = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  };

  it('readInWindows yields windows of the given size and an exact last one, never more than one window of the file at a time', async () => {
    const data = bytes(10 * 1024 + 123);
    const chunks = await collect(readInWindows(new Blob([data]), 4096));
    expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 2048 + 123]);
    const joined = new Uint8Array(data.length);
    let off = 0;
    for (const c of chunks) {
      joined.set(c, off);
      off += c.length;
    }
    expect(joined).toEqual(data);
  });

  it('an empty file closes at once; a file exactly one window long yields exactly one window', async () => {
    expect(await collect(readInWindows(new Blob([]), 4096))).toEqual([]);
    const one = await collect(readInWindows(new Blob([bytes(4096)]), 4096));
    expect(one.map((c) => c.length)).toEqual([4096]);
  });

  it('the default window is 4 MiB — 16 wire chunks of CHUNK_MAX', () => {
    expect(READ_WINDOW).toBe(16 * CHUNK_MAX);
  });

  it('Rechunker returns VIEWS of a window that covers the request (no copy) and copies only to coalesce', () => {
    const rc = new Rechunker();
    const win = bytes(1000);
    rc.push(win);
    const a = rc.pull(400, false)!;
    const b = rc.pull(400, false)!;
    expect(a.buffer).toBe(win.buffer); // a view, not a copy
    expect(b.buffer).toBe(win.buffer);
    expect(a.byteOffset).toBe(0);
    expect(b.byteOffset).toBe(400);
    expect(rc.pull(400, false)).toBeNull(); // 200 left, no flush
    rc.push(bytes(300, 3));
    const c = rc.pull(400, false)!; // 200 from the first window + 200 from the second: a copy
    expect(c.length).toBe(400);
    expect(c.buffer).not.toBe(win.buffer);
    expect(Array.from(c.subarray(0, 200))).toEqual(Array.from(win.subarray(800)));
    const tail = rc.pull(400, true)!; // flush: the last 100 of the second chunk, as a view
    expect(tail.length).toBe(100);
    expect(rc.pull(400, true)).toBeNull();
  });
});
