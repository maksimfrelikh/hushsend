/**
 * Receiving STRAIGHT INTO Downloads: no copy in site storage, nothing held in RAM, no dialog.
 *
 * A page cannot stream a download by itself — `<a download>` needs the whole file up front, which is
 * why the other paths keep one in site storage (./opfs.ts) or in RAM. A service worker can: it answers
 * a navigation with a streaming Response, and `Content-Disposition: attachment` turns that navigation
 * into a download the browser writes to disk as the bytes arrive. The worker is public/dl/sw.js; this
 * side registers it when a file is offered, hands it the receive stream (a transferred
 * ReadableStream, so every chunk flows page → download manager with backpressure intact), navigates a
 * hidden iframe to it, and unregisters it a minute after the download ends.
 *
 * WHERE — desktop Chromium only (Chrome, Edge, Brave), from what the real engines did 2026-09-28:
 *   - Chrome 154: 1 GiB through the worker, the saved file's SHA-256 right, memory flat; a stream the
 *     page aborts ends the download as failed, and so does a worker killed mid-download — the
 *     download manager never completes a short file.
 *   - Firefox 156 streams just as well, but FAILS UNSAFELY: an aborted stream leaves the download
 *     "in progress" for good (a `.part` plus an empty file under the real name), and when the worker
 *     is gone Firefox COMPLETES the download with the bytes it had — a truncated file that looks
 *     whole. So Firefox keeps site storage, which it runs flat and cleans up on failure.
 *   - Safari 26.6 cannot transfer a stream (DataCloneError), and fed chunk by chunk it creates the
 *     download and writes 0 bytes — WebKit (Safari, every iOS browser) keeps site storage.
 *   - mobile Chromium: unproven until a handset runs it (TESTPLAN B2/B10), so it keeps site storage.
 */

const SCOPE = '/dl/';
const SCRIPT = '/dl/sw.js';
/** Registration + activation, and the worker's answer to a stream. */
const READY_TIMEOUT_MS = 5000;
/** A message event extends a service worker's lifetime; ping while a download streams. */
const KEEPALIVE_MS = 10_000;
/** How long after the last download the worker (and its iframe) stays: the download manager may
 *  still be reading the tail of the stream when the page has written its last byte. */
const LINGER_MS = 60_000;

/** True when this browser can take the stream path (see the header for why these engines). */
export function streamDownloadSupported(): boolean {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return false;
    if (typeof ReadableStream === 'undefined' || typeof TransformStream === 'undefined')
      return false;
    if (!desktopChromium()) return false;
    return transferableStreams();
  } catch {
    return false;
  }
}

/** User-Agent Client Hints exist only in Chromium browsers, and say plainly whether it is a phone —
 *  Firefox and WebKit have no `userAgentData` at all, so they fall out without sniffing a UA string. */
function desktopChromium(): boolean {
  const uad = (navigator as Navigator & { userAgentData?: { mobile?: unknown; brands?: unknown } })
    .userAgentData;
  if (!uad || uad.mobile !== false || !Array.isArray(uad.brands)) return false;
  return uad.brands.some((b: { brand?: unknown }) => b && b.brand === 'Chromium');
}

let transferable: boolean | null = null;
function transferableStreams(): boolean {
  if (transferable !== null) return transferable;
  try {
    const rs = new ReadableStream();
    const { port1, port2 } = new MessageChannel();
    port1.postMessage(rs, [rs]);
    port1.close();
    port2.close();
    transferable = true;
  } catch {
    transferable = false;
  }
  return transferable;
}

let registering: Promise<ServiceWorkerRegistration | null> | null = null;
let active = 0;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Register the download worker (idempotent) and wait for it to activate. Called when a file is
 * offered, so it is ready by the time Accept is tapped. Null if it cannot come up in time. A worker
 * nobody streams through (the offer was declined) is unregistered again after LINGER_MS.
 */
export function prepareDownloadWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!registering) {
    registering = (async () => {
      try {
        navigator.serviceWorker.startMessages();
        const reg = await navigator.serviceWorker.register(SCRIPT, {
          scope: SCOPE,
          updateViaCache: 'none',
        });
        return (await activated(reg)) ? reg : null;
      } catch {
        return null;
      }
    })().then((reg) => {
      if (!reg) registering = null;
      else if (active === 0) scheduleLinger();
      return reg;
    });
  }
  return registering;
}

