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
      // eslint-plugin-react-hooks v7 recommended bundles the React Compiler
      // readiness rules alongside rules-of-hooks/exhaustive-deps. The codebase
      // is clean against all of them except the two disabled below, so take the
      // preset wholesale — new rules in future bumps then apply by default.
      ...reactHooks.configs.recommended.rules,
      // Off pending the React Compiler evaluation (#758). ~75 sites mirror a
      // prop/state into a ref during render (`xRef.current = x`) to keep
      // debounced saves and sync callbacks off stale closures — concentrated in
      // NoteEditorScreen, useNotes, and useLabels. Migrating them to
      // useEffectEvent is a real refactor of the offline/sync layer, so it is
      // gated on the compiler actually showing a measurable win.
      'react-hooks/refs': 'off',
      // Off by design, not deferred: every report is the compiler saying it
      // skipped a component whose manual memoization it could not preserve
      // (all of them in DrawerContent). That is the bailout working — the
      // component stays un-optimized and correct — not a defect to fix.
      'react-hooks/preserve-manual-memoization': 'off',
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
  {
    // Test probe components deliberately capture hook output into module-scope
    // variables during render so assertions can read it — the point is to
    // observe the render, so the purity guard doesn't apply.
    files: ['__tests__/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/globals': 'off',
    },
  },
];
