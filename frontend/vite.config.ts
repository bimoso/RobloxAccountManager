import { fileURLToPath, URL } from 'node:url';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Absolute path to the canonical, UNMODIFIED Tauri_Bridge preload script.
// `src-tauri/preload.js` is loaded as a classic script (Tauri injects globals via
// `app.withGlobalTauri = true`) and must be shipped verbatim alongside the
// React bundle so `window.api` keeps working. It stays the single source of
// truth beside the Tauri backend — we never edit or fork its contents (Req 1.3).
const preloadSource = fileURLToPath(new URL('../src-tauri/preload.js', import.meta.url));

/**
 * Copies `src-tauri/preload.js` unmodified into the Vite build output (`frontend/dist`)
 * and serves it at `/preload.js` during dev, so `frontend/index.html` can load it
 * as a classic script exactly like the Legacy_Frontend did (Requirement 1.3).
 */
function copyPreloadPlugin(): Plugin {
  return {
    name: 'copy-tauri-preload',
    apply: () => true,
    // Dev: serve /preload.js straight from the canonical source file.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.split('?')[0] === '/preload.js' && existsSync(preloadSource)) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(readFileSync(preloadSource));
          return;
        }
        next();
      });
    },
    // Build: copy the source verbatim after Vite has written/emptied dist.
    // `writeBundle` keeps the bridge inside the same deterministic output
    // transaction as index.html and the hashed assets; a later stale cargo-only
    // package can no longer observe an HTML shell without its classic script.
    writeBundle() {
      if (!existsSync(preloadSource)) {
        this.error(`Tauri_Bridge preload not found at ${preloadSource}; cannot assemble frontend/dist.`);
      }
      const dest = resolve(dirname(fileURLToPath(import.meta.url)), 'dist', 'preload.js');
      copyFileSync(preloadSource, dest);
      this.info?.(`copied Tauri_Bridge preload verbatim: ${preloadSource} -> ${dest}`);
    },
  };
}

// Build output goes to frontend/dist, which Tauri's build.frontendDist points to
// (wired in task 1.3). Relative base keeps asset URLs valid inside the Tauri webview.
export default defineConfig({
  plugins: [react(), copyPreloadPlugin()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // jsdom lets component tests (@testing-library/react) render into a DOM.
    environment: 'jsdom',
    globals: true,
    // Registers jest-dom matchers and cleanup after each test.
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The Build_Pipeline integration tests (build-pipeline*.test.ts) each spawn a
    // real `npm run build` over the shared src/ and dist/ directories. Running
    // test files in parallel would let one build observe another's transient
    // state (e.g. the deliberate type-error probe from the Req 1.5 test),
    // producing spurious failures. Serialize files so these builds never overlap.
    fileParallelism: false,
  },
});
