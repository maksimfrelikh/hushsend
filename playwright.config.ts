import { defineConfig } from '@playwright/test';

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
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    acceptDownloads: true,
    channel: 'chrome',
    launchOptions: {
      // Expose raw loopback host candidates instead of mDNS .local names so two tabs in
      // the same browser reliably connect without any STUN/TURN round-trip.
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  webServer: [
    {
      command: 'node server/signaling-server.js',
      url: 'http://127.0.0.1:8080/health',
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
        PORT: '8080',
        MAX_PER_IP_PER_ROOM: '8',
        TURN_SECRET: 'e2e-turn-shared-secret',
        TURN_URLS: 'turn:turn.example.org:3478?transport=udp',
      },
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { VITE_SIGNALING_URL: 'ws://127.0.0.1:8080' },
    },
  ],
});
