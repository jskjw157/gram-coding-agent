import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, RepositoryRepository, runMigrations } from '@gram/persistence';
import { RepoResolver } from './repo-resolver.js';
import { RepositoryProfiler } from './repo-profiler.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function openRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'gram-repo-registry-'));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, 'state.db'));
  openDbs.push(db);
  runMigrations(db);
  return new RepositoryRepository(db);
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('RepoResolver', () => {
  it('returns an existing registry row without GitHub discovery', async () => {
    const repositories = openRegistry();
    repositories.upsert({
      githubRepositoryId: 100,
      owner: 'acme',
      name: 'existing',
      defaultBranch: 'trunk',
      localBasePath: '/home/test/workspace/github/acme/existing',
      projectType: 'node',
      packageManager: 'pnpm',
      commands: { test: 'pnpm test' },
      profile: {},
    });
    const discovery = { discover: vi.fn() };
    const checkout = { ensureBaseCheckout: vi.fn() };
    const inspector = { inspect: vi.fn() };
    const resolver = new RepoResolver({
      repositories,
      discovery,
      checkout,
      inspector,
      profiler: new RepositoryProfiler(),
      homeDir: '/home/test',
    });

    const profile = await resolver.resolve('acme/existing');

    expect(profile.githubRepositoryId).toBe(100);
    expect(profile.defaultBranch).toBe('trunk');
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(checkout.ensureBaseCheckout).not.toHaveBeenCalled();
    expect(inspector.inspect).not.toHaveBeenCalled();
  });

  it('discovers, checks out, inspects, and persists an unknown repository once', async () => {
    const repositories = openRegistry();
    const discovery = {
      discover: vi.fn(async () => ({
        githubRepositoryId: 4242,
        owner: 'acme',
        name: 'widget',
        defaultBranch: 'main',
        cloneUrl: 'https://github.com/acme/widget.git',
      })),
    };
    const checkout = { ensureBaseCheckout: vi.fn(async () => undefined) };
    const inspector = {
      inspect: vi.fn(async () => ({
        files: ['pnpm-lock.yaml', 'package.json'],
        packageJson: { scripts: { lint: 'eslint .', test: 'vitest', extra: 'ignore-me' } },
      })),
    };
    const resolver = new RepoResolver({
      repositories,
      discovery,
      checkout,
      inspector,
      profiler: new RepositoryProfiler(),
      homeDir: '/home/test',
    });

    const profile = await resolver.resolve('widget');

    expect(discovery.discover).toHaveBeenCalledTimes(1);
    expect(checkout.ensureBaseCheckout).toHaveBeenCalledTimes(1);
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
    expect(profile).toMatchObject({
      githubRepositoryId: 4242,
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
      localBasePath: '/home/test/workspace/github/acme/widget',
      packageManager: 'pnpm',
      commands: { lint: 'pnpm lint', test: 'pnpm test' },
    });
    expect(profile.commands).not.toHaveProperty('build');
    expect(profile.commands).not.toHaveProperty('dev');
    expect(repositories.getById(4242)?.githubRepositoryId).toBe(4242);

    await resolver.resolve('acme/widget');
    expect(discovery.discover).toHaveBeenCalledTimes(1);
  });
});

describe('RepositoryProfiler', () => {
  const profiler = new RepositoryProfiler();

  it.each([
    [['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'], 'pnpm'],
    [['package-lock.json', 'yarn.lock'], 'npm'],
    [['yarn.lock'], 'yarn'],
    [['build.gradle', 'pom.xml', 'pyproject.toml'], 'gradle'],
    [['gradlew', 'pom.xml', 'pyproject.toml'], 'gradle'],
    [['pom.xml', 'pyproject.toml'], 'maven'],
    [['pyproject.toml'], 'python'],
  ])('detects the approved toolchain priority for %j', (files, expected) => {
    expect(profiler.profile({ files }).packageManager).toBe(expected);
  });

  it('persists only declared Node lint/test/build/dev scripts', () => {
    const profile = profiler.profile({
      files: ['package-lock.json', 'package.json'],
      packageJson: {
        scripts: {
          lint: 'eslint .',
          build: 'tsc',
          release: 'do-not-persist',
        },
      },
    });

    expect(profile.commands).toEqual({ lint: 'npm run lint', build: 'npm run build' });
  });
});
