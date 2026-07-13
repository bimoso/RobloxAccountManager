import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Security regression guard for the React_Frontend migration (Requirement 28.2).
 *
 * Req 28.2: the React_Frontend SHALL use the Content-Security-Policy defined in
 * `src-tauri/tauri.conf.json` WITHOUT adding directives that reduce the security
 * restrictions in force in the Legacy_Frontend. In other words, the migration
 * must never *weaken* the CSP.
 *
 * This test pins the exact Legacy_Frontend baseline for the Tauri-level CSP field
 * (`app.security.csp`) as it was committed, and fails if that field is ever changed
 * to a value that is *less restrictive* than the baseline (e.g. removed to
 * `undefined`, or broadened with `unsafe-*` / wildcard sources that the baseline
 * did not allow).
 *
 * IMPORTANT baseline note (verified against the committed sources):
 *   - `src-tauri/tauri.conf.json` sets `app.security.csp` to `null`. With Tauri,
 *     `null` disables Tauri's own CSP header injection; the Legacy_Frontend instead
 *     enforced its policy through a `<meta http-equiv="Content-Security-Policy">`
 *     tag in `src/index.html`. That exact policy is reproduced below as
 *     `LEGACY_FRONTEND_META_CSP` for documentation and as the reference point for
 *     the "no less restrictive" comparison, should the config CSP ever be
 *     populated in the future.
 *
 * The test reads the real `src-tauri/tauri.conf.json` (resolved relative to this
 * file, at the repo root) so it always reflects the shipped configuration.
 *
 * Validates: Requirements 28.2
 */

// frontend/src/tauri-csp.test.ts -> ../../ is the repo root -> src-tauri/tauri.conf.json
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriConfPath = resolve(repoRoot, 'src-tauri', 'tauri.conf.json');

/**
 * The exact `app.security.csp` value committed for the Legacy_Frontend.
 * Tauri treats `null` as "do not inject a CSP header" (policy delegated to the
 * page's own <meta> tag). This is the value the test asserts remains unchanged.
 */
const LEGACY_FRONTEND_TAURI_CSP: string | null = null;

/**
 * The verbatim Content-Security-Policy the Legacy_Frontend enforced via the
 * `<meta http-equiv="Content-Security-Policy">` tag in `src/index.html`. Kept
 * here as the authoritative, documented baseline of "restrictions in force"
 * (Req 28.2). If `app.security.csp` is ever populated, it must be *at least as
 * restrictive* as this policy.
 */
const LEGACY_FRONTEND_META_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https://*.rbxcdn.com https://*.roblox.com; " +
  "connect-src 'self' ipc: http://ipc.localhost https://*.roblox.com https://core.bloxgen.net; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-src 'none'";

type TauriConf = {
  app?: {
    security?: {
      csp?: string | null;
    };
  };
  // Older Tauri (v1) schema used a top-level `tauri.security.csp`. We inspect
  // both key paths so the test is robust to a schema bump, but assert on the
  // one the shipped config actually uses.
  tauri?: {
    security?: {
      csp?: string | null;
    };
  };
};

/** Reads and parses the shipped Tauri configuration from disk. */
function readTauriConf(): TauriConf {
  const raw = readFileSync(tauriConfPath, 'utf-8');
  return JSON.parse(raw) as TauriConf;
}

/**
 * Splits a CSP string into a directive -> source-set map. Directive names are
 * lower-cased; sources keep their original case (case matters for host names).
 */
function parseCsp(csp: string): Map<string, Set<string>> {
  const directives = new Map<string, Set<string>>();
  for (const segment of csp.split(';')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    directives.set(name, new Set(tokens.slice(1)));
  }
  return directives;
}

/** Overtly dangerous source expressions that broaden (weaken) a policy. */
const WEAKENING_SOURCES = new Set(["'unsafe-eval'", '*', 'data:', 'blob:', 'https:', 'http:', "'unsafe-inline'"]);

/**
 * Returns the list of ways in which `candidate` is *less restrictive* than
 * `baseline`. An empty list means `candidate` is no less restrictive (i.e. it is
 * equal to or stronger than the baseline) — which is what Req 28.2 requires.
 *
 * A candidate is considered weaker if it:
 *   - drops a directive the baseline defined (removing a restriction), or
 *   - adds a source to a directive that the baseline did not allow, or
 *   - introduces an overtly weakening source (`unsafe-eval`, `*`, scheme wildcards)
 *     that the baseline did not already contain.
 */
