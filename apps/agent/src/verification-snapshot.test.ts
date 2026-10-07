import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitService } from '@gram/git';
import type { VerificationSnapshot } from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { CommandRunner, NodeProcessSpawner, type SpawnRequest, type SpawnResult } from '@gram/shell';
import { TaskVerificationSnapshots } from './verification-snapshot.js';

const roots: string[] = [];
const taskId = 'task-snapshot-a';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-verification-snapshot-'));
  roots.push(root);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Gram Test');
  git(root, 'config', 'user.email', 'gram@example.test');
  for (const path of ['app.txt', 'deleted.txt', 'rename.txt', 'executable.sh']) {
    writeFileSync(join(root, path), `${path}\n`);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
}

function blob(value: string | Buffer): string {
  const bytes = Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function harness(root: string, intercept?: (request: SpawnRequest, result: SpawnResult) => SpawnResult) {
  const seen: SpawnRequest[] = [];
  const spawner = new NodeProcessSpawner();
  const workspaces = new Map([[taskId, { taskId, linuxPath: root }]]);
  let id = 0;
  const runner = new CommandRunner({
    policy: new PolicyEngine(),
    approvals: { consume: async () => { throw new Error('Unexpected approval request'); } },
    spawner: { spawn: async (request) => {
      seen.push(request);
      const result = await spawner.spawn(request);
      return intercept?.(request, result) ?? result;
    } },
    commandRuns: { start: () => ++id, finish: () => undefined },
    outputCapture: {
      redactText: (text) => text,
      capture: async ({ stdout, stderr }) => ({ stdout, stderr, stdoutPath: '/unused/stdout', stderrPath: '/unused/stderr' }),
    },
  });
  return {
    snapshots: new TaskVerificationSnapshots({ runner, workspaces: { getByTaskId: (id) => workspaces.get(id) } }),
    workspaces,
    runner,
    seen,
  };
}

function commit(root: string, paths: string[]): string {
  git(root, 'add', '--', ...paths);
  git(root, 'commit', '-m', 'verified change');
  return git(root, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TaskVerificationSnapshots.capture', () => {
  it('uses Git owner-executable-bit semantics rather than group or other execute permissions', async () => {
    const root = repository();
    writeFileSync(join(root, 'app.txt'), 'new bytes\n');
    chmodSync(join(root, 'app.txt'), 0o645);
    const { snapshots } = harness(root);
    const snapshot = await snapshots.capture(taskId);
    expect(snapshot.entries).toEqual([{ path: 'app.txt', mode: '100644', oid: blob('new bytes\n') }]);
    await expect(snapshots.assertCommitted(taskId, snapshot, ['app.txt'], commit(root, ['app.txt']))).resolves.toBeUndefined();
  });

  it('captures exact binary blobs, executable modes, deletions, both rename endpoints and nested untracked files', async () => {
    const root = repository();
    const { snapshots, seen } = harness(root);
    const binary = Buffer.from([0, 255, 254, 128, 10, 13]);
    writeFileSync(join(root, 'app.txt'), binary);
    rmSync(join(root, 'deleted.txt'));
    chmodSync(join(root, 'executable.sh'), 0o755);
    git(root, 'mv', 'rename.txt', 'renamed.txt');
    mkdirSync(join(root, 'new'));
    writeFileSync(join(root, 'new', 'with space.txt'), 'added\n');
    const snapshot = await snapshots.capture(taskId);
    expect(snapshot).toEqual({
      version: 1, taskId, headSha: git(root, 'rev-parse', 'HEAD'),
      entries: [
        { path: 'app.txt', mode: '100644', oid: blob(binary) },
        { path: 'deleted.txt', mode: '000000', oid: null },
        { path: 'executable.sh', mode: '100755', oid: blob('executable.sh\n') },
        { path: 'new/with space.txt', mode: '100644', oid: blob('added\n') },
        { path: 'rename.txt', mode: '000000', oid: null },
        { path: 'renamed.txt', mode: '100644', oid: blob('rename.txt\n') },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every(Object.isFrozen)).toBe(true);
    expect(seen.every((request) => request.taskId === taskId && request.cwd === root)).toBe(true);
    expect(seen.every((request) => ['rev-parse', 'status'].includes(request.args?.[0] ?? ''))).toBe(true);
    expect(seen.some((request) => request.args?.join(' ') === 'status --porcelain=v1 -z --untracked-files=all')).toBe(true);
  });

  it('resolves each concurrent task from its own current workspace record', async () => {
    const rootA = repository();
    const rootB = repository();
    const { snapshots, workspaces, seen } = harness(rootA);
    workspaces.set('task-b', { taskId: 'task-b', linuxPath: rootB });
    writeFileSync(join(rootA, 'app.txt'), 'task A\n');
    writeFileSync(join(rootB, 'app.txt'), 'task B\n');
    const [a, b] = await Promise.all([snapshots.capture(taskId), snapshots.capture('task-b')]);
    expect(a.entries[0]?.oid).toBe(blob('task A\n'));
    expect(b.entries[0]?.oid).toBe(blob('task B\n'));
    expect(seen.every((request) => request.cwd === (request.taskId === taskId ? rootA : rootB))).toBe(true);
    workspaces.set(taskId, { taskId, linuxPath: rootB });
    expect((await snapshots.capture(taskId)).entries).toEqual(b.entries);
  });

  it('fails closed for missing or foreign task workspace records', async () => {
    const { snapshots, workspaces } = harness(repository());
    await expect(snapshots.capture('missing')).rejects.toThrow(/workspace/i);
    workspaces.set(taskId, { taskId: 'another-task', linuxPath: repository() });
    await expect(snapshots.capture(taskId)).rejects.toThrow(/workspace/i);
  });

  it('rejects a nested directory presented as the repository workspace', async () => {
    const root = repository();
    mkdirSync(join(root, 'nested'));
    await expect(harness(join(root, 'nested')).snapshots.capture(taskId)).rejects.toThrow(/workspace/i);
  });

  it.each(['../outside', '/absolute', './app.txt', 'a/../app.txt', '.git/config', 'dir/.GIT/config', '-option', ':(glob)*', 'glob*', 'a\\b', 'line\nbreak', 'bad\ufffdname'])('rejects unsafe status paths %j before reading', async (path) => {
    const { snapshots } = harness(repository(), (request, result) => request.args?.[0] === 'status'
      ? { ...result, stdout: `?? ${path}\0` } : result);
    await expect(snapshots.capture(taskId)).rejects.toThrow(/path/i);
  });

  it('rejects a final symlink and does not expose its target bytes', async () => {
    const root = repository();
    symlinkSync('/etc/passwd', join(root, 'escape'));
    await expect(harness(root).snapshots.capture(taskId)).rejects.toThrow(/path|symlink/i);
  });

  it('rejects a symlink ancestor even for an absent deletion endpoint', async () => {
    const root = repository();
    symlinkSync('/tmp', join(root, 'linked'));
    const { snapshots } = harness(root, (request, result) => request.args?.[0] === 'status'
      ? { ...result, stdout: ' D linked/missing\0' } : result);
    await expect(snapshots.capture(taskId)).rejects.toThrow(/path|symlink/i);
  });

  it('rejects a candidate directory rather than treating it as a deleted file', async () => {
    const root = repository();
    mkdirSync(join(root, 'directory'));
    const { snapshots } = harness(root, (request, result) => request.args?.[0] === 'status'
      ? { ...result, stdout: '?? directory\0' } : result);
    await expect(snapshots.capture(taskId)).rejects.toThrow(/file|path/i);
  });

  it.each(['bytes', 'mode', 'head', 'paths', 'workspace'])('rejects %s drift during capture', async (drift) => {
    const root = repository();
    writeFileSync(join(root, 'app.txt'), 'before\n');
    let statusCount = 0;
    const h = harness(root, (request, result) => {
      if (request.args?.[0] === 'status' && ++statusCount === 2) {
        if (drift === 'bytes') writeFileSync(join(root, 'app.txt'), 'after!\n');
        if (drift === 'mode') chmodSync(join(root, 'app.txt'), 0o755);
        if (drift === 'head') git(root, 'commit', '--allow-empty', '-m', 'concurrent commit');
        if (drift === 'paths') writeFileSync(join(root, 'new.txt'), 'concurrent addition\n');
        if (drift === 'workspace') h.workspaces.set(taskId, { taskId, linuxPath: repository() });
        if (drift === 'paths') return { ...result, stdout: result.stdout + '?? new.txt\0' };
      }
      return result;
    });
    await expect(h.snapshots.capture(taskId)).rejects.toThrow(/changed|drift|workspace/i);
  });
});

describe('TaskVerificationSnapshots.assertCommitted', () => {
  it('compares snapshot entry values independently of object property insertion order', async () => {
    const root = repository();
    writeFileSync(join(root, 'app.txt'), 'verified\n');
    const { snapshots } = harness(root);
    const captured = await snapshots.capture(taskId);
    const snapshot = { ...captured, entries: captured.entries.map(({ path, mode, oid }) => ({ oid, mode, path })) };
    await expect(snapshots.assertCommitted(taskId, snapshot, ['app.txt'], commit(root, ['app.txt']))).resolves.toBeUndefined();
  });

  it('accepts the exact approved binary, executable, deletion, rename and added entries while excluding unrelated candidates', async () => {
    const root = repository();
    const { snapshots, seen } = harness(root);
    writeFileSync(join(root, 'app.txt'), Buffer.from([255, 0, 128]));
    chmodSync(join(root, 'executable.sh'), 0o755);
    rmSync(join(root, 'deleted.txt'));
    renameSync(join(root, 'rename.txt'), join(root, 'renamed.txt'));
    writeFileSync(join(root, 'added.txt'), 'added\n');
    writeFileSync(join(root, 'unrelated.txt'), 'leave uncommitted\n');
    const snapshot = await snapshots.capture(taskId);
    const approved = snapshot.entries.map(({ path }) => path).filter((path) => path !== 'unrelated.txt');
    const sha = commit(root, approved);
    await expect(snapshots.assertCommitted(taskId, snapshot, approved, sha)).resolves.toBeUndefined();
    expect(seen.some((request) => request.args?.includes('--format=%P'))).toBe(true);
    expect(seen.some((request) => request.args?.[0] === 'diff' && ['--raw', '-z', '--no-renames', '--no-abbrev'].every((flag) => request.args?.includes(flag)))).toBe(true);
    expect(seen.every((request) => request.taskId === taskId)).toBe(true);
  });

  it.each(['bytes', 'mode', 'extra', 'missing', 'wrong-parent', 'merge-parent'])('rejects committed %s drift', async (drift) => {
    const root = repository();
    const { snapshots } = harness(root);
    writeFileSync(join(root, 'app.txt'), 'verified\n');
    const snapshot = await snapshots.capture(taskId);
    if (drift === 'bytes') writeFileSync(join(root, 'app.txt'), 'unverified\n');
    if (drift === 'mode') chmodSync(join(root, 'app.txt'), 0o755);
    if (drift === 'extra') writeFileSync(join(root, 'extra.txt'), 'unreviewed\n');
    if (drift === 'missing') writeFileSync(join(root, 'app.txt'), 'app.txt\n');
    if (drift === 'wrong-parent') git(root, 'commit', '--allow-empty', '-m', 'intervening commit');
    git(root, 'add', '.');
    git(root, 'commit', '--allow-empty', '-m', 'publish candidate');
    let sha = git(root, 'rev-parse', 'HEAD');
    if (drift === 'merge-parent') {
      const other = git(root, 'commit-tree', `${snapshot.headSha}^{tree}`, '-p', snapshot.headSha, '-m', 'other parent');
      sha = git(root, 'commit-tree', `${sha}^{tree}`, '-p', snapshot.headSha, '-p', other, '-m', 'merge');
    }
    await expect(snapshots.assertCommitted(taskId, snapshot, ['app.txt'], sha)).rejects.toThrow(/commit|parent|snapshot/i);
  });

  it.each(['bytes', 'extra'])('rejects an actual pre-commit hook changing %s', async (drift) => {
    const root = repository();
    const { snapshots } = harness(root);
    writeFileSync(join(root, 'app.txt'), 'verified\n');
    const snapshot = await snapshots.capture(taskId);
    const target = drift === 'bytes' ? 'app.txt' : 'extra.txt';
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\nprintf 'hook bytes\\n' > ${target}\ngit add -- ${target}\n`, { mode: 0o755 });
    const sha = commit(root, ['app.txt']);
    await expect(snapshots.assertCommitted(taskId, snapshot, ['app.txt'], sha)).rejects.toThrow(/commit|snapshot/i);
  });

  it('fails closed when clean filters change the committed bytes', async () => {
    const root = repository();
    writeFileSync(join(root, '.gitattributes'), '*.txt text eol=lf\n');
    commit(root, ['.gitattributes']);
    writeFileSync(join(root, 'app.txt'), 'CRLF\r\n');
    const { snapshots } = harness(root);
    const snapshot = await snapshots.capture(taskId);
    await expect(snapshots.assertCommitted(taskId, snapshot, ['app.txt'], commit(root, ['app.txt']))).rejects.toThrow(/commit|snapshot/i);
  });

  it.each(['foreign-task', 'unsafe-path', 'unapproved-path', 'duplicate-path', 'invalid-sha'])('rejects %s evidence', async (invalid) => {
    const root = repository();
    const { snapshots } = harness(root);
    writeFileSync(join(root, 'app.txt'), 'verified\n');
    const snapshot: VerificationSnapshot = structuredClone(await snapshots.capture(taskId));
    let approved = ['app.txt'];
    let sha = commit(root, approved);
    if (invalid === 'foreign-task') snapshot.taskId = 'other';
    if (invalid === 'unsafe-path') {
      const entry = snapshot.entries[0];
      if (entry === undefined) throw new Error('expected a captured entry');
      entry.path = '../app.txt';
    }
    if (invalid === 'unapproved-path') approved = ['other.txt'];
    if (invalid === 'duplicate-path') approved = ['app.txt', 'app.txt'];
    if (invalid === 'invalid-sha') sha = '--invalid';
    await expect(snapshots.assertCommitted(taskId, snapshot, approved, sha)).rejects.toThrow();
  });
});


it('verifies publication of already staged rename and deletion through CommitService', async () => {
  const root = repository();
  git(root, 'mv', 'rename.txt', 'renamed.txt');
  git(root, 'rm', 'deleted.txt');
  const { snapshots, runner } = harness(root);
  const snapshot = await snapshots.capture(taskId);
  const paths = snapshot.entries.map((entry) => entry.path);
  const sha = await new CommitService(runner, { taskId }).commitExplicit(root, paths, 'reviewed move and removal');
  await expect(snapshots.assertCommitted(taskId, snapshot, paths, sha)).resolves.toBeUndefined();
});
