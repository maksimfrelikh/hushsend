import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Camera (QR) and parts of Web Crypto require a secure context. localhost is
    // already a secure context; when testing on a phone over a LAN IP you'll want
    // HTTPS in dev — uncomment `https` then (or use @vitejs/plugin-basic-ssl).
    // https: true,
    host: true,
  },
  test: {
    // The Playwright suite under tests/e2e is driven by `npm run test:e2e`, not
    // Vitest; excluding it keeps a bare `vitest run` from collecting *.spec.ts
    // files that use Playwright's runner APIs.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
