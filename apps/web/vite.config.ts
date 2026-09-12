import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The office UI is a plain Vite + React app. It talks to the orchestrator over
 * same-origin `/api` and `/ws`, which Vite proxies to the server in dev so the
 * browser never needs to know the orchestrator's real host.
 *
 * The proxy target is read from the environment rather than hardcoded. The
 * orchestrator's bind address is `HOST`/`PORT`, so someone who starts it on a
 * different port would otherwise get a dev server that proxies into nothing -
 * with no clue why. Vite loads `apps/web/.env` and `.env.local`, and inherits
 * anything already exported, so either works:
 *
 *   PORT=9000 pnpm dev:web
 *   echo 'DEV3D_SERVER_PORT=9000' > apps/web/.env.local
 */
const serverHost = process.env.DEV3D_SERVER_HOST ?? '127.0.0.1';
const serverPort = process.env.DEV3D_SERVER_PORT ?? process.env.PORT ?? '8787';
const httpTarget = `http://${serverHost}:${serverPort}`;
const wsTarget = `ws://${serverHost}:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: httpTarget, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true },
    },
    watch: {
      // The orchestrator lives in a sibling package. Without this, editing a
      // server file triggers a full page reload of the UI - which throws away
      // whatever you were looking at, for a change that cannot affect the
      // browser bundle at all.
      ignored: ['**/../../apps/server/**', '**/../../packages/core/**', '**/../../data/**', '**/../../workspace/**', '**/../../workspaces/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
