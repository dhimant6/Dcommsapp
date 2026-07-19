import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev: vite serves the SPA on :5173 and proxies API/WS to the gateway on
 * :3000 — same-origin from the browser's perspective, so no CORS and the WS
 * URL can stay relative in client code.
 * Staging: `vite build` → apps/web/dist, served BY the gateway (single origin,
 * no proxy at all). The client code is identical in both.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
