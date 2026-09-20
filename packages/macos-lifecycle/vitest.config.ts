import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  name: 'macos-lifecycle', environment: 'node',
  include: ['src/**/*.test.ts'], passWithNoTests: false,
} });
