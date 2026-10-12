import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import current from './windows-escape.vitest.config.js';

// Same tests against an actual pre-fix revision; never a copied implementation.
// This optional control intentionally exits nonzero at security assertions.
const revision = '33e2a5da6ffaba1284e7866c7348b99c6562c2aa';
const supplied = process.env.GRAM_WINDOWS_ESCAPE_RED_ROOT;
if (!supplied) throw new Error('Set GRAM_WINDOWS_ESCAPE_RED_ROOT to the pinned historical checkout.');
const root = realpathSync(supplied);
const gitOptions = { encoding: 'utf8', shell: false, timeout: 5000 } as const;
if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], gitOptions).trim() !== revision) {
  throw new Error('Historical Windows regression source is not the required revision.');
}
execFileSync('git', ['-C', root, 'diff', '--exit-code', revision, '--', 'packages/windows-integration'], {
  ...gitOptions,
  stdio: 'pipe',
});

export default mergeConfig(current, defineConfig({
  resolve: {
    alias: {
      '@gram/windows-integration': join(root, 'packages/windows-integration/src/index.ts'),
    },
  },
}));
