import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('M2 read/status tools are lock-free', () => {
  it('does not depend on or import @gram/repo-lock', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.['@gram/repo-lock']).toBeUndefined();
    expect(packageJson.devDependencies?.['@gram/repo-lock']).toBeUndefined();

    for (const file of [
      './task-tools.ts',
      './repo-tools.ts',
      './git-tools.ts',
      './verification-tools.ts',
      './github-tools.ts',
      './agent-tools.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file + ' must remain lock-free').not.toContain(
        '@gram/repo-lock',
      );
    }
  });
});
