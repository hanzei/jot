import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import comments from '@eslint-community/eslint-plugin-eslint-comments';

const SHARED_PACKAGE_IMPORT_MESSAGE = 'shared/ has no runtime dependencies and CI does not install shared/node_modules, so a package import (even type-only) breaks both clients\' typecheck. Use a relative import, or declare the type structurally — see InlineMarkdownToken in src/inlineMarkdown.ts.';

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
  // `shared/` has no runtime dependencies, so library code may import only
  // relative paths. Both clients compile `shared/src` with their own tsc, and
  // resolution starts from `shared/`, where CI never installs `node_modules`: a
  // package import — even `import type` — resolves locally (bootstrap installs
  // `shared/node_modules`) and fails only in the webapp and mobile workflows.
  // The regex matches any specifier not starting with `.`, i.e. every bare one.
  // `no-restricted-imports` sees only import/export declarations, so the
  // `no-restricted-syntax` selectors apply the same test to `import('x')` types
  // and dynamic `import('x')` expressions. Tests are exempt: vitest runs them,
  // and `shared-ci.yml` installs their dependencies (`marked`, `vitest`).
  //
  // Dates are formatted only by formatDateInLocale() in dates.ts, so both
  // clients' formatDate() wrappers decide the locale (#1236). The client
  // configs carry the same selector; shared/ is linted by neither of them.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^[^.]',
          message: SHARED_PACKAGE_IMPORT_MESSAGE,
        }],
      }],
      'no-restricted-syntax': ['error',
        { selector: 'TSImportType[argument.literal.value=/^[^.]/]', message: SHARED_PACKAGE_IMPORT_MESSAGE },
        { selector: 'ImportExpression[source.value=/^[^.]/]', message: SHARED_PACKAGE_IMPORT_MESSAGE },
        {
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/], :matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
          message: 'Format dates with formatDateInLocale() from dates.ts (#1236).',
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