function findWeakenings(baseline: string, candidate: string): string[] {
  const base = parseCsp(baseline);
  const cand = parseCsp(candidate);
  const problems: string[] = [];

  for (const [directive, baseSources] of base) {
    if (!cand.has(directive)) {
      problems.push(`directive "${directive}" was removed`);
      continue;
    }
    const candSources = cand.get(directive)!;
    for (const source of candSources) {
      if (!baseSources.has(source)) {
        const detail = WEAKENING_SOURCES.has(source) ? ' (overtly weakening)' : '';
        problems.push(`directive "${directive}" gained source "${source}"${detail}`);
      }
    }
  }

  // A newly added directive that opens something up (e.g. adding a permissive
  // "child-src *" that the baseline never had) with a weakening source.
  for (const [directive, candSources] of cand) {
    if (base.has(directive)) continue;
    for (const source of candSources) {
      if (WEAKENING_SOURCES.has(source)) {
        problems.push(`new directive "${directive}" allows overtly weakening source "${source}"`);
      }
    }
  }

  return problems;
}

describe('Tauri security CSP is not weakened by the React_Frontend migration (Requirement 28.2)', () => {
  it('keeps app.security.csp exactly at the committed Legacy_Frontend baseline', () => {
    const conf = readTauriConf();

    // The shipped config uses the Tauri v2 schema: app.security.csp.
    expect(conf.app, 'tauri.conf.json is missing the "app" section').toBeDefined();
    expect(conf.app?.security, 'tauri.conf.json is missing "app.security"').toBeDefined();

    const security = conf.app!.security!;

    // The `csp` key must still be present (not silently dropped to undefined).
    expect(
      Object.prototype.hasOwnProperty.call(security, 'csp'),
      'app.security.csp key was removed; the CSP field must remain explicit (Req 28.2)',
    ).toBe(true);

    // And its value must equal the exact Legacy_Frontend baseline.
    expect(
      security.csp,
      `app.security.csp changed from the Legacy_Frontend baseline (${JSON.stringify(LEGACY_FRONTEND_TAURI_CSP)}). ` +
        'Req 28.2 forbids weakening the CSP; update this baseline only after a security review.',
    ).toStrictEqual(LEGACY_FRONTEND_TAURI_CSP);
  });

  it('does not define the CSP via the removed v1 tauri.security.csp path', () => {
    const conf = readTauriConf();
    // Guard against the CSP quietly moving to the legacy v1 location where this
    // and other tooling would stop tracking it.
    expect(
      conf.tauri?.security?.csp,
      'CSP found under the v1 "tauri.security.csp" path; it must live under "app.security.csp"',
    ).toBeUndefined();
  });

  it('is no less restrictive than the Legacy_Frontend policy when a CSP string is present', () => {
    const conf = readTauriConf();
    const csp = conf.app?.security?.csp;

    if (typeof csp !== 'string') {
      // Baseline case: config CSP is null, delegating enforcement to the page's
      // <meta> policy exactly as the Legacy_Frontend did. Nothing to compare, and
      // `null` cannot be "less restrictive" than the meta baseline on its own.
      expect(csp).toStrictEqual(LEGACY_FRONTEND_TAURI_CSP);
      return;
    }

    // If someone populates the Tauri CSP, it must be at least as strict as the
    // Legacy_Frontend meta policy — no dropped directives, no broadened sources.
    const weakenings = findWeakenings(LEGACY_FRONTEND_META_CSP, csp);
    expect(
      weakenings,
      `app.security.csp is less restrictive than the Legacy_Frontend policy (Req 28.2):\n - ${weakenings.join('\n - ')}`,
    ).toEqual([]);
  });

  it('detects weakening relative to a baseline (comparator self-check)', () => {
    // Same policy: no weakening.
    expect(findWeakenings(LEGACY_FRONTEND_META_CSP, LEGACY_FRONTEND_META_CSP)).toEqual([]);

    // Broadening a directive with a wildcard is flagged.
    const broadened = LEGACY_FRONTEND_META_CSP.replace("default-src 'self'", "default-src 'self' *");
    expect(findWeakenings(LEGACY_FRONTEND_META_CSP, broadened)).toContain(
      'directive "default-src" gained source "*" (overtly weakening)',
    );

    // Dropping a directive (removing a restriction) is flagged.
    const dropped = LEGACY_FRONTEND_META_CSP.replace("; object-src 'none'", '');
    expect(findWeakenings(LEGACY_FRONTEND_META_CSP, dropped)).toContain('directive "object-src" was removed');

    // Adding unsafe-eval is flagged.
    const unsafeEval = LEGACY_FRONTEND_META_CSP.replace(
      "script-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(findWeakenings(LEGACY_FRONTEND_META_CSP, unsafeEval)).toContain(
      'directive "script-src" gained source "\'unsafe-eval\'" (overtly weakening)',
    );
  });
});
