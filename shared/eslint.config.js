import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import comments from '@eslint-community/eslint-plugin-eslint-comments';

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
  // Mobile's Babel (babel-preset-expo) lowers these constructs to
  // `@babel/runtime` helpers that cannot be resolved from shared/, and every
  // mobile suite then fails to load with an error pointing at an unrelated
  // import. Tests are compiled by vitest, not mobile's Babel, and declaration
  // files emit no code, so both are exempt. See "`@jot/shared`: syntax that needs a @babel/runtime helper" in
  // CLAUDE.md.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**', 'src/**/*.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ArrayPattern',
          message: 'No array destructuring in shared/src: mobile\'s Babel needs a @babel/runtime helper for it. Use index access (`entry[0]`). See CLAUDE.md.',
        },
        {
          selector: 'ObjectPattern > RestElement',
          message: 'No object rest (`{ a, ...rest }`) in shared/src: mobile\'s Babel needs a @babel/runtime helper for it. Copy with spread and `delete`, or pick fields explicitly. See CLAUDE.md.',
        },
        {
          selector: ':function[async=true]',
          message: 'No async functions in shared/src: mobile\'s Babel needs a @babel/runtime helper for them. Chain `.then` instead. See CLAUDE.md.',
        },
        {
          selector: ':matches(ClassDeclaration, ClassExpression)',
          message: 'No classes in shared/src: mobile\'s Babel needs @babel/runtime helpers for them. Use plain functions and objects. See CLAUDE.md.',
        },
      ],
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
  // Enforces the CLAUDE.md rule that every suppression carries a visible
  // reason: a disable directive must spell out why, inline, after `--`. A
  // closing `eslint-enable` is exempt — the `eslint-disable` it pairs with
  // already states the reason. Same trailing-block pattern as the formatting
  // rules above, matching the union of files those blocks cover.
  {
    files: ['**/*.{ts,js}'],
    plugins: {
      '@eslint-community/eslint-comments': comments,
    },
    rules: {
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
    },
  },
];
