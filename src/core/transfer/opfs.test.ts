import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OPFS_HOLD_MS,
  createIncoming,
  opfsCanHold,
  opfsHeldBytes,
  opfsSupported,
  sweepIncoming,
} from './opfs';

/**
 * The site-storage receive path's housekeeping (transfer/opfs.ts): what is written comes back as a
 * file, a failed or unsaved one is removed at once, a delivered one after the hold, and a sweep at
 * start removes leftovers — but never a file another open tab is still receiving into (its Web
 * Lock is held). Against a small in-memory OPFS + Web Locks; the real engines were measured on the
 * live origin (see the module's header).
 */

/** What the fake storage REALLY holds, whatever estimate() says (incognito Chrome: ~430 MiB). */
let holds = Infinity;

class FakeWritable {
  private readonly parts: BlobPart[] = [];
  constructor(private readonly onClose: (parts: BlobPart[]) => void) {}
  async write(chunk: BlobPart): Promise<void> {
    this.parts.push(chunk);
  }
  async truncate(size: number): Promise<void> {
    if (size > holds)
      throw new DOMException('would exceed its storage quota', 'QuotaExceededError');
  }
  async close(): Promise<void> {
    this.onClose(this.parts);
  }
  async abort(): Promise<void> {}
}

class FakeFileHandle {
  data: BlobPart[] = [];
  constructor(readonly name: string) {}
  async createWritable(): Promise<FakeWritable> {
    return new FakeWritable((parts) => (this.data = parts));
  }
  async getFile(): Promise<File> {
    return new File(this.data, this.name);
  }
}

class FakeDir {
  readonly entries = new Map<string, FakeFileHandle | FakeDir>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let d = this.entries.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      d = new FakeDir();
      this.entries.set(name, d);
    }
    return d as FakeDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.entries.get(name);
    if (!f) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      f = new FakeFileHandle(name);
      this.entries.set(name, f);
    }
    return f as FakeFileHandle;
  }
  async removeEntry(name: string): Promise<void> {
    this.entries.delete(name);
  }
  async *keys(): AsyncIterable<string> {
    for (const k of [...this.entries.keys()]) yield k;
  }
}

/** A Web Locks stand-in: exclusive locks, `ifAvailable` answered at once. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const opts = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
      const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown;
      if (held.has(name)) {
        if (opts.ifAvailable) return Promise.resolve(cb(null));
        return new Promise(() => {}); // never granted in these tests
      }
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
  };
}

let root: FakeDir;
let locks: ReturnType<typeof fakeLocks>;

beforeEach(() => {
  holds = Infinity;
  root = new FakeDir();
  locks = fakeLocks();
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root, estimate: async () => ({ quota: 1e12, usage: 0 }) },
    locks,
  });
  vi.stubGlobal('FileSystemFileHandle', FakeFileHandle);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const incoming = async (): Promise<FakeDir> => root.getDirectoryHandle('incoming');

describe('receiving into site storage (OPFS)', () => {
  it('is available when the page can create a writable in OPFS — and not otherwise', () => {
    expect(opfsSupported()).toBe(true);
    vi.stubGlobal('FileSystemFileHandle', class {});
    expect(opfsSupported()).toBe(false);
  });

  it('what is written comes back as the file; remove() deletes it and frees its lock', async () => {
    const f = await createIncoming();
    await f.writable.write(new Uint8Array([1, 2, 3]));
    await f.writable.close();
    expect((await f.file()).size).toBe(3);
    expect((await incoming()).entries.size).toBe(1);
    expect(locks.held.size).toBe(1); // in use: another tab's sweep must leave it alone

    await f.remove();
    expect((await incoming()).entries.size).toBe(0);
    await Promise.resolve();
    expect(locks.held.size).toBe(0);
  });

  it('a delivered file stays for the hold — the download is still reading it — then goes', async () => {
    vi.useFakeTimers();
    const f = await createIncoming();
    await f.writable.close();
    f.releaseLater();
    await vi.advanceTimersByTimeAsync(OPFS_HOLD_MS - 1);
    expect((await incoming()).entries.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await incoming()).entries.size).toBe(0);
  });

  it('the sweep at start removes leftovers but not a file another open tab is receiving into', async () => {
    const dir = await root.getDirectoryHandle('incoming', { create: true });
    await dir.getFileHandle('1700000000000-deadbeefdeadbeef', { create: true }); // a closed tab's leftover
    const live = await createIncoming(); // a live receive: its lock is held
    expect(dir.entries.size).toBe(2);

    expect(await sweepIncoming()).toBe(1);
    expect(dir.entries.size).toBe(1);
    await live.remove();
    expect(dir.entries.size).toBe(0);
  });

  it('a reservation answers what the storage REALLY holds and leaves nothing behind', async () => {
    holds = 430 * 1024 * 1024;
    expect(await opfsCanHold(300 * 1024 * 1024)).toBe(true);
    expect(await opfsCanHold(600 * 1024 * 1024)).toBe(false);
    expect((await incoming()).entries.size).toBe(0); // the probe files are gone either way
  });

  it('a receive that cannot reserve its size fails before accept and keeps no file or lock', async () => {
    holds = 430 * 1024 * 1024;
    await expect(createIncoming(600 * 1024 * 1024)).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect((await incoming()).entries.size).toBe(0);
    await Promise.resolve();
    expect(locks.held.size).toBe(0);
    const ok = await createIncoming(300 * 1024 * 1024);
    expect((await incoming()).entries.size).toBe(1);
    await ok.remove();
  });

  it('counts the bytes still held — delivered copies and live receives, never the probe files', async () => {
    expect(await opfsHeldBytes()).toBe(0);
    const a = await createIncoming();
    await a.writable.write(new Uint8Array(3));
    await a.writable.close();
    const b = await createIncoming();
    await b.writable.write(new Uint8Array(5));
    await b.writable.close();
    const dir = await incoming();
    await dir.getFileHandle('.reserve-0000', { create: true }); // a reservation probe mid-flight
    expect(await opfsHeldBytes()).toBe(8);
    await a.remove();
    expect(await opfsHeldBytes()).toBe(5);
    await b.remove();
  });

  it('a sweep with nothing there, or no site storage at all, is a quiet no-op', async () => {
    expect(await sweepIncoming()).toBe(0);
    vi.stubGlobal('navigator', {});
    expect(await sweepIncoming()).toBe(0);
  });
});
