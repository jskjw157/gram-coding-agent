import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      '@gram/domain': new URL('../../packages/domain/src/index.ts', import.meta.url).pathname,
      '@gram/mcp': new URL('../../packages/mcp/src/index.ts', import.meta.url).pathname,
      '@gram/observability': new URL('../../packages/observability/src/index.ts', import.meta.url).pathname,
      '@gram/persistence': new URL('../../packages/persistence/src/index.ts', import.meta.url).pathname,
      '@gram/policy': new URL('../../packages/policy/src/index.ts', import.meta.url).pathname,
      '@gram/secrets': new URL('../../packages/secrets/src/index.ts', import.meta.url).pathname,
    },
  },
});
