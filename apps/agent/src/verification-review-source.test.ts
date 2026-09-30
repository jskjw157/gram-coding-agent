import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryRepository, TaskRepository, WorkspaceRepository, openDatabase, runMigrations, type VerificationSnapshot } from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { SecretRedactor } from '@gram/secrets';
import { createVerificationReviewCommandRunner } from './verification-review-command.js';
import { VerificationReviewSource } from './verification-review-source.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Missing fixture value'); return value; }
const blob = (value: string | Buffer) => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(before: string | Buffer = 'old\n', path = 'src/app.ts') {
  const root = mkdtempSync(join(tmpdir(), 'gram-review-source-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'worktree'); mkdirSync(cwd);
  git(cwd, 'init', '--initial-branch=main'); git(cwd, 'config', 'user.name', 'Gram Test'); git(cwd, 'config', 'user.email', 'gram@example.test');
  mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), before);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  const db = openDatabase(join(root, 'state.sqlite')); cleanup.push(() => db.close()); runMigrations(db);
  new RepositoryRepository(db).upsert({ githubRepositoryId: 159, owner: 'fixture', name: 'repo', defaultBranch: 'main', localBasePath: root });
  const task = new TaskRepository(db).create({ repoId: 159, goal: 'Review source', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  const workspaces = new WorkspaceRepository(db);
  workspaces.create({ taskId: task.id, repoId: 159, linuxPath: cwd, branch: 'fix/review' });
  const redactor = new SecretRedactor(['fixture-private-secret']);
  let id = 0;
  const runner = createVerificationReviewCommandRunner({ policy: new PolicyEngine(), approvals: { consume: async () => false },
    commandRuns: { start: () => ++id, finish: () => undefined }, homeDir: root, redactor });
  const source = new VerificationReviewSource({ runner, workspaces, redactor });
  const headSha = git(cwd, 'rev-parse', 'HEAD');
  const snapshot = (entries: VerificationSnapshot['entries']): VerificationSnapshot => ({ version: 1, taskId: task.id, headSha, entries });
  const changed = (content: string | Buffer = 'new\n', target = path, mode: '100644' | '100755' = '100644') => {
    mkdirSync(dirname(join(cwd, target)), { recursive: true }); writeFileSync(join(cwd, target), content); chmodSync(join(cwd, target), mode === '100644' ? 0o644 : 0o755);
    return snapshot([{ path: target, mode, oid: blob(content) }]);
  };
  return { root, cwd, taskId: task.id, source, runner, workspaces, redactor, snapshot, changed, path, headSha };
}

describe('bounded exact review source', () => {
  it('returns exact before and after bytes, modes, blob identities and a stable SHA256 digest', async () => {
    const f = fixture('\uFEFFold\r\n'); const snapshot = f.changed('after €\n', f.path, '100755');
    const view = await f.source.read(f.taskId, snapshot, f.path);
    expect(view).toEqual({ path: f.path,
      before: { present: true, mode: '100644', oid: blob('\uFEFFold\r\n'), content: '\uFEFFold\r\n' },
      after: { present: true, mode: '100755', oid: blob('after €\n'), content: 'after €\n' }, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await f.source.read(f.taskId, snapshot, f.path)).digest).toBe(view.digest);
    expect(Object.isFrozen(view)).toBe(true);
  });
  it('proves new-file absence and deletion absence, distinguishing either from an empty file', async () => {
    const f = fixture(''); const added = f.changed('', 'new.ts');
    const view = await f.source.read(f.taskId, added, 'new.ts');
    expect(view.before).toEqual({ present: false, mode: '000000', oid: null, content: null });
    expect(view.after).toEqual({ present: true, mode: '100644', oid: blob(''), content: '' });
    rmSync(join(f.cwd, f.path));
    const deleted = await f.source.read(f.taskId, f.snapshot([{ path: f.path, mode: '000000', oid: null }]), f.path);
    expect(deleted.before).toEqual({ present: true, mode: '100644', oid: blob(''), content: '' });
    expect(deleted.after).toEqual({ present: false, mode: '000000', oid: null, content: null });
    expect(view.digest).not.toBe(deleted.digest);
  });
  it('binds the digest to the full snapshot context as well as the selected view', async () => {
    const f = fixture(); const snapshot = f.changed();
    const first = await f.source.read(f.taskId, snapshot, f.path);
    const second = await f.source.read(f.taskId, { ...snapshot, entries: [...snapshot.entries, { path: 'z.ts', mode: '100644', oid: blob('unrelated') }] }, f.path);
    expect(second.digest).not.toBe(first.digest);
  });
  it('uses task-attributed fixed metadata and verified blob reads without persisting source', async () => {
    const f = fixture(); const calls = vi.spyOn(f.runner, 'run');
    await f.source.read(f.taskId, f.changed(), f.path);
    expect(calls.mock.calls.every(([request]) => request.taskId === f.taskId && request.cwd === f.cwd && request.executable === 'git')).toBe(true);
    expect(calls.mock.calls.some(([request]) => JSON.stringify(request.args) === JSON.stringify(['rev-parse', '--verify', `${f.headSha}:${f.path}`]))).toBe(true);
    expect(calls.mock.calls.some(([request]) => JSON.stringify(request.args) === JSON.stringify(['show', blob('old\n')]))).toBe(true);
    for (const result of calls.mock.results) {
      const command = await result.value;
      expect(readFileSync(command.stdoutPath, 'utf8')).not.toContain('old\\n');
    }
  });
  it.each(['../outside', '.env', '.config/file', 'src/credentials.json', 'src/secret.txt', 'src/id_rsa', 'key.pem', 'a\\b', ':path', '-option', 'a\nb', '/absolute', 'a/*', 'a//b', 'a/./b', 'invalid\uD800.ts'])('rejects unsafe source path %j before issuing a command', async (path) => {
    const f = fixture(); const calls = vi.spyOn(f.runner, 'run');
    await expect(f.source.read(f.taskId, f.snapshot([{ path, mode: '100644', oid: blob('x') }]), path)).rejects.toThrow(/path/i);
    expect(calls).not.toHaveBeenCalled();
  });
  it.each(['foreign-task', 'noncandidate', 'invalid-head', 'wrong-oid', 'wrong-mode', 'wrong-absence', 'duplicate'])('rejects %s snapshot evidence', async (variant) => {
    const f = fixture(); const snapshot = f.changed();
    let path = f.path;
    if (variant === 'foreign-task') snapshot.taskId = 'other';
    if (variant === 'noncandidate') path = 'other.ts';
    if (variant === 'invalid-head') snapshot.headSha = 'HEAD';
    if (variant === 'wrong-oid') required(snapshot.entries[0]).oid = blob('wrong');
    if (variant === 'wrong-mode') required(snapshot.entries[0]).mode = '100755';
    if (variant === 'wrong-absence') snapshot.entries[0] = { path, mode: '000000', oid: null };
    if (variant === 'duplicate') snapshot.entries.push({ ...required(snapshot.entries[0]) });
    await expect(f.source.read(f.taskId, snapshot, path)).rejects.toThrow();
  });
  it.each(['symlink', 'ancestor-symlink', 'hardlink', 'directory'])('rejects an after %s', async (kind) => {
    const f = fixture(); const snapshot = f.changed();
    if (kind === 'ancestor-symlink') { rmSync(join(f.cwd, 'src'), { recursive: true }); symlinkSync(f.root, join(f.cwd, 'src')); }
    else { rmSync(join(f.cwd, f.path)); if (kind === 'symlink') symlinkSync('/etc/passwd', join(f.cwd, f.path));
      if (kind === 'directory') mkdirSync(join(f.cwd, f.path));
      if (kind === 'hardlink') { writeFileSync(join(f.root, 'external'), 'new\n'); linkSync(join(f.root, 'external'), join(f.cwd, f.path)); } }
    await expect(f.source.read(f.taskId, snapshot, f.path)).rejects.toThrow();
  });
  it.each(['before', 'after'])('rejects %s symlinks or tree objects rather than reviewing targets', async (side) => {
    const f = fixture();
    if (side === 'before') { rmSync(join(f.cwd, f.path)); symlinkSync('/etc/passwd', join(f.cwd, f.path)); }
    else { rmSync(join(f.cwd, f.path)); mkdirSync(join(f.cwd, f.path)); writeFileSync(join(f.cwd, f.path, 'child'), 'nested'); }
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'unsupported historical object');
    rmSync(join(f.cwd, f.path), { recursive: true });
    const snapshot = { ...f.changed(), headSha: git(f.cwd, 'rev-parse', 'HEAD') };
    await expect(f.source.read(f.taskId, snapshot, f.path)).rejects.toThrow(/mode|tree|metadata|regular/i);
  });
  it.each([
    ['binary', Buffer.from([0, 1, 2])], ['invalid UTF8', Buffer.from([0xff])],
    ['secret', 'fixture-private-secret'], ['oversized', 'a'.repeat(256 * 1024 + 1)],
  ])('rejects %s text on either side', async (_label, content) => {
    const before = fixture(content); await expect(before.source.read(before.taskId, before.changed(), before.path)).rejects.toThrow();
    const after = fixture(); await expect(after.source.read(after.taskId, after.changed(content), after.path)).rejects.toThrow();
  });
  it('accepts the exact byte limit without truncation', async () => {
    const text = 'x'.repeat(256 * 1024); const f = fixture(text);
    const view = await f.source.read(f.taskId, f.changed(text), f.path);
    expect(view.before.content).toBe(text); expect(view.after.content).toBe(text);
  });
  it('does not treat a failed metadata read as historical absence', async () => {
    const f = fixture(); const snapshot = f.changed('new', 'new.ts'); snapshot.headSha = 'a'.repeat(40);
    await expect(f.source.read(f.taskId, snapshot, 'new.ts')).rejects.toThrow();
  });
  it('verifies returned blob text locally rather than trusting the command output', async () => {
    const f = fixture(); const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, 'run').mockImplementation(async (request) => {
      const result = await run(request); return request.args?.[0] === 'show' ? { ...result, stdout: 'forged text' } : result;
    });
    await expect(f.source.read(f.taskId, f.changed(), f.path)).rejects.toThrow(/blob|identity/i);
  });
  it('rejects workspace/source drift across asynchronous object reads', async () => {
    const f = fixture(); const run = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, 'run').mockImplementation(async (request) => {
      const result = await run(request); if (request.args?.[0] === 'show') writeFileSync(join(f.cwd, f.path), 'mutated'); return result;
    });
    await expect(f.source.read(f.taskId, f.changed(), f.path)).rejects.toThrow(/snapshot|changed|drift/i);
  });
});

it('rejects a nested working directory recorded as the repository root', async () => {
  const f = fixture(); const snapshot = f.changed('new', 'src/src/app.ts');
  vi.spyOn(f.workspaces, 'getByTaskId').mockReturnValue({ ...required(f.workspaces.getByTaskId(f.taskId)), linuxPath: join(f.cwd, 'src') });
  const nested = { ...snapshot, entries: [{ path: 'src/app.ts', mode: '100644' as const, oid: blob('new') }] };
  await expect(f.source.read(f.taskId, nested, 'src/app.ts')).rejects.toThrow(/repository root/i);
});

it('reads the immutable historical object even when repository replace refs are present', async () => {
  const f = fixture('original head source\n');
  writeFileSync(join(f.cwd, f.path), 'replacement head source\n'); git(f.cwd, 'add', '.');
  const tree = git(f.cwd, 'write-tree');
  const replacement = git(f.cwd, 'commit-tree', tree, '-m', 'replacement');
  git(f.cwd, 'replace', f.headSha, replacement);
  const view = await f.source.read(f.taskId, f.changed(), f.path);
  expect(view.before.content).toBe('original head source\n');
});
