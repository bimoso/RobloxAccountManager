import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

/**
 * Integration test for the Build_Pipeline error path (Requirement 1.5).
 *
 * Verifies that when a deliberate type error is introduced into the
 * React_Frontend source, the Build_Pipeline (`npm run build` =
 * `tsc --noEmit && vite build`):
 *   (a) stops with a NON-zero exit code,
 *   (b) reports the offending file and line in its output, and
 *   (c) leaves the previously-built `frontend/dist` artifacts intact
 *       (not corrupted or deleted) — because `tsc --noEmit` fails first,
 *       `vite build` never runs and never touches the last good output.
 *
 * The probe file is ALWAYS removed afterwards so the repository is left clean
 * and other builds/tests keep passing.
 *
 * On Windows the npm executable is `npm.cmd`; we invoke through the shell so
 * the correct binary resolves regardless of platform.
 */

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(frontendRoot, 'src');
const distDir = resolve(frontendRoot, 'dist');

// A distinctive name so the failure output is unambiguous and easy to assert on.
const PROBE_BASENAME = '__pipeline_error_probe__.ts';
const probeFile = resolve(srcDir, PROBE_BASENAME);

// A full `tsc --noEmit && vite build` can take a while on a cold cache / CI.
const BUILD_TIMEOUT_MS = 240_000;

/** Runs the production build script and returns its result. */
function runBuild() {
  return spawnSync('npm', ['run', 'build'], {
    cwd: frontendRoot,
    shell: true, // resolves npm/npm.cmd across platforms (Windows-safe)
    encoding: 'utf-8',
    timeout: BUILD_TIMEOUT_MS,
  });
}

/**
 * Snapshots every file under `dir` as a map of POSIX-style relative path ->
 * sha256 hash of its contents. Detects deletions, additions, and corruption.
 */
function snapshotDir(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        const rel = relative(dir, full).split('\\').join('/');
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        snapshot.set(rel, hash);
      }
    }
  };
  walk(dir);
  return snapshot;
}

/** Removes the temporary probe file if it still exists. */
function removeProbe() {
  if (existsSync(probeFile)) {
    rmSync(probeFile, { force: true });
  }
}

// Safety net: guarantee cleanup even if the test throws before its finally block.
afterAll(removeProbe);

describe('Build_Pipeline over code with a type error (Requirement 1.5)', () => {
  it(
    'stops with a non-zero exit, reports file and line, and leaves frontend/dist intact',
    () => {
      // 1. Establish a known-good frontend/dist baseline. If it is missing
      //    (tests may run in isolation), run a real successful build first.
      if (!existsSync(resolve(distDir, 'index.html'))) {
        const baseline = runBuild();
        expect(
          baseline.status,
          `baseline build failed; cannot verify Req 1.5.\nSTDOUT:\n${baseline.stdout ?? ''}\nSTDERR:\n${baseline.stderr ?? ''}`,
        ).toBe(0);
      }
      expect(existsSync(distDir), `expected a baseline dist directory at ${distDir}`).toBe(true);

      // Capture the last successful output so we can prove it is untouched.
      const before = snapshotDir(distDir);
      expect(before.size, 'baseline dist should contain artifacts').toBeGreaterThan(0);

      let result: ReturnType<typeof runBuild>;
      try {
        // 2. Inject a deliberate TYPE error at a known line. `export {}` keeps
        //    the file a module (satisfies isolatedModules); the assignment on
        //    the last line is the offending type error tsc must flag.
        const probeSource = [
          '// Temporary probe injected by build-pipeline-error.test.ts (Req 1.5).',
          '// Deliberately contains a type error to verify the Build_Pipeline halts.',
          'export {};',
          "const brokenValue: number = 'this is definitely not a number';",
          'void brokenValue;',
          '',
        ].join('\n');
        writeFileSync(probeFile, probeSource, 'utf-8');

        // 3. Run the pipeline over the now-broken source.
        result = runBuild();
      } finally {
        // 4. ALWAYS clean up the probe so the repo is left clean.
        removeProbe();
      }

      const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      // (a) The pipeline must NOT succeed.
      expect(
        result.status,
        `expected a non-zero exit code from a type error.\nOUTPUT:\n${combinedOutput}`,
      ).not.toBe(0);

      // (b) The output must name the offending file...
      expect(
        combinedOutput,
        `expected the offending file name in the output.\nOUTPUT:\n${combinedOutput}`,
      ).toContain('__pipeline_error_probe__');

      // ...and report a line number. tsc uses `file.ts(line,col):` (plain) or
      // `file.ts:line:col` (pretty); accept either form.
      expect(
        /__pipeline_error_probe__\.ts[(:]\s*(\d+)/.test(combinedOutput),
        `expected a line number for the error in the output.\nOUTPUT:\n${combinedOutput}`,
      ).toBe(true);

      // (c) The previously-built dist must be byte-for-byte unchanged: `tsc`
      //     fails before `vite build` runs, so nothing is deleted or corrupted.
      const after = snapshotDir(distDir);
      expect(
        after.size,
        'no dist artifacts should have been added or removed',
      ).toBe(before.size);
      for (const [rel, hash] of before) {
        expect(after.get(rel), `dist artifact missing after failed build: ${rel}`).toBe(hash);
      }

      // Final guarantee: the probe file is gone.
      expect(existsSync(probeFile), 'probe file should be removed after the test').toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});
