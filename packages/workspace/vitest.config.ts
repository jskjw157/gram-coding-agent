import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gram/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@gram/persistence': fileURLToPath(new URL('../persistence/src/index.ts', import.meta.url)),
      // Alias to source, not the workspace symlink, so this suite does not
      // depend on `packages/policy/dist` existing. CI runs test BEFORE build,
      // so without this alias a clean checkout fails to resolve the entry.
      '@gram/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
