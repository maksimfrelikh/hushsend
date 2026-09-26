import { defineConfig, devices } from '@playwright/test';

/* ============================================================
   hushsend — accessibility gate (modelled on frelikh/tests/a11y.spec.ts)
   ------------------------------------------------------------
   axe-core over every screen state in both themes, plus the
   keyboard contracts axe cannot see (the word listbox, the phrase
   cards, the mode radios, the disclosure rows).

     npm run test:a11y

   Runs against the Vite DEV server like the visual gate (the
   scenes drive the store through DEV-only window hooks). Two
   projects: a desktop Chromium (pointer: inline word completion)
   and a phone profile (touch: the word LISTBOX renders — the only
   place its keyboard contract can be checked).
   ============================================================ */

const PORT = Number(process.env.A11Y_PORT ?? 5294);

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 5'], browserName: 'chromium' } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { VITE_SIGNALING_URL: 'ws://127.0.0.1:9', VITE_STUN_URLS: '' },
  },
});
