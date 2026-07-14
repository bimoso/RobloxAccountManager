import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Build output goes to frontend/dist, which Tauri's build.frontendDist points to
// (wired in task 1.3). Relative base keeps asset URLs valid inside the Tauri webview.
export default defineConfig({
  plugins: [react()],
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
