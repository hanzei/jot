import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import react from 'eslint-plugin-react';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

// The TypeScript baseline, shared by the app and the e2e suite so the two
// cannot drift apart. Everything React lives in the app block below; e2e adds
// nothing but a narrower no-unused-vars.
const tsRules = {
  ...js.configs.recommended.rules,
  ...tseslint.configs.recommended.rules,
  'no-undef': 'off', // TypeScript handles this
};

export default [
  {
    ignores: ['dist/**', 'build/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['vite.config.ts', 'playwright.config.ts', 'scripts/**/*.ts', 'e2e/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parser: tsparser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react,
    },
    rules: {
      ...tsRules,
      ...reactHooks.configs.recommended.rules,
      ...react.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'react/react-in-jsx-scope': 'off', // Not needed with React 17+ JSX transform
      'react/jsx-uses-react': 'off', // Paired with react-in-jsx-scope
      'react/prop-types': 'off', // TypeScript interfaces handle prop types
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['vite.config.ts', 'playwright.config.ts', 'scripts/**/*.ts'],
    languageOptions: {
      sourceType: 'module',
      parser: tsparser,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
    },
  },
  {
    files: ['eslint.config.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  // The e2e suite gets the same `tsRules` as the app above. The two deltas:
  //
  //  - No React plugins. Playwright's fixture signature is
  //    `async ({ page }, use) => { await use(value) }`, and react-hooks reads
  //    that `use(...)` as React 19's `use()` hook called outside a component —
  //    six errors in fixtures/index.ts alone, none of them fixable in code,
  //    since the parameter name is Playwright's API rather than ours.
  //  - `argsIgnorePattern` for no-unused-vars. Page objects keep parameters
  //    they no longer use so their call signature stays steady (`createNote`
  //    still takes the content its list-note path rejects), and mark them with
  //    a `_` prefix. Same setting mobile's config already uses.
  //
  // Globals cover both environments because these files span both: Node for
  // the test process, browser for the callbacks `page.evaluate` ships into the
  // page. `no-undef` is off via `tsRules`, so this documents the two contexts
  // rather than enforcing them — worth keeping accurate, as tsconfig.json
  // includes only `src` and nothing type-checks e2e/ today either.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parser: tsparser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tsRules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // The only enforced formatting in the TypeScript workspaces, applied by
  // `task fmt`. Nothing else is enforced — see the Formatting section of
  // CLAUDE.md for what is deliberately left to the author.
  //
  // A trailing block rather than an entry in each `rules` above: webapp is the
  // one workspace whose config is split into several blocks, and formatting
  // applies to all of them. The pattern is the union of what those blocks
  // already match, so it widens no file's coverage — only its rules.
  {
    files: ['**/*.{ts,tsx,js}'],
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
];