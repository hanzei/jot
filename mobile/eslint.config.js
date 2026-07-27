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
      // eslint-plugin-react-hooks v6+ recommended bundles a large set of new
      // React Compiler readiness rules (refs, set-state-in-effect, purity,
      // immutability, etc.) that this codebase's non-compiler patterns (ref
      // mirroring, setState-in-effect for derived state) predate. Keep only
      // the two rules this project has always linted against.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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
];
