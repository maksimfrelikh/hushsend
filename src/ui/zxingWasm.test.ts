import { describe, it, expect } from 'vitest';
import { locateZxingWasm, ZXING_READER_WASM_URL } from './zxingWasm';

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
