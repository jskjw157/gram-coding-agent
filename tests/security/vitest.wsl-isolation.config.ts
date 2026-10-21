import { defineConfig } from 'vitest/config';
import linux from './vitest.secret-boundary.config.js';

export default defineConfig({ ...linux, test: { ...linux.test,
  include: ['tests/security/command-isolation-wsl.test.ts'], testTimeout: 20_000,
} });
