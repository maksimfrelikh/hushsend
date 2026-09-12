import { defineConfig, devices } from '@playwright/test';
import { CHROME_CHANNEL, CHROME_PATH } from './tests/e2e/helpers';

/**
 * E2E for step-2 file transfer. Drives two tabs in one real Chromium through the
 * no-crypto "room" rendezvous, then transfers files over the live DataChannel.
 *
 * Uses the system Chrome (channel: 'chrome') so no browser binary download is needed.
 * Two web servers are managed for us:
 *   - the signaling server on 127.0.0.1:8080 (pure rendezvous; NODE_ENV=development so
 *     the localhost:5173 dev origin is allowed),
 *   - the Vite dev server on localhost:5173 (origin the signaling server trusts in dev).
 * The client is pointed at ws://127.0.0.1:8080 to avoid Windows localhost→::1 surprises.
 */
// The SIGNALING port is overridable so the suite can run on a host that ALREADY serves hushsend: the
// production signaling server owns 127.0.0.1:8080 there, and `reuseExistingServer` would silently
// attach the tests to it (NODE_ENV=production rejects the dev origin, and the run would pollute a live
// server). Default is the historical one, so a plain `npx playwright test` is unchanged:
//   E2E_SIGNALING_PORT=8081 npx playwright test
// Moving the VITE port requires telling the signaling server about it too: its dev origin allowlist
// defaults to `http://localhost:5173` (signaling-server.js `devOrigins`), so an app served anywhere
// else gets every socket closed with 4003 'origin not allowed'. DEV_ORIGINS below keeps the two in
// step, so both knobs can move together:
//   E2E_SIGNALING_PORT=8081 E2E_VITE_PORT=5175 npx playwright test
const SIGNALING_PORT = process.env.E2E_SIGNALING_PORT ?? '8080';
const VITE_PORT = process.env.E2E_VITE_PORT ?? '5173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    acceptDownloads: true,
  },
  // Two projects, because `use.channel` / `use.launchOptions` are applied by the runner even to
  // browsers a test launches ITSELF — a Chromium channel leaking into `firefox.launch()` fails with
  // `Unsupported firefox channel "chrome"`. So the Chromium-only options live on the project that
  // needs them, and the cross-engine spec runs in a project that sets none.
  projects: [
    {
      name: 'chromium',
      testIgnore: [/interop\.spec\.ts/, /mobile\.spec\.ts/],
      use: {
        // Chrome by default; E2E_CHROME_PATH / E2E_CHROME_CHANNEL redirect it (see helpers).
        ...(CHROME_CHANNEL ? { channel: CHROME_CHANNEL } : {}),
        launchOptions: {
          ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
          // Expose raw loopback host candidates instead of mDNS .local names so two tabs in
          // the same browser reliably connect without any STUN/TURN round-trip.
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
      },
    },
    {
      // The SAME suite under Gecko. Everything Chromium never exercises lives here: a different
      // WebRTC stack, IndexedDB/Web Locks under another engine, and whichever half of the
      // WebCrypto-Ed25519-vs-noble fork this engine takes (src/core/crypto/identity.ts).
      name: 'firefox',
      testIgnore: [/interop\.spec\.ts/, /mobile\.spec\.ts/],
      use: {
        browserName: 'firefox',
        launchOptions: {
          // Same purpose as the Chromium mDNS flag: two tabs on one host must exchange usable host
          // candidates, and .local names need an mDNS responder a headless box has no reason to run.
          firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false },
        },
      },
    },
    {
      // The same suite under WebKit. The closest proxy available off-device for Safari — NOT the
      // same thing (WebKitGTK on Linux), but it catches engine-level breakage before a phone does.
      name: 'webkit',
      testIgnore: [/interop\.spec\.ts/, /mobile\.spec\.ts/],
      use: { browserName: 'webkit' },
    },
    {
      // The PHONE profile: WebKit wearing an iPhone's User-Agent, viewport and touch. That UA is what
      // selects the mobile receive ceiling (512 MB) over the desktop gigabyte, so this is the only
      // project where that branch runs at all. Needs E2E_STUN_URLS on a host without mDNS, like the
      // plain webkit project.
      name: 'mobile-webkit',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['iPhone 13'], browserName: 'webkit' },
    },
    {
      // Cross-engine interop: the spec launches its own browsers (one per side) with per-engine
      // options, so this project must not impose a channel or Chromium flags on them.
      name: 'interop',
      testMatch: /interop\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // `server/` is its OWN npm package (it depends on `ws`), and the root `npm ci` does not touch
      // it — so a fresh clone fails here with a bare ERR_MODULE_NOT_FOUND from a WebServer process,
      // which reads like a broken repo rather than a missing install. Install it on demand, once:
      // the guard keeps the cost at a single `existsSync` on every later run.
      command:
        "node -e \"require('fs').existsSync('server/node_modules/ws')||require('child_process').execSync('npm --prefix server ci --omit=dev',{stdio:'inherit'})\" && node server/signaling-server.js",
      url: `http://127.0.0.1:${SIGNALING_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // All Playwright tabs share the loopback IP (no TRUST_PROXY here). The per-IP-per-room anti-squat
      // cap now DEFAULTS to the room cap (8), so 3 same-IP lobby tabs already fit; we pin it to 8
      // explicitly so this test stays robust to a future default change. Server CODE/defaults are
      // unchanged; this is purely the test environment, mirroring how the integration suite passes caps.
      //
      // TURN_SECRET + TURN_URLS configure the coturn-credential minting so the Reliable-mode e2e
      // (privacy.spec) can fetch real creds via `turn-request` and assert the client built the TURN
      // iceServer correctly. The URL is a placeholder host — we never run an actual relay (Max-privacy
      // and even Reliable connect over loopback host candidates); we only verify cred assembly.
      env: {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: SIGNALING_PORT,
        MAX_PER_IP_PER_ROOM: '8',
        TURN_SECRET: 'e2e-turn-shared-secret',
        TURN_URLS: 'turn:turn.example.org:3478?transport=udp',
        // Keep the dev origin allowlist in step with wherever Vite is actually served (above).
        DEV_ORIGINS: `http://localhost:${VITE_PORT}`,
      },
    },
    {
      command: `npx vite --port ${VITE_PORT} --strictPort`,
      url: `http://localhost:${VITE_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_SIGNALING_URL: `ws://127.0.0.1:${SIGNALING_PORT}`,
        // STUN is normally OFF in tests (two loopback tabs pair on host candidates). WEBKIT NEEDS IT
        // on a headless host: it has no switch to disable mDNS obfuscation (Chromium has the flag,
        // Firefox the pref), so it only ever emits `<uuid>.local` host candidates — unresolvable
        // without an mDNS responder, which a server has no reason to run. One STUN server gives it a
        // usable srflx candidate instead; a loopback STUN keeps the whole thing on this machine.
        // Measured on the deploy box: chrome/firefox emit 192.168.x.y, webkit emits <uuid>.local.
        VITE_STUN_URLS: process.env.E2E_STUN_URLS ?? '',
      },
    },
  ],
});
