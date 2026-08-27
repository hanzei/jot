import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsparser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
      // Edit-time mirror of the `verbatimModuleSyntax` compiler flag: reports a
      // type-only binding pulled in through a plain `import` before `tsc` would.
      // `disallowTypeAnnotations: false` leaves inline `import('x')` type
      // annotations alone — `verbatimModuleSyntax` doesn't require touching those.
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    },
  },
  // This config file itself. Without a block naming it, it matched no
  // configuration carrying rules and ESLint linted it against nothing — which
  // is how its own imports went semicolon-less under a config that mandates
  // semicolons everywhere else.
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  // The only enforced formatting in the TypeScript workspaces, applied by
  // `task fmt`. Nothing else is enforced — see the Formatting section of
  // CLAUDE.md for what is deliberately left to the author.
  //
  // A trailing block, as in webapp/eslint.config.js: formatting applies to
  // every file the blocks above match, and the pattern is the union of what
  // they already cover, so it widens no file's rule set beyond these two.
  {
    files: ['**/*.{ts,js}'],
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
];
