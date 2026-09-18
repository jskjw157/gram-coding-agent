import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gram/shell': fileURLToPath(new URL('../shell/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
