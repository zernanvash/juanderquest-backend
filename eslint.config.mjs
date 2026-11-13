import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Empty catch blocks are used intentionally for best-effort fallbacks/cleanup
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Used intentionally to strip ASCII control characters in notification sanitization
      'no-control-regex': 'off',
      // Initializers and trailing parameter-index increments before conditional/try blocks are intentional
      'no-useless-assignment': 'off',
      // Existing regex character-class escapes are kept as-is to avoid altering pattern semantics
      'no-useless-escape': 'off',
      // Express async wrapper accepts arbitrary router handler signatures
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests use require() after jest.resetModules() to reload module-level env config
      '@typescript-eslint/no-require-imports': 'off',
      // Assertion helpers like expect().toThrow / short-circuit test expressions may look unused
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