function activated(reg: ServiceWorkerRegistration): Promise<boolean> {
  const w = reg.installing ?? reg.waiting ?? reg.active;
  if (!w) return Promise.resolve(false);
  if (w.state === 'activated') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), READY_TIMEOUT_MS);
    const check = (): void => {
      if (w.state === 'activated') done(true);
      else if (w.state === 'redundant') done(false);
    };
    function done(ok: boolean): void {
      clearTimeout(timer);
      w!.removeEventListener('statechange', check);
      resolve(ok);
    }
    w.addEventListener('statechange', check);
  });
}

/** A download through the worker has ended: unregister it once nothing streams for LINGER_MS. */
function releaseWorker(): void {
  active = Math.max(0, active - 1);
  if (active === 0) scheduleLinger();
}

function scheduleLinger(): void {
  if (lingerTimer != null) clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    if (active > 0) return;
    const r = registering;
    registering = null;
    void r?.then((reg) => reg?.unregister()).catch(() => {});
  }, LINGER_MS);
}

/**
 * Remove a download worker an earlier visit left registered (a tab closed mid-download). An
 * unregistered worker still finishes a download another tab is streaming through it; it only stops
 * taking new ones, and that tab registers afresh for its next file. Never throws.
 */
export async function sweepDownloadWorker(): Promise<number> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 0;
    const regs = await navigator.serviceWorker.getRegistrations();
    let n = 0;
    for (const r of regs) {
      if (new URL(r.scope).pathname === SCOPE && (await r.unregister())) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export interface StreamSink {
  write(chunk: ArrayBuffer): Promise<void>;
  /** Every byte written: end the stream — the browser completes the download. */
  close(): Promise<void>;
  /** Fail the download (the browser discards the partial file). */
  abort(reason: string): Promise<void>;
}

/**
 * Start a download of `size` bytes named `name` and return where to write it. Must run in the
 * Accept gesture: the hidden iframe's navigation is what the browser turns into the download.
 */
export async function openStreamSink(name: string, size: number): Promise<StreamSink> {
  const sw = await liveWorker();
  if (!sw) throw new Error('the download worker is unavailable');
  active++;
  if (lingerTimer != null) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
  let finished = false;
  let frame: HTMLIFrameElement | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (ping != null) clearInterval(ping);
    const f = frame;
    setTimeout(() => f?.remove(), LINGER_MS);
    releaseWorker();
  };
  try {
    const id = randomHex(16);
    // Two chunks of slack on each side: the download manager's pull reaches back to write().
    const ts = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      { highWaterMark: 2 },
      { highWaterMark: 2 },
    );
    const ready = workerAnswer(id);
    sw.postMessage({ t: 'hs-stream', id, name, size, readable: ts.readable }, [ts.readable]);
    if (!(await ready)) throw new Error('the download worker did not answer');
    frame = document.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = SCOPE + id;
    document.body.appendChild(frame);
    ping = setInterval(() => sw.postMessage({ t: 'hs-ping' }), KEEPALIVE_MS);
    const writer = ts.writable.getWriter();
    return {
      async write(chunk) {
        try {
          await writer.write(new Uint8Array(chunk));
        } catch {
          finish();
          throw new Error('the browser stopped the download (cancelled, or the disk is full)');
        }
      },
      async close() {
        try {
          await writer.close();
        } finally {
          finish();
        }
      },
      async abort(reason) {
        try {
          await writer.abort(new Error(reason));
        } catch {
          /* already errored or closed */
        } finally {
          finish();
        }
      },
    };
  } catch (err) {
    finish();
    throw err;
  }
}

/** The active download worker — registered afresh if it was unregistered under us since the offer
 *  (another hushsend tab's startup sweep, see sweepDownloadWorker). */
async function liveWorker(): Promise<ServiceWorker | null> {
  if (!(await prepareDownloadWorker())) return null;
  const current = await navigator.serviceWorker.getRegistration(SCOPE).catch(() => undefined);
  if (current?.active?.state === 'activated') return current.active;
  registering = null;
  return (await prepareDownloadWorker())?.active ?? null;
}

function workerAnswer(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), READY_TIMEOUT_MS);
    const onMessage = (e: MessageEvent): void => {
      const m = e.data as { t?: unknown; id?: unknown } | null;
      if (m && m.t === 'hs-stream-ready' && m.id === id) done(true);
    };
    function done(ok: boolean): void {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(ok);
    }
    navigator.serviceWorker.addEventListener('message', onMessage);
  });
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
