// The zxing reader `.wasm` as a SELF-HOSTED, build-fingerprinted asset. Vite resolves this
// `?url` import to our OWN origin (e.g. `/assets/zxing_reader-<hash>.wasm`) and emits the
// binary into `dist/assets/` — the WASM is NEVER imported into the JS bundle, only its final
// URL string is, so this stays a tiny constant and the heavy bytes are fetched lazily (only
// when a scan actually instantiates the decoder, see `createQrDetector`).
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/**
 * Self-host the QR-scanner WASM (step 6e hardening).
 *
 * `barcode-detector`'s zxing fallback (the path taken on browsers WITHOUT a native
 * `BarcodeDetector` — iOS Safari / Firefox) ships a DEFAULT Emscripten `locateFile` that fetches
 * `zxing_reader.wasm` from a third-party CDN (`fastly.jsdelivr.net`) at scan time. That means a QR
 * scan would (a) leak the client IP to jsdelivr and (b) execute WASM delivered by a host we don't
 * control — a privacy + supply-chain risk for a privacy tool. We override `locateFile` to point at
 * the vendored, same-origin asset above, so the WASM is served from `'self'` and the CSP
 * `connect-src` no longer needs the CDN.
 *
 * `barcode-detector/ponyfill` is imported DYNAMICALLY (kept lazy as before — neither the ponyfill
 * JS nor the WASM loads unless the user actually scans). `setZXingModuleOverrides` registers the
 * override on the SAME reader factory that `BarcodeDetector.detect` later instantiates, and it must
 * be set BEFORE the first detect (which triggers instantiation) — so we set it here, before
 * constructing the detector. The flag makes it idempotent across re-mounts.
 */

/** The fully-resolved, same-origin URL of the vendored zxing reader WASM (no CDN). Exported for the test. */
export const ZXING_READER_WASM_URL: string = zxingReaderWasmUrl;

/**
 * Emscripten `locateFile`: redirect the reader `.wasm` request to our self-hosted asset; anything
 * else falls through to the loader's default (`scriptDirectory + path`). Pure + exported so a unit
 * test can prove the wired path resolves to OUR origin and never to jsdelivr/fastly.
 */
export function locateZxingWasm(path: string, scriptDirectory: string): string {
  return path.endsWith('.wasm') ? ZXING_READER_WASM_URL : scriptDirectory + path;
}

type QrDetector = import('barcode-detector/ponyfill').BarcodeDetector;

let overridesConfigured = false;

/**
 * Lazily import the `barcode-detector` ponyfill, point its zxing WASM loader at the self-hosted
 * asset (once), and return a QR-only `BarcodeDetector`. Throws if the ponyfill module fails to
 * load — the caller (ScanScreen) treats that as "scanner unavailable" and shows the paste fallback.
 */
export async function createQrDetector(): Promise<QrDetector> {
  const mod = await import('barcode-detector/ponyfill');
  if (!overridesConfigured) {
    mod.setZXingModuleOverrides({ locateFile: locateZxingWasm });
    overridesConfigured = true;
  }
  return new mod.BarcodeDetector({ formats: ['qr_code'] });
}
