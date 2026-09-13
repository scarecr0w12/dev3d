import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The office UI is a plain Vite + React app. It talks to the orchestrator over
 * same-origin `/api` and `/ws`, which Vite proxies to the server in dev so the
 * browser never needs to know the orchestrator's real host.
 *
 * ## Pointing it somewhere else
 *
 * The proxy target is read from the environment rather than hardcoded, so someone
 * who starts the orchestrator on a different port does not get a dev server that
 * proxies into nothing with no clue why:
 *
 *   PORT=9000 pnpm dev:web
 *   DEV3D_SERVER_PORT=9000 pnpm dev:web
 *
 * **An exported shell variable is the only way.** This file used to document
 * `apps/web/.env.local` as an alternative, and that never worked: Vite reads
 * `.env` files during config *resolution*, which happens after this module is
 * evaluated, and it only surfaces `VITE_`-prefixed keys to the bundle anyway — so
 * the documented method produced a proxy pointed at the default port and no
 * warning. Reading the files here would mean a second, differently-behaving
 * configuration mechanism for one setting, so the claim is corrected instead.
 */
const serverHost = process.env.DEV3D_SERVER_HOST ?? '127.0.0.1';
const serverPort = process.env.DEV3D_SERVER_PORT ?? process.env.PORT ?? '8787';
const httpTarget = `http://${serverHost}:${serverPort}`;
const wsTarget = `ws://${serverHost}:${serverPort}`;

/**
 * The orchestrator lives in a sibling package, and editing it must not reload the
 * UI — that throws away whatever you were looking at, for a change that cannot
 * affect the browser bundle at all.
 *
 * These are **absolute paths**, not globs. They used to be double-star globs with
 * a literal ".." in them, which chokidar could never match: it tests these against
 * absolute paths, and ".." is not a parent traversal in a glob — so five lines of
 * configuration and their rationale were inert, and every server edit still
 * reloaded the page.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignored = ['apps/server', 'packages/core', 'data', 'workspace', 'workspaces', 'logs'].map((dir) =>
  resolve(repoRoot, dir),
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: httpTarget, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true },
    },
    watch: { ignored },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
