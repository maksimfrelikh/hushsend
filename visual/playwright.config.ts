import { defineConfig } from '@playwright/test';

/* ============================================================
   hushsend — visual regression gate (modelled on frelikh/visual)
   ------------------------------------------------------------
   Every screen state × both themes × 375 / 680 / 1440, plus the
   resolved value of every design token, plus the geometry of the
   controls. Baselines are committed; a diff means a screen moved,
   never that the baseline is wrong — re-record only with a
   reviewed reason:

     npm run visual            # compare against committed baselines
     npm run visual:update     # re-record

   Runs against the Vite DEV server: main.tsx exposes the store on
   `window` in DEV only, and that is how visual/scenes.ts drives
   each state without a peer. Both playwright default ports are
   live services on the deploy host, so this server binds its own.

   Determinism: the two webfonts are bundled (document.fonts.ready
   is awaited), reduced motion is forced (the kit zeroes every
   duration), the SAS picker's CSPRNG is seeded (scenes.ts), single
   worker.
   ============================================================ */

const PORT = Number(process.env.VISUAL_PORT ?? 5293);

export default defineConfig({
  testDir: '.',
  outputDir: './.results',
  snapshotPathTemplate: '{testDir}/baseline/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? 'github'
    : [['list'], ['html', { outputFolder: './.report', open: 'never' }]],
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Font rasterisation differs by a hair across machines; a handful of pixels is noise, a moved
      // border is not. Keep this tight — the whole point of the gate is catching small shifts.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // No signaling server is running for this gate; the scenes never open a socket.
    env: { VITE_SIGNALING_URL: 'ws://127.0.0.1:9', VITE_STUN_URLS: '' },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', viewport: { width: 375, height: 812 } } },
  ],
});
