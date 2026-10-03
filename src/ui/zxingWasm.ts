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
 * JS nor the WASM loads unless the user actually scans — and since 2026-10-03 not even then on a browser
 * whose own `BarcodeDetector` decodes QR codes; see `createQrDetector` below). `setZXingModuleOverrides` registers the
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

/** What the scan loop needs of a detector — the platform's `BarcodeDetector` and the ponyfill both have it. */
export interface QrDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}
export type QrDetectorKind = 'native' | 'zxing';
export interface QrDetector extends QrDetectorLike {
  readonly kind: QrDetectorKind;
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: string[] }): QrDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

let overridesConfigured = false;

/**
 * The ponyfill: lazily import `barcode-detector/ponyfill`, point its zxing WASM loader at the self-hosted
 * asset (once), and return a QR-only detector. Throws if the module fails to load — the caller treats
 * that as "scanner unavailable" and shows the paste fallback. This is the path of every browser without
 * a usable native detector (iOS Safari, Firefox), and the fallback of the ones with one.
 */
export async function createZxingQrDetector(): Promise<QrDetectorLike> {
  const mod = await import('barcode-detector/ponyfill');
  if (!overridesConfigured) {
    mod.setZXingModuleOverrides({ locateFile: locateZxingWasm });
    overridesConfigured = true;
  }
  return new mod.BarcodeDetector({ formats: ['qr_code'] });
}

/**
 * The platform's own `BarcodeDetector`, if it exists AND lists QR codes; null otherwise, never a throw.
 * Chrome on the desktop and on Android have one — using it saves the ~1 MB zxing WASM download on the
 * first scan (owner's decision, 2026-10-03). Injectable globals for the unit test.
 */
export async function nativeQrDetector(
  g: { BarcodeDetector?: NativeBarcodeDetectorCtor } = globalThis as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor },
): Promise<QrDetectorLike | null> {
  const Ctor = g.BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    const formats = await Ctor.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/**
 * Native first; the moment a native `detect()` THROWS (an empty result is not a throw — it is "no code
 * in this frame"), load the zxing ponyfill, switch to it for the rest of the session and retry that
 * same frame. On Android the native detector lives in Google Play Services and can be absent, slow to
 * initialise or fail outright; ScanScreen swallows per-frame errors to keep scanning, so the fallback
 * has to live HERE, inside the detector, or a broken native path would scan nothing forever (the
 * 2026-10-01 LinkError taught that). A zxing load failure is rethrown and retried on the next frame.
 */
export function withZxingFallback(
  native: QrDetectorLike,
  loadZxing: () => Promise<QrDetectorLike>,
  log?: (message: string) => void,
): QrDetector {
  let current: QrDetectorLike = native;
  let kind: QrDetectorKind = 'native';
  let loading: Promise<QrDetectorLike> | null = null;
  return {
    get kind(): QrDetectorKind {
      return kind;
    },
    async detect(source: ImageBitmapSource) {
      if (kind === 'native') {
        try {
          return await current.detect(source);
        } catch (e) {
          log?.(`native BarcodeDetector failed (${e instanceof Error ? e.name : String(e)}) — switching to zxing`);
          kind = 'zxing';
        }
      }
      if (current === native) {
        loading ??= loadZxing();
        try {
          current = await loading;
        } catch (e) {
          loading = null; // try the import again on the next frame
          throw e;
        }
      }
      return current.detect(source);
    },
  };
}

/**
 * The detector ScanScreen uses: the platform's own where it decodes QR codes (no WASM download), the
 * self-hosted zxing ponyfill otherwise, with a runtime fallback from the first to the second.
 */
export async function createQrDetector(): Promise<QrDetector> {
  const log = import.meta.env.DEV ? (m: string) => console.debug(`[hushsend] ${m}`) : undefined;
  const native = await nativeQrDetector();
  if (native) {
    log?.('QR: native BarcodeDetector');
    return withZxingFallback(native, createZxingQrDetector, log);
  }
  log?.('QR: zxing ponyfill');
  const zxing = await createZxingQrDetector();
  return { kind: 'zxing', detect: (source) => zxing.detect(source) };
}
