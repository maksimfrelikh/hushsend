import { defineConfig } from 'vite';
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
});
