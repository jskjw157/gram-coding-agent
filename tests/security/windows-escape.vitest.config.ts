import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Deliberately independent of the root package/app project glob.
// Invoke: pnpm exec vitest run --config tests/security/windows-escape.vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: {
      '@gram/windows-integration': fileURLToPath(new URL('../../packages/windows-integration/src/index.ts', import.meta.url)),
      '@gram/policy': fileURLToPath(new URL('../../packages/policy/src/index.ts', import.meta.url)),
      '@gram/secrets': fileURLToPath(new URL('../../packages/secrets/src/index.ts', import.meta.url)),
      '@gram/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'windows-escape-security',
    environment: 'node',
    include: ['tests/security/windows-escape.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 12_000,
    hookTimeout: 12_000,
  },
});
