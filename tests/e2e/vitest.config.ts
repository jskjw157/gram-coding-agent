import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@gram/domain': new URL('../../packages/domain/src/index.ts', import.meta.url).pathname,
      '@gram/git': new URL('../../packages/git/src/index.ts', import.meta.url).pathname,
      '@gram/github': new URL('../../packages/github/src/index.ts', import.meta.url).pathname,
      '@gram/mcp': new URL('../../packages/mcp/src/index.ts', import.meta.url).pathname,
      '@gram/observability': new URL('../../packages/observability/src/index.ts', import.meta.url).pathname,
      '@gram/persistence': new URL('../../packages/persistence/src/index.ts', import.meta.url).pathname,
      '@gram/policy': new URL('../../packages/policy/src/index.ts', import.meta.url).pathname,
      '@gram/publishing': new URL('../../packages/publishing/src/index.ts', import.meta.url).pathname,
      '@gram/repo-lock': new URL('../../packages/repo-lock/src/index.ts', import.meta.url).pathname,
      '@gram/repo-registry': new URL('../../packages/repo-registry/src/index.ts', import.meta.url).pathname,
      '@gram/secrets': new URL('../../packages/secrets/src/index.ts', import.meta.url).pathname,
      '@gram/shell': new URL('../../packages/shell/src/index.ts', import.meta.url).pathname,
      '@gram/task-engine': new URL('../../packages/task-engine/src/index.ts', import.meta.url).pathname,
      '@gram/verification': new URL('../../packages/verification/src/index.ts', import.meta.url).pathname,
      '@gram/workspace': new URL('../../packages/workspace/src/index.ts', import.meta.url).pathname,
    },
  },
});
