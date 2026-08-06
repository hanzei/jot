import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

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
      // The only enforced formatting in the TypeScript workspaces, applied by
      // `task fmt`. Nothing else is enforced — see the Formatting section of
      // CLAUDE.md for what is deliberately left to the author.
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
]
