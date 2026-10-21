import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Historical #208 baseline at M2 d886ce3 had three unmet file-denial assertions.
// These assertions remain intact; the isolated profile must now pass them.
// Entry point: node tests/security/run-secret-boundary.mjs
// It supplies a clean parent environment and a 45-second process-group watchdog.
// Requires installed workspace dependencies, Linux /proc, Node 24, genuine npm
// next to process.execPath, no DAC-bypass capabilities, and an EACCES mode-0000
// control. Bare Vitest is intentionally insufficient to initialize the fixture.
// Required CI runs pnpm test:security explicitly; root unit test stays separate.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: {
      '@gram/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@gram/persistence': fileURLToPath(new URL('../../packages/persistence/src/index.ts', import.meta.url)),
      '@gram/policy': fileURLToPath(new URL('../../packages/policy/src/index.ts', import.meta.url)),
      '@gram/secrets': fileURLToPath(new URL('../../packages/secrets/src/index.ts', import.meta.url)),
      '@gram/shell': fileURLToPath(new URL('../../packages/shell/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/security/secret-boundary.test.ts', 'tests/security/command-isolation.test.ts'],
    passWithNoTests: false,
    allowOnly: false,
    cache: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
