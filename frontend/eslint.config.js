import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * The set of page folders under `src/pages/`. Each corresponds to a top-level
 * page whose component tree must be self-contained: a file under `pages/<X>/`
 * may import from shared layers (`components/`, `stores/`, `lib/`, `hooks/`,
 * `types/`) and its own folder, but never from a sibling `pages/<Y>/`
 * (Requirement 1.1, 29.1, 29.2).
 */
const PAGES = [
  'Accounts',
  'Charts',
  'Credits',
  'Generator',
  'Logs',
  'Packages',
  'Settings',
  'Weao',
];

/**
 * One ESLint config block per page that forbids importing from any *other*
 * page folder, whether referenced through the `@/pages/<Y>` alias or a relative
 * `../<Y>` path. Imports from the page's own folder and from the shared layers
 * are left untouched, so cross-page coupling is the only thing that fails lint.
 */
const crossPageImportConfigs = PAGES.map((page) => {
  const others = PAGES.filter((other) => other !== page);
  const patterns = others.flatMap((other) => [
    // `@/pages/<Y>` alias imports (bare and nested).
    `@/pages/${other}`,
    `@/pages/${other}/**`,
    // Relative sibling imports (`../<Y>` and deeper).
    `../${other}`,
    `../${other}/**`,
    // Any other spelling that still resolves through a `pages/<Y>` segment.
    `**/pages/${other}`,
    `**/pages/${other}/**`,
  ]);

  return {
    files: [`src/pages/${page}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: patterns,
              message:
                `Cross-page import: files under pages/${page}/ must not import ` +
                `from another page folder (Requirement 1.1). Move shared code ` +
                `into components/, stores/, lib/, hooks/, or types/.`,
            },
          ],
        },
      ],
    },
  };
});

/**
 * Flat ESLint config for the React_Frontend.
 *
 * Covers TypeScript + React (hooks + fast-refresh) linting, the cross-page
 * import restriction (task 30.1, Requirement 1.1), and the documented-props
 * rule for the Component_Library (task 30.3, Requirement 29.3).
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // Cross-page import restriction: one block per page (see PAGES above).
  ...crossPageImportConfigs,
  {
    // Documented-props rule (Requirement 29.3): every Component_Library
    // component under src/components/ must document its input properties and
    // purpose in source. This enforces the *presence* of TSDoc/JSDoc on:
    //   - each exported prop interface / type alias (the prop contract),
    //   - every property signature within them (each individual prop), and
    //   - the component function declaration itself (its purpose).
    // Components authored with `forwardRef(function C(){})` expose the wrapping
    // const as the public API, so only FunctionDeclarations are required here;
    // the inner FunctionExpression is intentionally left out to avoid redundant
    // duplicate docs. Test files carry no public prop contract and are exempt.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: ['src/components/**/*.{test,spec}.{ts,tsx}'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: { FunctionDeclaration: true },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSPropertySignature',
          ],
        },
      ],
    },
  },
  {
    // Test files run under Node/Vitest globals in addition to the browser.
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
