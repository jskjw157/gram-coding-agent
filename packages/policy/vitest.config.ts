import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@gram/domain': new URL('../domain/src/index.ts', import.meta.url).pathname,
    },
  },
});
