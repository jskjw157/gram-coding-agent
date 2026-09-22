import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('@gram/github package boundary', () => {
  it('contains the PR service but has no dependency or source import on @gram/repo-lock', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.['@gram/repo-lock']).toBeUndefined();
    expect(packageJson.devDependencies?.['@gram/repo-lock']).toBeUndefined();

    const files = readdirSync(new URL('.', import.meta.url), {
      recursive: true,
      encoding: 'utf8',
    }).filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.test.ts'),
    );

    expect(files).toContain('pull-request-service.ts');

    for (const path of files) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source, `${path} must not import repo-lock`).not.toContain(
        '@gram/repo-lock',
      );
    }
  });
});
