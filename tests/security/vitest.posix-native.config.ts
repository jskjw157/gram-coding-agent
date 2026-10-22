import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['tests/security/posix-workspace-transport.native.ts'],
  testTimeout: 60000,
} });
