import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone because the pinned M2 root configuration collects packages/apps only.
// Run: pnpm exec vitest run --config tests/concurrency/vitest.config.mts
const packages = [
  'domain',
  'git',
  'github',
  'mcp',
  'observability',
  'persistence',
  'policy',
  'publishing',
  'repo-lock',
  'repo-registry',
  'secrets',
  'shell',
  'task-engine',
  'verification',
  'workspace',
  'filesystem',
];

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/concurrency/{different-repos,same-repo}.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: Object.fromEntries(
      packages.map((name) => [
        `@gram/${name}`,
        fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url)),
      ]),
    ),
  },
});
