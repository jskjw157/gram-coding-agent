import { readFileSync, writeFileSync, renameSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { RemoteService } from '@gram/git';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import filePromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { FileSecretProvider } from '@gram/secrets';
import type { SpawnRequest } from '@gram/shell';
import { assertTrustedRuntime, RUNTIME_ROOT } from '@gram/shell';
import { TrustedGitSpawner, superviseTrustedGit, superviseAuthenticatedGit, readTrustedLocalGit as isolatedLocalGit } from './trusted-git-spawner.js';
import { localGitFixtureSource } from './local-git-read-snapshot.test-support.js';

let root: string;
let base: string;
let spawner: TrustedGitSpawner;
// Full installed-runtime integrity is fixture preparation, not the operation's deadline.
beforeAll(() => assertTrustedRuntime(RUNTIME_ROOT), 30_000);
const readTrustedLocalGit = (basePath: string, request: Parameters<typeof isolatedLocalGit>[1]) =>
  isolatedLocalGit(basePath, request, { snapshotDirectory: path.join(root, 'snapshots'), source: localGitFixtureSource(basePath) });
const git = (args: string[]) =>
  execFileSync('/usr/bin/git', args, {
    cwd: base,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
const request = (args: string[], overrides: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ taskId: 'task', cwd: base, category: 'GIT', executable: 'git', args, env: {}, ...overrides }) as SpawnRequest;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gram-trusted-git-'));
  base = path.join(root, 'base');
  await mkdir(base);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@localhost.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/smoke.git']);
  await writeFile(path.join(base, 'counter.ts'), 'export const n = 1;');
  git(['add', '--', 'counter.ts']);
  git(['commit', '-m', 'initial']);
  spawner = new TrustedGitSpawner({
    contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }),
    secrets: new FileSecretProvider(path.join(root, 'secrets')),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('trusted application Git boundary', () => {
  it.each(['false', 'true'])('admits the Windows core.symlinks=%s boolean for captured and application Git', async value => {
    // Git for Windows init defaults, retained in the captured repository config.
    git(['config', 'core.filemode', 'false']);
    git(['config', 'core.ignorecase', 'true']);
    git(['config', 'core.symlinks', value]);
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 2;');
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toContain(' M counter.ts\0');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toContain('+export const n = 2;');
    expect((await spawner.spawn(request(['status', '--porcelain=v1', '-z']))).stdout).toContain(' M counter.ts\0');
    expect((await spawner.spawn(request(['diff', '--']))).stdout).toContain('+export const n = 2;');
    expect(git(['config', '--local', '--get', 'core.symlinks']).trim()).toBe(value);
  });
  it('preserves Windows symlink-as-file semantics inside the captured read namespace', async () => {
    await writeFile(path.join(base, 'link.txt'), 'counter.ts');
    const oid = git(['hash-object', '-w', 'link.txt']).trim();
    git(['update-index', '--add', '--cacheinfo', '120000', oid, 'link.txt']);
    git(['commit', '-m', 'symlink index fixture']);
    git(['config', 'core.symlinks', 'false']);
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toBe('');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toBe('');
  });
  it.each(['yes', '1', '', 'FALSE', 'invalid', 'false\ninclude.path=/tmp/hostile'])('rejects noncanonical core.symlinks value %j in both Git paths', async value => {
    // Git for Windows init defaults, retained in the captured repository config.
    git(['config', 'core.filemode', 'false']);
    git(['config', 'core.ignorecase', 'true']);
    git(['config', 'core.symlinks', value]);
    await expect(readTrustedLocalGit(base, { operation: 'status' })).rejects.toThrow();
    await expect(spawner.spawn(request(['status', '--porcelain=v1', '-z']))).rejects.toThrow();
  });
  it.each(['include.path', 'filter.evil.clean', 'core.hooksPath'])('still rejects %s alongside Windows core.symlinks=false', async key => {
    git(['config', 'core.symlinks', 'false']);
    git(['config', key, '/nonexistent/hostile']);
    await expect(readTrustedLocalGit(base, { operation: 'status' })).rejects.toThrow();
    await expect(spawner.spawn(request(['status', '--porcelain=v1', '-z']))).rejects.toThrow();
  });
  it.each(['false', 'true'])('still rejects an outside symlink when core.symlinks=%s', async value => {
    git(['config', 'core.symlinks', value]);
    const outside = path.join(root, 'outside-private');
    await writeFile(outside, 'private-sentinel');
    symlinkSync(outside, path.join(base, 'escape'));
    await expect(readTrustedLocalGit(base, { operation: 'diff', staged: false })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('private-sentinel');
  });
  it('checks executable provenance before even the identity parser can spawn Git', async () => {
    const original = filePromises.realpath;
    const inspect = vi.spyOn(filePromises, 'realpath').mockImplementation(async (file, options) => {
      if (file === '/usr/bin/git') return '/untrusted/git';
      return original(file, options);
    });
    const launches = vi.spyOn(childProcess, 'spawn');syncBuiltinESMExports();
    try {
      await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
      expect(launches).not.toHaveBeenCalled();
    } finally {inspect.mockRestore();launches.mockRestore();syncBuiltinESMExports();}
  });
  it('does not import arbitrary host data from system trees into the read namespace', async () => {
    const outside = '/usr/share/common-licenses/GPL-3';
    const sentinel = 'GNU GENERAL PUBLIC LICENSE';expect(await readFile(outside, 'utf8')).toContain(sentinel);
    const tracked = 'x'.repeat(outside.length);await writeFile(path.join(base, tracked), 'original');
    git(['add', '--', tracked]);git(['commit', '-m', 'system-data fixture']);
    const indexPath = path.join(base, '.git/index');const index = await readFile(indexPath);
    const offset = index.indexOf(Buffer.from(tracked + '\0'));expect(offset).toBeGreaterThan(12);
    Buffer.from(outside).copy(index, offset);createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
    await writeFile(indexPath, index);
    const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false }).catch(() => null);
    expect(result?.stdout ?? '').not.toContain(sentinel);
  });
  it('preserves inert repository exclusions and executable-bit observations', async () => {
    await writeFile(path.join(base, '.git/info/exclude'), '*.log\n');await writeFile(path.join(base, 'ignored.log'), 'ordinary');
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toBe('');
    chmodSync(path.join(base, 'counter.ts'), 0o755);
    const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false });
    expect(result.stdout).toContain('old mode 100644');expect(result.stdout).toContain('new mode 100755');
  });
  it('refuses object alternates and hardlink aliases before any private Git read', async () => {
    await mkdir(path.join(base, '.git/objects/info'), { recursive: true });
    await writeFile(path.join(base, '.git/objects/info/alternates'), path.join(root, 'outside-objects'));
    await expect(readTrustedLocalGit(base, { operation: 'status' })).rejects.toThrow();
    await rm(path.join(base, '.git/objects/info/alternates'));
    await writeFile(path.join(root, 'private-file'), 'outside-fixture-only');
    linkSync(path.join(root, 'private-file'), path.join(base, 'hardlink-alias'));
    await expect(readTrustedLocalGit(base, { operation: 'diff', staged: false })).rejects.toThrow();
    expect(await readFile(path.join(root, 'private-file'), 'utf8')).toBe('outside-fixture-only');
  });
  it('does not follow a working-tree parent replaced by an outside symlink after admission', async () => {
    const parent = path.join(base, 'child');const outside = path.join(root, 'outside');const sentinel = 'outside-parent-sentinel';
    await mkdir(parent);await mkdir(outside);
    await writeFile(path.join(parent, 'file.ts'), 'original');await writeFile(path.join(outside, 'file.ts'), sentinel);
    git(['add', '--', 'child/file.ts']);git(['commit', '-m', 'parent fixture']);
    const originalSpawn = childProcess.spawn;
    const hook = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      if (Array.isArray(args) && args.includes('diff')) {renameSync(parent, path.join(root, 'saved-child'));symlinkSync(outside, parent);}
      return originalSpawn(command, args, options);
    });
    syncBuiltinESMExports();
    try {
      const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false }).catch(() => null);
      expect(result?.stdout ?? '').not.toContain(sentinel);
    } finally {hook.mockRestore();syncBuiltinESMExports();}
  });
  it.each(['relative', 'absolute'])('never reads outside the selected worktree through a forged %s index path', async kind => {
    const outside = path.join(root, 'data.ts');const sentinel = 'outside-controller-sentinel';
    await writeFile(outside, sentinel);
    const forged = kind === 'relative' ? '../data.ts' : outside;
    const tracked = kind === 'relative' ? 'counter.ts' : 'x'.repeat(forged.length);
    if (kind === 'absolute') {await writeFile(path.join(base, tracked), 'original');git(['add', '--', tracked]);git(['commit', '-m', 'index fixture']);}
    const indexPath = path.join(base, '.git/index');const index = await readFile(indexPath);
    const offset = index.indexOf(Buffer.from(tracked + '\0'));expect(offset).toBeGreaterThan(12);
    Buffer.from(forged).copy(index, offset);
    createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
    await writeFile(indexPath, index);
    const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false }).catch(() => null);
    expect(result?.stdout ?? '').not.toContain(sentinel);
  });
  it.each(['worktree', 'index', 'info'])('does not execute a concurrently installed clean filter from %s attributes', async source => {
    const marker = path.join(root, 'filter-executed');
    const attributes = path.join(base, '.gitattributes');
    if (source !== 'info') {
      await writeFile(attributes, '*.ts filter=proof\n');git(['add', '--', '.gitattributes']);git(['commit', '-m', 'attributes']);
      if (source === 'index') await rm(attributes);
    }
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 2;');
    const configPath = path.join(base, '.git/config');const admitted = await readFile(configPath, 'utf8');
    const originalSpawn = childProcess.spawn;let raced = false;
    const hook = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      if (Array.isArray(args) && args.includes('diff')) {
        raced = true;
        writeFileSync(configPath, admitted + `\n[filter "proof"]\n\tclean = "printf executed > '${marker}'; cat"\n`);
        if (source === 'info') writeFileSync(path.join(base, '.git/info/attributes'), '*.ts filter=proof\n');
      }
      return originalSpawn(command, args, options);
    });
    syncBuiltinESMExports();
    try {
      const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false });
      expect(raced).toBe(true);expect(result.stdout).toContain('+export const n = 2;');
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {hook.mockRestore();syncBuiltinESMExports();}
  });
  it('reads local GitLab projects without granting remote or GitHub registration identity', async () => {
    git(['remote', 'set-url', 'origin', 'git@gitlab.internal:project/mc-web.git']);
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 9;');
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toContain(' M counter.ts\0');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toContain('+export const n = 9;');
    expect((await readTrustedLocalGit(base, { operation: 'log', maxCount: 1 })).stdout).toContain('initial\0');
    await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
    git(['remote', 'remove', 'origin']);
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toContain(' M counter.ts\0');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toContain('+export const n = 9;');
    await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
  });
  it('reads Windows mc-web GitLab projects with inert VS Code branch and push metadata', async () => {
    git(['remote', 'set-url', 'origin', 'https://gitlab.example.invalid/project/mc-web.git']);
    git(['config', 'core.filemode', 'false']);
    git(['config', 'core.ignorecase', 'true']);
    git(['config', 'core.symlinks', 'false']);
    git(['config', 'branch.dev.remote', 'origin']);
    git(['config', 'branch.dev.merge', 'refs/heads/dev']);
    git(['config', 'branch.dev.vscode-merge-base', 'origin/dev']);
    git(['config', 'branch.jiwon/aicc-new-conversation-20261022.base', 'refs/heads/feature/MAMF-2247']);
    git(['config', 'branch.explain-orca-gpt-tab.base', 'refs/remotes/origin/dev']);
    git(['config', 'push.autoSetupRemote', 'true']);
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 9;');
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toContain(' M counter.ts\0');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toContain('+export const n = 9;');
    expect((await readTrustedLocalGit(base, { operation: 'log', maxCount: 1 })).stdout).toContain('initial\0');
    await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
  });
  it('does not extend application Git or GitHub registration authority for VS Code metadata', async () => {
    git(['config', 'branch.dev.vscode-merge-base', 'origin/dev']);
    git(['config', 'push.autoSetupRemote', 'true']);
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toBe('');
    await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
    await expect(spawner.spawn(request(['status', '--porcelain=v1', '-z']))).rejects.toThrow();
  });
  it.each([
    ['branch.dev.vscode-merge-base', '../../escape'],
    ['branch.dev.vscode-merge-base', 'origin/dev;include.path=/tmp/exploit'],
    ['branch.dev.base', '/tmp/config'],
    ['branch.dev.base', 'refs/heads/feature/../../escape'],
    ['push.autoSetupRemote', 'maybe'],
  ])('rejects malformed inert metadata %s=%s even for read-only snapshots', async (key, value) => {
    git(['config', key, value]);
    await expect(readTrustedLocalGit(base, { operation: 'status' })).rejects.toThrow();
  });
  it('still rejects executable Git config in a non-GitHub local project', async () => {
    git(['remote', 'set-url', 'origin', 'git@gitlab.internal:project/mc-web.git']);
    git(['config', 'core.hooksPath', '/tmp/unsafe']);
    await expect(readTrustedLocalGit(base, { operation: 'status' })).rejects.toThrow();
    await expect(readTrustedLocalGit(base, { operation: 'log', maxCount: 1 })).rejects.toThrow();
  });
  it('reads typed local identity, status, diff and log with real Git and no credentials', async () => {
    const identity = await readTrustedLocalGit(base, { operation: 'identity' });
    expect(identity).toMatchObject({ owner: 'fixture', name: 'smoke' });
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 2;');
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toContain(' M counter.ts\0');
    expect((await readTrustedLocalGit(base, { operation: 'diff', staged: false })).stdout).toContain('+export const n = 2;');
    expect((await readTrustedLocalGit(base, { operation: 'log', maxCount: 1 })).stdout).toContain('initial\0');
  });
  it('captures a multi-file readonly diff above 1MiB without enlarging application Git output authority', async () => {
    for (let i = 0; i < 3; i++) await writeFile(path.join(base, `large-${i}.txt`), 'a'.repeat(256 * 1024) + '\n');
    git(['add', '--', 'large-0.txt', 'large-1.txt', 'large-2.txt']);git(['commit', '-m', 'fixture large files']);
    for (let i = 0; i < 3; i++) await writeFile(path.join(base, `large-${i}.txt`), 'b'.repeat(256 * 1024) + '\n');
    const result = await readTrustedLocalGit(base, { operation: 'diff', staged: false });
    expect(result.exitCode).toBe(0);expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(1024 * 1024);
    expect(result.stdout).toContain('diff --git a/large-2.txt b/large-2.txt');
    await expect(superviseTrustedGit(base, ['status'], {}, { maxOutputBytes: 2 * 1024 * 1024 })).rejects.toThrow();
  });
  it('still rejects readonly diffs above the separate 8MiB capture bound', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `huge-${i}.txt`);
    for (const name of names) await writeFile(path.join(base, name), 'a'.repeat(512 * 1024) + '\n');
    git(['add', '--', ...names]);git(['commit', '-m', 'fixture bounded files']);
    for (const name of names) await writeFile(path.join(base, name), 'b'.repeat(512 * 1024) + '\n');
    await expect(readTrustedLocalGit(base, { operation: 'diff', staged: false })).rejects.toThrow();
  });
  it('rejects local metadata command hooks, origin rewrites and arbitrary path flags', async () => {
    git(['config', 'diff.external', '/fixture/never-execute']);
    await expect(readTrustedLocalGit(base, { operation: 'diff', staged: false })).rejects.toThrow();
    git(['config', '--unset', 'diff.external']);git(['remote', 'set-url', 'origin', 'https://other.invalid/private.git']);
    expect((await readTrustedLocalGit(base, { operation: 'status' })).stdout).toBe('');
    await expect(readTrustedLocalGit(base, { operation: 'identity' })).rejects.toThrow();
    await expect(readTrustedLocalGit(base, { operation: 'diff', staged: false, relativePath: '--output=/private' })).rejects.toThrow();
  });
  it('rejects invalid UTF-8 object bytes for a strict review reader', async () => {
    await writeFile(path.join(base, 'counter.ts'), Buffer.from([0xff]));
    git(['add', '--', 'counter.ts']);
    const oid = git(['hash-object', 'counter.ts']).trim();
    const review = new TrustedGitSpawner({
      contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }),
      secrets: new FileSecretProvider(path.join(root, 'secrets')),
      execution: { strictUtf8: true, maxOutputBytes: 256 * 1024, timeoutMs: 10_000 },
    });
    await expect(review.spawn(request(['show', oid]))).rejects.toThrow(/UTF-8/);
  });

  it('enforces a review reader byte limit on actual Git object output', async () => {
    await writeFile(path.join(base, 'counter.ts'), 'x'.repeat(8192));
    git(['add', '--', 'counter.ts']);
    const oid = git(['hash-object', 'counter.ts']).trim();
    const review = new TrustedGitSpawner({
      contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }),
      secrets: new FileSecretProvider(path.join(root, 'secrets')),
      execution: { strictUtf8: true, maxOutputBytes: 1024, timeoutMs: 10_000 },
    });
    await expect(review.spawn(request(['show', oid]))).rejects.toThrow(/execution failed/);
  });
  it('commits an explicit path without requesting a credential', async () => {
    await writeFile(path.join(base, 'counter.ts'), 'export const n = 2;');
    expect((await spawner.spawn(request(['add', '--', 'counter.ts']))).exitCode).toBe(0);
    expect((await spawner.spawn(request(['commit', '--only', '-m', 'fix', '--', 'counter.ts']))).exitCode).toBe(0);
    expect((await spawner.spawn(request(['rev-parse', 'HEAD']))).stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });
  it.each([
    'core.hooksPath',
    'core.fsmonitor',
    'filter.evil.clean',
    'include.path',
    'credential.helper',
    'url.https://evil.invalid/.insteadOf',
    'diff.evil.command',
  ])('rejects executable/redirecting local config %s', async (key) => {
    git(['config', key, '/nonexistent/hostile']);
    await expect(spawner.spawn(request(['status', '--porcelain=v1', '-z']))).rejects.toThrow();
  });
  it('never runs a hostile hook', async () => {
    const marker = path.join(root, 'hook-ran');
    await writeFile(path.join(base, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch ' + marker + '\n', { mode: 0o700 });
    await writeFile(path.join(base, 'counter.ts'), 'changed');
    expect((await spawner.spawn(request(['commit', '--only', '-m', 'fix', '--', 'counter.ts']))).exitCode).toBe(0);
    await expect(readFile(marker)).rejects.toThrow();
  });
  it('rejects shell, category spoofing, arbitrary flags, unknown task cwd and pathspec magic', async () => {
    for (const r of [
      request(['status'], { category: 'DEVELOPMENT' }),
      request(['-c', 'alias.x=!touch /tmp/no', 'x']),
      request(['rev-parse', 'HEAD'], { cwd: root }),
      request(['add', '--', ':(top)**']),
      { taskId: 'task', cwd: base, category: 'GIT', shellText: 'git status', env: {} } as SpawnRequest,
    ]) {
      await expect(spawner.spawn(r)).rejects.toThrow();
    }
  });
  it('supports exact snapshot commit-parent and raw-tree verification', async () => {
    const head = git(['rev-parse', 'HEAD']).trim();
    const parent = await spawner.spawn(
      request(['show', '--format=%P', '--no-patch', '--no-show-signature', head, '--']),
    );
    expect(parent.exitCode).toBe(0);
    expect(
      (
        await spawner.spawn(
          request([
            'diff',
            '--raw',
            '-z',
            '--no-renames',
            '--no-abbrev',
            '--no-ext-diff',
            '--no-textconv',
            '--ignore-submodules=none',
            head,
            head,
            '--',
          ]),
        )
      ).stdout,
    ).toBe('');
  });
  it('creates only the registered worktree and checks its metadata pointer', async () => {
    const worktree = path.join(root, 'worktree');
    spawner = new TrustedGitSpawner({
      contextForTask: () => ({ basePath: base, worktreePath: worktree, owner: 'fixture', name: 'smoke' }),
      secrets: new FileSecretProvider(path.join(root, 'secrets')),
    });
    expect(
      (await spawner.spawn(request(['worktree', 'add', '-b', 'fix/test', worktree, git(['rev-parse', 'HEAD']).trim()])))
        .exitCode,
    ).toBe(0);
    expect((await spawner.spawn(request(['rev-parse', 'HEAD'], { cwd: worktree }))).exitCode).toBe(0);
    await writeFile(path.join(worktree, '.git'), 'gitdir: ' + path.join(root, 'other') + '\n');
    await expect(spawner.spawn(request(['rev-parse', 'HEAD'], { cwd: worktree }))).rejects.toThrow();
  });
  it('admits only the registered default remote branch as worktree base', async () => {
    const worktree = path.join(root, 'remote-worktree');
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).trim()]);
    git(['update-ref', 'refs/remotes/origin/other', git(['rev-parse', 'HEAD']).trim()]);
    const context = { basePath: base, worktreePath: worktree, owner: 'fixture', name: 'smoke', defaultBranch: 'main' };
    spawner = new TrustedGitSpawner({
      contextForTask: () => context,
      secrets: new FileSecretProvider(path.join(root, 'secrets')),
    });
    await expect(
      spawner.spawn(request(['worktree', 'add', '-b', 'fix/other', worktree, 'origin/other'])),
    ).rejects.toThrow();
    expect(
      (await spawner.spawn(request(['worktree', 'add', '-b', 'fix/default', worktree, 'origin/main']))).exitCode,
    ).toBe(0);
    expect((await spawner.spawn(request(['rev-parse', 'HEAD'], { cwd: worktree }))).stdout.trim()).toBe(
      git(['rev-parse', 'HEAD']).trim(),
    );
  });
  it('rejects a malformed registered default branch', async () => {
    const worktree = path.join(root, 'bad-worktree');
    const context = {
      basePath: base,
      worktreePath: worktree,
      owner: 'fixture',
      name: 'smoke',
      defaultBranch: 'main:evil',
    };
    spawner = new TrustedGitSpawner({
      contextForTask: () => context,
      secrets: new FileSecretProvider(path.join(root, 'secrets')),
    });
    await expect(
      spawner.spawn(request(['worktree', 'add', '-b', 'fix/bad', worktree, 'origin/main:evil'])),
    ).rejects.toThrow();
  });
  it('rejects redirected origin and Git metadata', async () => {
    git(['remote', 'set-url', 'origin', 'https://evil.invalid/fixture/smoke.git']);
    await expect(spawner.spawn(request(['rev-parse', 'HEAD']))).rejects.toThrow();
  });
});

