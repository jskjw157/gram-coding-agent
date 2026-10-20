import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      '@gram/secrets': fileURLToPath(new URL('../secrets/src/index.ts', import.meta.url)),
    },
  },
});
