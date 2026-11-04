import { defineConfig } from 'vitest/config';
import agent from '../../apps/agent/vitest.config.js';

export default defineConfig({ ...(agent.resolve === undefined ? {} : { resolve: agent.resolve }), test: {
  include: ['tests/security/database-mysql.native.ts'],
  environment: 'node', allowOnly: false, passWithNoTests: false,
  fileParallelism: false, maxWorkers: 1, testTimeout: 45000, hookTimeout: 30000,
} });