it('reaps a real TERM-ignoring Git helper before timeout settles', async () => {
  const marker = path.join(root, 'descendant-pid');
  const helper = path.join(root, 'helper.cjs');
  await writeFile(
    helper,
    `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
  );
  const alias = `!${process.execPath} ${helper} & wait`;
  try {
    await expect(
      superviseTrustedGit(
        base,
        ['-c', `alias.fixture=${alias}`, 'fixture'],
        { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow();
    const pid = Number(await readFile(marker, 'utf8'));
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'gone');
    expect(stat === 'gone' || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')).toBe(true);
  } finally {
    const pid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    if (pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

it('reports cleanup quarantine once without allowing a diagnostic failure to settle the operation early', async () => {
  const inspect = vi.spyOn(filePromises, 'readdir').mockRejectedValueOnce(new Error('synthetic inspection denial'));
  syncBuiltinESMExports();
  const report = vi.fn(() => { throw new Error('synthetic diagnostic sink failure'); });
  try {
    const started = Date.now();
    const result = await superviseTrustedGit(base, ['rev-parse', 'HEAD'], { PATH: '/usr/bin:/bin' }, { onQuarantine: report });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(report).toHaveBeenCalledExactlyOnceWith();
  } finally { inspect.mockRestore(); syncBuiltinESMExports(); }
});
it('rolls back only its exact registered worktree', async () => {
  const worktree = path.join(root, 'rollback');
  spawner = new TrustedGitSpawner({
    contextForTask: () => ({ basePath: base, worktreePath: worktree, owner: 'fixture', name: 'smoke' }),
    secrets: new FileSecretProvider(path.join(root, 'secrets')),
  });
  git(['worktree', 'add', '-b', 'fix/rollback', worktree, 'HEAD']);
  await expect(spawner.spawn(request(['worktree', 'remove', '--force', base]))).rejects.toThrow();
  expect((await spawner.spawn(request(['worktree', 'remove', '--force', worktree]))).exitCode).toBe(0);
  expect((await spawner.spawn(request(['worktree', 'prune']))).exitCode).toBe(0);
});

it('redacts every synthetic credential representation from real Git transport output', async () => {
  const secretRoot = path.join(root, 'secrets');
  await mkdir(secretRoot);
  const token = 'synthetic-transport-canary';
  await writeFile(path.join(secretRoot, 'github.token'), token, { mode: 0o600 });
  const helper = path.join(root, 'echo-auth.cjs');
  await writeFile(
    helper,
    `const h=process.env.GRAM_GIT_AUTH_HEADER;const b=h.split(' ').pop();const t=Buffer.from(b,'base64').toString().split(':').slice(1).join(':');process.stdout.write(h+' '+b+' '+t);process.stderr.write(h+' '+b+' '+t);`,
  );
  const provider = new FileSecretProvider(secretRoot);
  const result = await superviseAuthenticatedGit(
    base,
    ['-c', `alias.fixture=!${process.execPath} ${helper}`, 'fixture'],
    { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
    provider,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('[REDACTED] [REDACTED] [REDACTED]');
  expect(result.stderr).toBe(result.stdout);
});
it('holds the real provider lease until TERM-ignoring authenticated helper is quiescent on overflow', async () => {
  const secretRoot = path.join(root, 'secrets');
  await mkdir(secretRoot);
  await writeFile(path.join(secretRoot, 'github.token'), 'synthetic-overflow-canary', { mode: 0o600 });
  const marker = path.join(root, 'authenticated-pid');
  const helper = path.join(root, 'overflow.cjs');
  await writeFile(
    helper,
    `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(4096)),10);`,
  );
  const real = new FileSecretProvider(secretRoot);
  let disposed = false;
  let disposedWhileLive = false;
  const provider = {
    async getForUse(name: string) {
      const lease = await real.getForUse(name);
      return {
        withValue: lease.withValue.bind(lease),
        dispose() {
          const pid = Number(readFileSync(marker, 'utf8'));
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            disposedWhileLive = !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
          } catch {
            /* gone */
          }
          disposed = true;
          lease.dispose();
        },
      };
    },
  };
  try {
    await expect(
      superviseAuthenticatedGit(
        base,
        ['-c', `alias.fixture=!${process.execPath} ${helper} & wait`, 'fixture'],
        { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
        provider,
        { maxOutputBytes: 1024, timeoutMs: 2000 },
      ),
    ).rejects.toThrow('Trusted Git execution failed');
    const pid = Number(await readFile(marker, 'utf8'));
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'gone');
    expect(stat === 'gone' || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')).toBe(true);
    expect(disposed).toBe(true);
    expect(disposedWhileLive).toBe(false);
  } finally {
    const pid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    if (pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});
it('does not prune unrelated stale metadata', async () => {
  const own = path.join(root, 'own');
  const other = path.join(root, 'other');
  git(['worktree', 'add', '-b', 'fix/unrelated', other, 'HEAD']);
  await rm(other, { recursive: true });
  spawner = new TrustedGitSpawner({
    contextForTask: () => ({ basePath: base, worktreePath: own, owner: 'fixture', name: 'smoke' }),
    secrets: new FileSecretProvider(path.join(root, 'secrets')),
  });
  await expect(spawner.spawn(request(['worktree', 'prune']))).rejects.toThrow();
  expect(git(['worktree', 'list', '--porcelain'])).toContain(other);
});

describe('RemoteService origin confirmation contract', () => {
  it.each(['origin', 'https://github.com/fixture/smoke.git', 'https://github.com/fixture/smoke'])(
    'confirms through real metadata and credential admission for %s', async (remote) => {
      const head = git(['rev-parse', 'HEAD']).trim();
      const ref = 'refs/heads/fix/task-000008-counter';
      const secretRoot = path.join(root, 'confirmation-secrets');
      await mkdir(secretRoot);
      await writeFile(path.join(secretRoot, 'github.token'), 'synthetic-confirmation-token', { mode: 0o600 });
      const provider = new FileSecretProvider(secretRoot);
      const acquire = vi.spyOn(provider, 'getForUse');
      const boundary = new TrustedGitSpawner({
        contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }), secrets: provider,
      });
      const originalSpawn = childProcess.spawn;
      const transports: string[][] = [];
      // Only the external network transport is substituted. Git metadata/config reads
      // and credential acquisition use the real repository and FileSecretProvider.
      const transport = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
        if (Array.isArray(args) && args.includes('ls-remote')) {
          transports.push([...args]);
          return originalSpawn('/usr/bin/printf', ['%s', `${head}\t${ref}\n`], options);
        }
        return originalSpawn(command, args, options);
      });
      syncBuiltinESMExports();
      try {
        const service = new RemoteService({ run: async (command) => boundary.spawn({ ...command, env: {} } as SpawnRequest) }, { taskId: 'task' }, base);
        expect(await service.confirmRemoteSha(remote, 'fix/task-000008-counter', head)).toBe(true);
        expect(await service.confirmRemoteSha(remote, 'fix/task-000008-counter', '0'.repeat(40))).toBe(false);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(transports).toHaveLength(2);
        for (const args of transports) {
          const index = args.indexOf('ls-remote');
          expect(args.slice(index)).toEqual(['ls-remote', remote === 'origin' ? 'https://github.com/fixture/smoke.git' : remote, ref]);
          expect(args.join(' ')).not.toContain('synthetic-confirmation-token');
        }
      } finally { transport.mockRestore(); acquire.mockRestore(); syncBuiltinESMExports(); }
    },
  );

  it.each([
    ['remote.origin.url', 'https://github.com/attacker/other.git'],
    ['url.https://attacker.invalid/.insteadOf', 'https://github.com/'],
    ['include.path', '/nonexistent/included-config'],
  ])('rejects unsafe origin configuration %s before acquiring a credential', async (key, value) => {
    git(['config', key, value]);
    const provider = new FileSecretProvider(path.join(root, 'never-read-secrets'));
    const acquire = vi.spyOn(provider, 'getForUse');
    const boundary = new TrustedGitSpawner({ contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }), secrets: provider });
    try {
      await expect(boundary.spawn(request(['ls-remote', 'origin', 'refs/heads/fix/task-000008-counter']))).rejects.toThrow();
      expect(acquire).not.toHaveBeenCalled();
    } finally { acquire.mockRestore(); }
  });

  it.each([
    ['ls-remote', 'other', 'refs/heads/main'],
    ['ls-remote', 'https://github.com/attacker/other.git', 'refs/heads/main'],
    ['ls-remote', 'origin', 'refs/tags/main'],
    ['ls-remote', 'origin', 'refs/heads/--upload-pack=evil'],
    ['ls-remote', 'origin', 'refs/heads/main', '--upload-pack=evil'],
    ['ls-remote', '--heads', 'origin', 'refs/heads/main'],
  ])('refuses unregistered confirmation selector %j without a credential', async (...args) => {
    const provider = new FileSecretProvider(path.join(root, 'never-read-secrets'));
    const acquire = vi.spyOn(provider, 'getForUse');
    const boundary = new TrustedGitSpawner({ contextForTask: () => ({ basePath: base, owner: 'fixture', name: 'smoke' }), secrets: provider });
    try {
      await expect(boundary.spawn(request(args))).rejects.toThrow();
      expect(acquire).not.toHaveBeenCalled();
    } finally { acquire.mockRestore(); }
  });
});
