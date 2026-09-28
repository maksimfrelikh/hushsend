/**
 * Receiving to DISK without a save dialog: the Origin Private File System (OPFS).
 *
 * Every page gets a private, per-site folder the browser keeps on disk and a page can write to with
 * no picker at all. A received file is streamed into it chunk by chunk and, once complete, handed to
 * the user as an ordinary download read from that file — so a multi-gigabyte transfer never sits in
 * RAM, and there is no system dialog in front of the page while the connection is live (on Android a
 * save dialog left open for ~20 s took the connection down with it — BACKLOG § UX bugs). The owner's
 * rule (2026-09-27): write to disk wherever it is possible, a dialog only if that is the only way to
 * disk, and a RAM-only path capped hard.
 *
 * MEASURED 2026-09-27 on the real engines, through the live origin: Chrome 154, Safari 26.6 and
 * Firefox 156 all expose `navigator.storage.getDirectory()` and a main-thread `createWritable()`; 3 GiB
 * of incompressible data went through Safari in 2.4 s with no WebKit process above 31 MiB, and through
 * Firefox in 1.45 s with its parent process flat at ~100 MiB — the stream goes to disk, it is not
 * buffered until close(). Quotas the sites got: Chrome 10 GiB, Safari 76.8 GiB, Firefox 10 GiB (this
 * Mac); a file larger than the quota takes the next path instead.
 *
 * The folder is private to the site but it IS on disk, so it is kept empty: a failed or cancelled
 * receive removes its file at once; a delivered one stays only while the browser reads it into the
 * download (OPFS_HOLD_MS), and anything left behind — a tab that closed first — is swept the next
 * time hushsend starts. Each file is held under a Web Lock while it is in use, so one tab's sweep can
 * never delete another tab's receive.
 */

/** Sub-folder of the site's OPFS root that holds files being received or handed off. */
const INCOMING_DIR = 'incoming';
const LOCK_PREFIX = 'hushsend-incoming:';
/** How long a delivered file stays in site storage after the download was started, so the browser
 *  can finish reading it (deleting the source mid-read fails the download). */
export const OPFS_HOLD_MS = 10 * 60_000;
/** A delivered copy older than this is dropped early when a NEW receive needs its room (owner's
 *  decision, 2026-09-28: someone receiving several files with the site open will have let the earlier
 *  downloads through by then). The risk accepted: a download still waiting on the browser's own "allow
 *  downloads?" prompt after this long loses its source. */
export const OPFS_EVICT_AFTER_MS = 2 * 60_000;
/** Headroom left in the site's quota: the keystore lives in the same storage. */
const QUOTA_MARGIN = 64 * 1024 * 1024;
/** Without Web Locks a sweep cannot tell a live receive from a leftover, so it only removes files at
 *  least this old (their names start with the creation time). */
const UNLOCKED_SWEEP_AGE_MS = 24 * 60 * 60_000;

/** True when this browser can write a file into OPFS from the page. */
export function opfsSupported(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      typeof FileSystemFileHandle.prototype.createWritable === 'function'
    );
  } catch {
    return false;
  }
}

const usable = new WeakMap<object, Promise<boolean>>();

/**
 * Can this page ACTUALLY write into OPFS? Having the API is not the same: Playwright's WebKit build
 * (26.5) exposes it, reports a 1 GiB quota, and then fails the first write with "UnknownError: The
 * operation failed for an unknown transient reason" (measured 2026-09-27) — the shape a private
 * window can take too. So the first offer of a session writes and removes a tiny probe file; a
 * failure sends every receive of the session down the next path. Memoized per `navigator.storage`.
 */
export function opfsUsable(): Promise<boolean> {
  if (!opfsSupported()) return Promise.resolve(false);
  const key = navigator.storage as object;
  let probe = usable.get(key);
  if (!probe) {
    probe = (async () => {
      try {
        const dir = await incomingDir(true);
        if (!dir) return false;
        const name = `.probe-${randomHex(4)}`;
        const handle = await dir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        await w.write(new Uint8Array(1));
        await w.close();
        await dir.removeEntry(name);
        return true;
      } catch {
        return false;
      }
    })();
    usable.set(key, probe);
  }
  return probe;
}

/**
 * Can site storage REALLY take `size` more bytes? A reservation, not an estimate. In incognito Chrome
 * `estimate()` reports the normal profile's quota (10 GiB on this Mac — a site must not be able to tell
 * incognito apart by it) while the storage holds ~430 MiB, so a plan made from the estimate accepted a
 * 600 MiB file that then died at 74 % (TESTPLAN, 2026-09-28). `truncate(size)` on a fresh writable is
 * checked against the real limit and writes nothing — measured 2026-09-28: 1–2 ms for 5 GiB on Chrome,
 * Firefox and Safari, counted in the quota at once, a fast QuotaExceededError in incognito — and the
 * probe file is aborted and removed right after. Never throws.
 */
export async function opfsCanHold(size: number): Promise<boolean> {
  if (!opfsSupported()) return false;
  let dir: FileSystemDirectoryHandle | null;
  try {
    dir = await incomingDir(true);
  } catch {
    return false;
  }
  if (!dir) return false;
  const name = `.reserve-${randomHex(4)}`;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    try {
      await w.truncate(size);
      return true;
    } catch {
      return false;
    } finally {
      await w.abort().catch(() => {});
    }
  } catch {
    return false;
  } finally {
    await dir.removeEntry(name).catch(() => {});
  }
}

