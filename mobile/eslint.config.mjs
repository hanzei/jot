import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'node_modules/**',
      'app.config.js',
      'babel.config.js',
      'jest.config.js',
      'jest.setup.js',
      'jest.setupAfterEnv.js',
      'metro.config.js',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
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
      // TypeScript's own type-checking covers undefined-variable detection
      // (including ambient RN/DOM globals like requestAnimationFrame);
      // no-undef only sees ESLint's configured globals and false-positives
      // on those. This mirrors @typescript-eslint's own eslint-recommended
      // preset, which disables the same rule for the same reason.
      'no-undef': 'off',
      // The only enforced formatting in the TypeScript workspaces, applied by
      // `task fmt`. Nothing else is enforced — see the Formatting section of
      // CLAUDE.md for what is deliberately left to the author.
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
    settings: {
      react: { version: 'detect' },
    },
  },
];
