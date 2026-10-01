import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('produces identical SHAs under hostile ambient git config', () => {
    // Baseline first, before any GIT_CONFIG_* override is installed, so it
    // observes only the genuine ambient config and the comparison below is
    // not circular: hostile fixtures must match a SHA the hostile file never touched.
    const baseline = createTestRepository();
    fixtures.push(baseline);
    const baselineSha = baseline.initialSha;

    const hostileDir = mkdtempSync(join(tmpdir(), 'gram-e2e-hostile-'));
    const hooksDir = join(hostileDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(hookPath, 0o755);
    const templatePath = join(hostileDir, 'template.txt');
    writeFileSync(templatePath, 'JUNK TEMPLATE LINE\n', 'utf8');
    const globalConfigPath = join(hostileDir, 'hostile.gitconfig');
    writeFileSync(
      globalConfigPath,
      [
        '[commit]',
        '	gpgsign = true',
        '	template = ' + templatePath,
        '[core]',
        '	autocrlf = true',
        '	hooksPath = ' + hooksDir,
        '',
      ].join('\n'),
      'utf8',
    );

    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    process.env.GIT_CONFIG_SYSTEM = globalConfigPath;
    try {
      const first = createTestRepository();
      fixtures.push(first);
      const second = createTestRepository();
      fixtures.push(second);

      expect(first.initialSha).toBe(second.initialSha);
      expect(first.initialSha).toBe(baselineSha);
      expect(first.initialSha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(first.canonicalPath, ['rev-parse', 'HEAD'])).toBe(
        git(first.canonicalPath, ['rev-parse', 'origin/main']),
      );
      expect(git(second.canonicalPath, ['rev-parse', 'HEAD'])).toBe(
        git(second.canonicalPath, ['rev-parse', 'origin/main']),
      );
    } finally {
      if (prevGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      }
      if (prevSystem === undefined) {
        delete process.env.GIT_CONFIG_SYSTEM;
      } else {
        process.env.GIT_CONFIG_SYSTEM = prevSystem;
      }
      rmSync(hostileDir, { recursive: true, force: true });
    }
  });
});
