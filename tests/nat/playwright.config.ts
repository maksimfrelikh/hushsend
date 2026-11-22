import { defineConfig } from '@playwright/test';

/**
 * The NAT suite (nat.spec.ts): two Chromiums in two network namespaces behind two NAT routers.
 *
 *   sudo env "PATH=$PATH" bash tests/nat/run.sh        # Linux only — builds, raises the lab, runs
 *
 * No `webServer` and no `baseURL` here on purpose: the servers run inside the lab's namespaces
 * (tests/nat/net/up.sh), and each browser reaches them through its own NAT. One worker — the
 * cases reconfigure the same two routers. CI: .github/workflows/nat.yml, nightly and on demand.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /nat\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // `github` turns a failed assertion into an annotation, readable without the job log.
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: '../../test-results/nat',
});
