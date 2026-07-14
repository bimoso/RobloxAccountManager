import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Integration test for the Build_Pipeline (Requirement 1.4).
 *
 * Runs the real production build (`npm run build` = `tsc --noEmit && vite build`)
 * over the current, valid React_Frontend source and asserts that:
 *   1. The pipeline finishes with a success exit code (0).
 *   2. The configured `frontendDist` (frontend/dist) contains the generated
 *      static artifacts: `index.html`, the hashed `assets/` bundle, and the
 *      verbatim `preload.js` copied from the Tauri_Bridge (Req 1.3 wiring).
 *
 * Running a full build takes several seconds, so the test timeout is generous.
 * On Windows the npm executable is `npm.cmd`; we invoke through the shell so the
 * correct binary resolves regardless of platform.
 */

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(frontendRoot, 'dist');
const repoRoot = resolve(frontendRoot, '..');

// A full `tsc --noEmit && vite build` can take a while on a cold cache / CI.
const BUILD_TIMEOUT_MS = 180_000;

describe('Build_Pipeline over valid code (Requirement 1.4)', () => {
  it(
    'exits successfully and produces static artifacts in frontend/dist',
    () => {
      const result = spawnSync('npm', ['run', 'build'], {
        cwd: frontendRoot,
        shell: true, // resolves npm/npm.cmd across platforms (Windows-safe)
        encoding: 'utf-8',
        timeout: BUILD_TIMEOUT_MS,
      });

      // 1. Success exit code. On failure, surface stdout/stderr for debugging.
      expect(
        result.status,
        `build did not exit successfully.\nSTDOUT:\n${result.stdout ?? ''}\nSTDERR:\n${result.stderr ?? ''}`,
      ).toBe(0);

      // 2. Artifacts exist in the configured frontendDist (frontend/dist).
      expect(existsSync(distDir), `expected dist directory at ${distDir}`).toBe(true);

      const indexHtml = resolve(distDir, 'index.html');
      expect(existsSync(indexHtml), 'expected dist/index.html').toBe(true);

      const assetsDir = resolve(distDir, 'assets');
      expect(existsSync(assetsDir), 'expected dist/assets bundle directory').toBe(true);
      expect(statSync(assetsDir).isDirectory(), 'dist/assets should be a directory').toBe(true);

      // The assets directory should hold the emitted JS/CSS bundle(s).
      const assetFiles = readdirSync(assetsDir);
      expect(
        assetFiles.length,
        'expected at least one emitted file in dist/assets',
      ).toBeGreaterThan(0);
      expect(
        assetFiles.some((f) => f.endsWith('.js')),
        `expected a JS bundle in dist/assets, found: ${assetFiles.join(', ')}`,
      ).toBe(true);

      // preload.js is copied verbatim from the Tauri_Bridge into the output.
      const preloadJs = resolve(distDir, 'preload.js');
      expect(existsSync(preloadJs), 'expected dist/preload.js (Tauri_Bridge copy)').toBe(true);
      expect(readFileSync(preloadJs, 'utf8').trimStart().startsWith('<')).toBe(false);
      expect(readFileSync(preloadJs)).toEqual(readFileSync(resolve(repoRoot, 'src-tauri', 'preload.js')));

      // The packaged HTML must use the relative bridge path and permit only the
      // exact Discord CDN needed by the Credits avatar.
      const builtIndex = readFileSync(indexHtml, 'utf8');
      expect(builtIndex).toContain('src="./preload.js"');
      expect(builtIndex).toContain('https://cdn.discordapp.com');

      // Prove the current user-supplied Bimo.gif made it through Vite instead
      // of accepting a stale banner left in dist from an older build.
      const sourceBanner = readFileSync(resolve(frontendRoot, 'assets', 'Bimo.gif'));
      const emittedBanner = assetFiles
        .filter((file) => file.toLowerCase().endsWith('.gif'))
        .some((file) => readFileSync(resolve(assetsDir, file)).equals(sourceBanner));
      expect(emittedBanner, 'expected current assets/Bimo.gif in dist/assets').toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );
});
