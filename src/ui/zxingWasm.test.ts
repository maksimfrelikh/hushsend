import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as QRCode from 'qrcode';
import { locateZxingWasm, ZXING_READER_WASM_URL } from './zxingWasm';

/**
 * ABI gate — the glue `barcode-detector` inlines and the `.wasm` WE vendor must be the same zxing-wasm
 * build. Found broken on the live site 2026-10-02 (TESTPLAN A2/B3): a dependency refresh moved
 * `barcode-detector` to 3.2.2, whose inlined glue is zxing-wasm 3.1.3 (78 imports), while our direct
 * pin still vendored the 3.1.0 reader (80 imports) — every frame died in `WebAssembly.instantiate`
 * with `LinkError: Import #78 "a" "ya": function import requires a callable`, on desktop Chrome and on a
 * Pixel 5 alike, and nothing in `tsc` / `vite build` / the e2e (which scans through the paste fallback)
 * noticed. This test drives the SAME two artefacts the app ships — the ponyfill's glue and the file the
 * `?url` import resolves to — through a real instantiation and a real decode, so a version drift fails
 * `vitest` instead of production.
 */
describe('zxing WASM ABI gate (the vendored reader matches the bundled glue)', () => {
  it('instantiates the vendored zxing_reader.wasm through barcode-detector and decodes a hushsend link', async () => {
    const require = createRequire(import.meta.url);
    // The exact file the app's `zxing-wasm/reader/zxing_reader.wasm?url` import points at.
    const wasmBinary = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
    const header = Array.from(wasmBinary.subarray(0, 4));
    expect(header).toEqual([0x00, 0x61, 0x73, 0x6d]); // "\0asm" — a real module, not an HTML 404 page

    // Node has no ImageData; the ponyfill's detect() accepts an `instanceof ImageData` carrying
    // data/width/height, so a minimal shim is enough to reach the pixmap decoder.
    if (!('ImageData' in globalThis)) {
      class ImageDataShim {
        constructor(
          public readonly data: Uint8ClampedArray,
          public readonly width: number,
          public readonly height: number,
        ) {}
      }
      (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataShim;
    }
    // ...and the result's `boundingBox` is a DOMRectReadOnly, also DOM-only.
    if (!('DOMRectReadOnly' in globalThis)) {
      class DOMRectReadOnlyShim {
        constructor(
          public readonly x = 0,
          public readonly y = 0,
          public readonly width = 0,
          public readonly height = 0,
        ) {}
        static fromRect(r: { x?: number; y?: number; width?: number; height?: number } = {}): DOMRectReadOnlyShim {
          return new DOMRectReadOnlyShim(r.x, r.y, r.width, r.height);
        }
      }
      (globalThis as unknown as { DOMRectReadOnly: unknown }).DOMRectReadOnly = DOMRectReadOnlyShim;
    }

    const mod = await import('barcode-detector/ponyfill');
    // `wasmBinary` instead of the app's `locateFile`: there is no origin to fetch from in Node, and the
    // bytes are what the ABI check is about.
    mod.setZXingModuleOverrides({ wasmBinary });
    const detector = new mod.BarcodeDetector({ formats: ['qr_code'] });

    // A link of the real shape (22-char token + 16-byte secret, both base64url), rendered the way the
    // app renders its QR: dark modules on a light field, quiet zone, a few pixels per module.
    const link = `https://hushsend.frelikh.dev/#${'A'.repeat(22)}.${'B'.repeat(22)}`;
    const qr = QRCode.create(link, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const scale = 4;
    const quiet = 4;
    const px = (size + 2 * quiet) * scale;
    const data = new Uint8ClampedArray(px * px * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!qr.modules.get(y, x)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
    const ImageDataCtor = (globalThis as unknown as { ImageData: new (d: Uint8ClampedArray, w: number, h: number) => ImageData }).ImageData;
    const codes = await detector.detect(new ImageDataCtor(data, px, px));
    expect(codes.map((c) => c.rawValue)).toContain(link);
  }, 30_000);
});

/**
 * Step-6e self-hosting guard: the QR-scanner WASM must load from OUR origin, never a third-party
 * CDN. We can't drive a real headless scan (which is the only thing that instantiates the WASM), so
 * the unit layer proves the one thing that decides where the bytes come from — the `locateFile`
 * override wired into `createQrDetector`. If `locateZxingWasm` returns a same-origin asset URL (and
 * never jsdelivr/fastly), no `.wasm` request can leak to the CDN at scan time.
 */
describe('zxing WASM self-hosting (locateFile override)', () => {
  it('redirects the reader .wasm to the vendored same-origin asset, not a CDN', () => {
    // Default Emscripten would build `scriptDirectory + path`; the bundled barcode-detector default
    // would point this at fastly.jsdelivr.net. Our override must win.
    const resolved = locateZxingWasm('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/reader/');
    expect(resolved).toBe(ZXING_READER_WASM_URL);
  });

  it('the resolved WASM URL contains no third-party CDN host', () => {
    expect(ZXING_READER_WASM_URL).toBeTruthy();
    expect(ZXING_READER_WASM_URL).not.toMatch(/jsdelivr|fastly|unpkg|cdn/i);
    // Vite emits a fingerprinted .wasm asset; the URL still ends in .wasm.
    expect(ZXING_READER_WASM_URL).toMatch(/\.wasm$/);
  });

  it('passes non-wasm requests through to the loader default (scriptDirectory + path)', () => {
    expect(locateZxingWasm('zxing_reader.js', '/base/')).toBe('/base/zxing_reader.js');
  });
});
