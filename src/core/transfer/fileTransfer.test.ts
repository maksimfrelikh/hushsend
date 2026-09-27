import { describe, it, expect, afterEach, vi } from 'vitest';
import { CHUNK_MAX, CHUNK_MIN, MAX_BYTES_BLOB, chunkSize, formatBytes, planReceive } from './fileTransfer';

/**
 * The receive-path POLICY (owner's rule, 2026-09-27): disk wherever possible — OPFS first (no
 * dialog), the save dialog only when OPFS cannot take the file, RAM last and capped at 200 MB — and
 * how a refusal is worded. The engines' real support was measured on the live origin (transfer/opfs.ts);
 * these are the cheap, deterministic half of the decision.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const GiB = 1024 ** 3;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Just enough of an OPFS folder for the write probe (opfsUsable) to succeed. */
function writableDir(): unknown {
  const dir = {
    getDirectoryHandle: async () => dir,
    getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }),
    removeEntry: async () => {},
  };
  return dir;
}

/** A browser with (or without) OPFS, a site quota, and (or without) the save dialog. */
function browser(opts: { opfs?: boolean; room?: number; estimateFails?: boolean; dialog?: boolean; ua?: string }) {
  const { opfs = false, room = 0, estimateFails = false, dialog = false, ua = MAC } = opts;
  vi.stubGlobal('navigator', {
    userAgent: ua,
    storage: {
      ...(opfs ? { getDirectory: async () => writableDir() } : {}),
      estimate: async () => {
        if (estimateFails) throw new Error('no estimate');
        return { quota: room + 64 * 1024 * 1024, usage: 0 }; // opfsRoom keeps 64 MiB of headroom
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
