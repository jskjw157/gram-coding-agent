import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@gram/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@gram/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
      '@gram/shell': fileURLToPath(new URL('../shell/src/index.ts', import.meta.url)),
      '@gram/secrets': fileURLToPath(new URL('../secrets/src/index.ts', import.meta.url)),
    },
  },
  test: { name: 'filesystem', environment: 'node', include: ['src/**/*.test.ts'] },
});
