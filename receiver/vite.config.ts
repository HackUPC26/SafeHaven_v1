import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SafeHaven v1 receiver — Vite config.
//
// In dev we proxy the relay WebSocket so the browser talks to a SINGLE origin
// (the Vite dev server) exactly as it will in production, where the relay also
// serves the static bundle. The receiver connects to `/ws?...` (a same-origin
// path); Vite forwards that upgrade to the local relay on :8080.
//
// PROTOCOL §1.3: connect URL is `<ws|wss>://HOST/ws?role=...&token=...&v=1`.
// Same-origin keeps `wss://` clean in prod (no CORS / mixed-content) and means
// the receiver code never hardcodes a host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy the relay socket. `ws: true` upgrades the HTTP request to a
      // WebSocket and pipes frames both ways verbatim.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2021',
    sourcemap: true,
  },
});
