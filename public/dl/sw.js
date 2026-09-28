/**
 * hushsend download worker — the whole of it.
 *
 * Its one job: let a receiving page hand the browser's download manager a STREAM, so a file goes
 * straight into Downloads as it arrives — no copy in site storage, nothing held in RAM, no dialog.
 * A page cannot do that by itself (a plain download needs the whole file up front); a service worker
 * can answer a navigation with a streaming Response, and a navigation that answers with
 * `Content-Disposition: attachment` becomes a download.
 *
 * Kept deliberately small, because it is code the browser keeps between visits:
 *   - scope `/dl/` only — it can never control or intercept the app's own pages or assets;
 *   - it answers exactly `/dl/<32 hex>` for a stream a same-origin page registered moments ago
 *     (a service worker only ever receives messages from its own origin), once, and 404s the rest;
 *   - no cache, no storage, no network access of its own;
 *   - the page registers it when a file is offered and unregisters it after the download
 *     (src/core/transfer/streamDownload.ts), and sweeps leftovers at start.
 */
'use strict';

const ID = /^[0-9a-f]{32}$/;
/** Streams a page registered and the browser has not fetched yet: id → { readable, name, size }. */
const pending = new Map();

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  // A keep-alive while a download streams: each message event extends the worker's lifetime.
  if (m.t === 'hs-ping') {
    event.waitUntil(Promise.resolve());
    return;
  }
  if (m.t !== 'hs-stream') return;
  if (typeof m.id !== 'string' || !ID.test(m.id) || !(m.readable instanceof ReadableStream)) return;
  if (typeof m.name !== 'string' || !Number.isSafeInteger(m.size) || m.size < 0) return;
  pending.set(m.id, { readable: m.readable, name: m.name, size: m.size });
  // Unclaimed streams do not linger (the page navigates to it right after this reply).
  setTimeout(() => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.readable.cancel('download never started').catch(() => {});
  }, 60_000);
  if (event.source) event.source.postMessage({ t: 'hs-stream-ready', id: m.id });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const match = /^\/dl\/([0-9a-f]{32})$/.exec(url.pathname);
  if (!match) return; // e.g. this script itself — the network answers
  const p = pending.get(match[1]);
  pending.delete(match[1]);
  if (!p) {
    event.respondWith(new Response(null, { status: 404 }));
    return;
  }
  event.respondWith(
    new Response(p.readable, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(p.name),
        // The browser knows the total, and a stream that ends short is a failed download.
        'Content-Length': String(p.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    }),
  );
});

/** `attachment` with an ASCII fallback and the exact name per RFC 6266 / 5987. */
function contentDisposition(name) {
  let clean = '';
  for (const ch of name) {
    const c = ch.codePointAt(0);
    clean += c < 0x20 || c === 0x7f || ch === '/' || ch === '\\' ? '_' : ch; // no control chars, no path
  }
  const safe = Array.from(clean.trim()).slice(0, 200).join('') || 'download'; // by code point: never half an emoji
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
  const exact = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
}
