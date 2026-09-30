import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRepository, type TestRepositoryFixture } from './create-test-repo.js';

const fixtures: TestRepositoryFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

describe('createTestRepository', () => {
  it('creates a bare remote and isolated canonical clone with deterministic TypeScript scripts', () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);

    expect(existsSync(fixture.remotePath)).toBe(true);
    expect(existsSync(fixture.canonicalPath)).toBe(true);
    expect(fixture.canonicalPath).not.toBe(fixture.remotePath);
    expect(git(fixture.remotePath, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(git(fixture.canonicalPath, ['remote', 'get-url', 'origin'])).toBe(fixture.remotePath);

    const packageJson = JSON.parse(
      readFileSync(fixture.canonicalPath + '/package.json', 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      lint: 'tsc --noEmit',
      test: 'node --test test/*.test.js',
      build: 'tsc',
    });
    expect(existsSync(fixture.canonicalPath + '/src/counter.ts')).toBe(true);
    expect(existsSync(fixture.canonicalPath + '/test/counter.test.js')).toBe(true);
  });

  it('starts from a committed remote main while the target behavior is intentionally failing', () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);

    expect(git(fixture.canonicalPath, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.canonicalPath, ['branch', '--show-current'])).toBe('main');
    const localHead = git(fixture.canonicalPath, ['rev-parse', 'HEAD']);
    const remoteHead = git(fixture.canonicalPath, ['rev-parse', 'origin/main']);
    expect(localHead).toBe(remoteHead);
    expect(localHead).toMatch(/^[0-9a-f]{40}$/);

    expect(() =>
      execFileSync('node', ['--test', 'test/counter.test.js'], {
        cwd: fixture.canonicalPath,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
