import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    // The CommonJS tooling files are linted by the block below instead: they
    // are `require`/`module.exports`, which this block's `sourceType: 'module'`
    // rejects outright.
    ignores: [
      'app.config.js',
      'babel.config.js',
      'jest.config.js',
      'jest.setup.js',
      'jest.setupAfterEnv.js',
      'metro.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parser: tsparser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      react,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      // Spread wholesale, matching webapp/eslint.config.js: no rule is disabled
      // here, so new rules in future plugin bumps apply by default. Pre-existing
      // violations are suppressed at their exact sites and tracked in #777.
      ...reactHooks.configs.recommended.rules,
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Edit-time mirror of the `verbatimModuleSyntax` compiler flag: reports a
      // type-only binding pulled in through a plain `import` before `tsc`
      // would. `disallowTypeAnnotations: false` leaves inline `import('x')`
      // type annotations alone — `verbatimModuleSyntax` doesn't require
      // touching those, and mobile's tests lean on the pattern heavily
      // (`jest.requireActual<typeof import('react')>(...)`).
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      // TypeScript's own type-checking covers undefined-variable detection
      // (including ambient RN/DOM globals like requestAnimationFrame);
      // no-undef only sees ESLint's configured globals and false-positives
      // on those. This mirrors @typescript-eslint's own eslint-recommended
      // preset, which disables the same rule for the same reason.
      'no-undef': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  // The CommonJS tooling files, previously in the global `ignores` above and so
  // linted by nothing at all. jest.setup.js is the one that matters — 400+
  // lines of in-memory expo-file-system and expo-sqlite mocks that every mobile
  // suite loads, and the only file here that is not a handful of lines of
  // config. `tsc` does not see any of them either (mobile/tsconfig.json
  // includes only .ts/.tsx), so ESLint is the sole check they get.
  //
  // Kept separate from the block above rather than folded into it because
  // these are `require`/`module.exports` files, and because `no-undef` is
  // worth having on here: with no TypeScript pass behind them, it is what
  // catches a typo'd global.
  {
    files: [
      'babel.config.js',
      'jest.config.js',
      'jest.setup.js',
      'jest.setupAfterEnv.js',
      'metro.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    // react-hooks is here for jest.setup.js alone: its mock SQLiteProvider is a
    // real component with a real `useEffect`, and the rules apply to it exactly
    // as they would in src/.
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  // The two ESM tooling files. `app.config.js` is `export default` despite the
  // .js extension (Expo resolves it through its own loader), and
  // eslint.config.mjs is not matched by `**/*.{ts,tsx,js,jsx}` at all, mobile's
  // package.json having no `"type": "module"`.
  {
    files: ['app.config.js', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  // The only enforced formatting in the TypeScript workspaces, applied by
  // `task fmt`. Nothing else is enforced — see the Formatting section of
  // CLAUDE.md for what is deliberately left to the author.
  //
  // A trailing block, as in webapp/ and shared/: formatting applies to every
  // file the blocks above match, and the pattern is the union of what they
  // already cover, so it widens no file's rule set beyond these two.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
];
