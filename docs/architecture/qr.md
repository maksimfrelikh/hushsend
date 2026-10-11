# QR (built — step 5b; WASM self-hosted — step 6e)

Part of the architecture reference — [README.md](README.md) is the index.

`barcode-detector` + `qrcode` are installed. Generation: `qrcode` → an SVG QR rendered locally
(`src/ui/qr.ts`, dark-on-light so it scans in either theme). Scanning: `getUserMedia` for the
camera + a detector chosen at scan time (`createQrDetector`, since 2026-10-03 — owner's decision: no WASM
download where the platform decodes QR itself): the browser's own **native `BarcodeDetector`** where it
exists and lists `qr_code` (Chrome on the desktop and on Android), the **`barcode-detector` ponyfill** (the
self-hosted zxing-wasm decoder) everywhere else (iOS Safari, Firefox) — the ponyfill never delegates to a
native detector itself, so the choice is ours (measured 2026-09-27). **Runtime fallback inside the detector**
(`withZxingFallback`): the first native `detect()` that THROWS (an empty frame is not a throw) loads the
ponyfill, switches to it for the session and retries that frame — on Android the native detector lives in
Google Play Services and can be absent or broken, and ScanScreen swallows per-frame errors, so the fallback
cannot live there. The ponyfill is **lazily imported**: its WASM never loads unless a scan needs it. Unit:
`zxingWasm.test.ts` (the choice + the fallback with fakes, next to the ABI gate). **Verified live** (`b73651d`, Chrome
154, fake camera): native detector, connected 1.1 s after the scan tap, no ponyfill chunk and no `.wasm`
requested; with `BarcodeDetector` hidden the ponyfill + the self-hosted `.wasm` loaded and it connected the same. The
owner then scanned by hand on the Pixel 5 and the iPhone 15: works on both (which decoder ran on the Pixel
was not observed). Camera denial/absence falls back to a paste-the-link
input (`src/ui/screens/ScanScreen.tsx`).
- **Self-hosted WASM (no CDN — step 6e):** the zxing reader `.wasm` (the decoder on every engine)
  is **vendored into the build** and served from our OWN origin — it is NEVER fetched
  from a third-party CDN. `barcode-detector@3.2.0`'s default Emscripten `locateFile` would pull
  `zxing_reader.wasm` from `fastly.jsdelivr.net` at scan time (leaking the client IP + executing
  WASM from a host we don't control — a privacy + supply-chain risk). `src/ui/zxingWasm.ts`
  (`createQrDetector`) overrides it: it `import`s the `.wasm` as a Vite **`?url` asset**
  (`zxing-wasm/reader/zxing_reader.wasm?url` → fingerprinted into `dist/assets/`, same-origin) and
  calls `setZXingModuleOverrides({ locateFile })` to point the loader at that asset **before** the
  detector instantiates. Lazy loading is preserved (only the URL string is in the bundle; the
  ponyfill JS + WASM still load only on a real scan, now from `'self'`). **`zxing-wasm@3.1.3`** is pinned
  as a direct dep (exact, matching the copy `barcode-detector@3.2.2` inlines — since 2026-10-02; it was
  3.1.0 / 3.2.0 before) so the import resolves independent of hoisting. `zxingWasm.test.ts` tests the
  wired `locateFile` (resolves to a same-origin asset, never jsdelivr/fastly) AND, since 2026-10-02, is
  the **ABI gate**: it instantiates the ponyfill's glue with the vendored `zxing_reader.wasm` in Node and
  decodes a real hushsend-link QR, so a glue/wasm version drift fails `vitest` instead of production. ScanScreen calls `createQrDetector()` instead of
  constructing the ponyfill detector directly. **CSP consequence:** `connect-src` no longer lists any
  CDN (see [DEPLOY.md](../../deploy/DEPLOY.md)).
- **⚠️ Version-coupling — re-check the `zxing-wasm` pin on every `barcode-detector` bump. THIS BIT ON
  2026-10-01:** a dependency refresh (`c5f6e94`) moved `barcode-detector` to 3.2.2 within its `^` range —
  glue zxing-wasm 3.1.3, 78 imports — while the exact pin kept vendoring the 3.1.0 reader (80 imports);
  the live site's scanner then died on every frame with `LinkError: Import #78 "a" "ya": function import
  requires a callable`, swallowed by ScanScreen's per-frame `catch`, on desktop Chrome and on a Pixel 5
  alike, with `tsc` / `vite build` / the e2e all green (found by the 2026-10-02 handset pass, TESTPLAN
  A2/B3). The vitest ABI gate above now catches it; the rule still stands. Our direct
  `zxing-wasm` pin MUST stay equal to the version `barcode-detector` inlines internally: at scan
  time the ponyfill's JS expects a `zxing_reader.wasm` whose ABI matches ITS inlined copy, but
  `locateFile` now points the loader at OUR vendored asset. If a future `barcode-detector` upgrade
  silently inlines a DIFFERENT zxing-wasm version, our vendored `.wasm` would be ABI-mismatched against
  the loader JS → QR scanning breaks **at runtime on every engine** (the `.wasm` import still
  resolves and the build still passes — the mismatch is invisible to `tsc`/`vite build`; no native
  `BarcodeDetector` path masks it, since the ponyfill never takes one). So when bumping `barcode-detector`, re-verify
  the exact zxing-wasm version it inlines (e.g. inspect its `package.json`/lockfile entry) and move our
  direct `zxing-wasm` pin to match in the SAME pass, then re-run `zxingWasm.test.ts` and a real
  non-Chromium scan. Keep both pins EXACT (no `^`/`~`).
