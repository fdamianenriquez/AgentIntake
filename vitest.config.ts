import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['cli/**/*.ts', 'server/src/**/*.ts', 'packages/**/*.{ts,tsx}', 'studio/**/*.tsx', 'demo/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__fixtures__/**'],
    },
  },
});