/**
 * Bytes the incoming folder holds right now: delivered copies still in their hold (OPFS_HOLD_MS) and
 * receives in flight in other tabs. A plan that cannot fit a file uses it to say WHY — the copy of the
 * last file, not a full disk (TESTPLAN 2026-09-28: 6 GiB then 5 GiB on Firefox's 10 GiB quota). 0 when
 * it cannot tell. Never throws.
 */
export async function opfsHeldBytes(): Promise<number> {
  if (!opfsSupported()) return 0;
  try {
    const dir = await incomingDir(false);
    if (!dir) return 0;
    let total = 0;
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    for (const name of names) {
      if (name.startsWith('.')) continue; // a write probe or a reservation probe, gone in a moment
      try {
        total += (await (await dir.getFileHandle(name)).getFile()).size;
      } catch {
        /* removed meanwhile, or not a file */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Bytes this site may still store, minus the margin; 0 when the browser will not say. */
export async function opfsRoom(): Promise<number> {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return Math.max(0, quota - usage - QUOTA_MARGIN);
  } catch {
    return 0;
  }
}

/** One file being received into OPFS. */
export interface IncomingFile {
  writable: FileSystemWritableFileStream;
  /** The finished file (call after the writable is closed) — backed by the disk, not by RAM. */
  file(): Promise<File>;
  /** Delete it now: a failed / cancelled receive, or a delivered file nobody saved. */
  remove(): Promise<void>;
  /** Delete it after OPFS_HOLD_MS: the download was started and is reading it (or sooner, after
   *  OPFS_EVICT_AFTER_MS, if a new receive needs the room — see evictHeld). */
  releaseLater(): void;
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function incomingDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(INCOMING_DIR, { create });
  } catch {
    return null;
  }
}

/** This tab's delivered copies in their hold: when the hold began, and how to end it now. */
const holding = new Set<{ since: number; drop: () => Promise<void> }>();

/**
 * Drop this tab's delivered copies whose hold began at least `minAgeMs` ago, to make room for a new
 * receive (see OPFS_EVICT_AFTER_MS). Copies other tabs hold are theirs (their Web Locks). Returns how
 * many were dropped.
 */
export async function evictHeld(minAgeMs = OPFS_EVICT_AFTER_MS): Promise<number> {
  const now = Date.now();
  const old = [...holding].filter((h) => now - h.since >= minAgeMs);
  for (const h of old) await h.drop();
  return old.length;
}

/** Hold `name`'s lock until the returned function is called. Resolves once the lock is held. */
async function holdLock(name: string): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => {};
  let release: () => void = () => {};
  await new Promise<void>((held) => {
    void navigator.locks.request(
      LOCK_PREFIX + name,
      () =>
        new Promise<void>((done) => {
          release = done;
          held();
        }),
    );
  });
  return release;
}

/**
 * Create a fresh file in the incoming folder, locked for as long as it is in use. With `size`, the
 * space is reserved up front (see opfsCanHold) — a store that cannot hold the file refuses here, before
 * `accept` is sent, instead of mid-transfer. The writes then fill it from the start.
 */
export async function createIncoming(size?: number): Promise<IncomingFile> {
  const dir = await incomingDir(true);
  if (!dir) throw new Error('site storage is unavailable');
  // The user-visible name is applied at download time; on disk it is only a time + a random tag.
  const name = `${Date.now()}-${randomHex(8)}`;
  const unlock = await holdLock(name);
  let handle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    handle = await dir.getFileHandle(name, { create: true });
    writable = await handle.createWritable();
    if (size != null) {
      try {
        await writable.truncate(size);
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
    }
  } catch (err) {
    unlock();
    await dir.removeEntry(name).catch(() => {});
    throw err;
  }
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held: { since: number; drop: () => Promise<void> } | null = null;
  const remove = async (): Promise<void> => {
    if (gone) return;
    gone = true;
    if (timer != null) clearTimeout(timer);
    if (held) holding.delete(held);
    await dir.removeEntry(name).catch(() => {});
    unlock();
  };
  return {
    writable,
    file: () => handle.getFile(),
    remove,
    releaseLater: () => {
      if (gone || timer != null) return;
      timer = setTimeout(() => void remove(), OPFS_HOLD_MS);
      held = { since: Date.now(), drop: remove };
      holding.add(held);
    },
  };
}

/** Is `name`'s lock free — i.e. no live tab is using that file? */
async function lockIsFree(name: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    const born = Number(name.split('-')[0]);
    return Number.isFinite(born) && Date.now() - born > UNLOCKED_SWEEP_AGE_MS;
  }
  return navigator.locks.request(
    LOCK_PREFIX + name,
    { ifAvailable: true },
    (lock) => lock !== null,
  );
}

/**
 * Remove whatever an earlier visit left in the incoming folder — a tab that closed while it held a
 * file. Files another open tab is still using are locked and left alone. Never throws.
 */
export async function sweepIncoming(): Promise<number> {
  if (!opfsSupported()) return 0;
  try {
    const dir = await incomingDir(false);
    if (!dir) return 0;
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    let removed = 0;
    for (const name of names) {
      if (!(await lockIsFree(name))) continue;
      await dir.removeEntry(name).then(
        () => removed++,
        () => {},
      );
    }
    return removed;
  } catch {
    return 0;
  }
}
