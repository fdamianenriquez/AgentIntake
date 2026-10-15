import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// typescript-eslint parses through the TypeScript 6 API (the `typescript`
// dev dependency is an alias of @typescript/typescript6); the project itself
// is compiled and type-checked with TypeScript 7 (`@typescript/native`). The
// rules are the recommended set without type information, so linting doesn't
// depend on the two compilers agreeing on types.
export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'docs/', '**/__snapshots__/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // A leading underscore marks a value that is deliberately unused, e.g. a
      // property dropped from an object by destructuring.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['studio/**/*.{ts,tsx}', 'demo/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['**/*.tsx', 'packages/**/*.ts'],
    extends: [reactHooks.configs.flat.recommended],
  },
  prettier
);
