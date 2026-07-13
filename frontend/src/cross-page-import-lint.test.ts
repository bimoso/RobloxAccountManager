import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Unit test for the cross-page import ESLint rule (Requirement 1.1, task 30.1).
 *
 * Requirement 1.1 forbids the source of one navigation page from importing
 * directly from the source of another page. Task 30.1 enforces this with a
 * per-page `no-restricted-imports` block in `frontend/eslint.config.js`. This
 * test proves that guard actually bites: a deliberately introduced cross-page
 * import must fail the lint check with a `no-restricted-imports` error, while a
 * compliant import from a shared layer (`components/`) must not.
 *
 * The source is linted entirely in memory via ESLint's Node API (`lintText`
 * with a `filePath`), so the per-page config block matches by glob without any
 * file being written to disk — nothing to clean up. `cwd` is pinned to the
 * frontend root so the project's flat config (`eslint.config.js`) is the one
 * being exercised, not some ambient config.
 */

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One shared ESLint instance pinned to the real project config.
const eslint = new ESLint({ cwd: frontendRoot });

/**
 * Lints `code` as if it lived at `relPath` (relative to the frontend root) and
 * returns the flattened list of lint messages produced for it.
 */
async function lintAsPageFile(
  relPath: string,
  code: string,
): Promise<Linter.LintMessage[]> {
  const filePath = resolve(frontendRoot, relPath);
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((result) => result.messages);
}

/** True when any message came from the `no-restricted-imports` rule. */
function hasRestrictedImportError(messages: Linter.LintMessage[]): boolean {
  return messages.some((message) => message.ruleId === 'no-restricted-imports');
}

describe('Cross-page import ESLint rule (Requirement 1.1)', () => {
  it('flags a `@/pages/<other>` alias import from a sibling page', async () => {
    // A file living under pages/Logs/ reaching into pages/Charts/.
    const code = [
      "import { something } from '@/pages/Charts/index';",
      'export const usesIt = something;',
      '',
    ].join('\n');

    const messages = await lintAsPageFile('src/pages/Logs/violation.tsx', code);

    expect(
      hasRestrictedImportError(messages),
      `expected a no-restricted-imports error for an @/pages/Charts import.\n` +
        `messages: ${JSON.stringify(messages, null, 2)}`,
    ).toBe(true);
  });

  it('flags a relative `../<other>` import from a sibling page', async () => {
    // The same violation expressed as a relative sibling path.
    const code = [
      "import { something } from '../Charts/index';",
      'export const usesIt = something;',
      '',
    ].join('\n');

    const messages = await lintAsPageFile('src/pages/Logs/violation.tsx', code);

    expect(
      hasRestrictedImportError(messages),
      `expected a no-restricted-imports error for a ../Charts import.\n` +
        `messages: ${JSON.stringify(messages, null, 2)}`,
    ).toBe(true);
  });

  it('does not flag a compliant import from a shared layer (components/)', async () => {
    // Importing from a shared layer is exactly what the rule permits.
    const code = [
      "import { Button } from '@/components/Button';",
      'export const usesIt = Button;',
      '',
    ].join('\n');

    const messages = await lintAsPageFile('src/pages/Logs/compliant.tsx', code);

    expect(
      hasRestrictedImportError(messages),
      `a shared-layer import must not trigger no-restricted-imports.\n` +
        `messages: ${JSON.stringify(messages, null, 2)}`,
    ).toBe(false);
  });

  it('does not flag an import from the page\'s own folder', async () => {
    // Same-page imports stay allowed; only cross-page coupling is forbidden.
    const code = [
      "import { helper } from './helper';",
      'export const usesIt = helper;',
      '',
    ].join('\n');

    const messages = await lintAsPageFile('src/pages/Logs/index.tsx', code);

    expect(
      hasRestrictedImportError(messages),
      `an own-folder import must not trigger no-restricted-imports.\n` +
        `messages: ${JSON.stringify(messages, null, 2)}`,
    ).toBe(false);
  });
});
