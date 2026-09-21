import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gram/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@gram/persistence': fileURLToPath(new URL('../persistence/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
