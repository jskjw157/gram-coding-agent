import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodingStepRepository, LockRepository, RepositoryRepository, TaskRepository, WorkspaceRepository, openDatabase, runMigrations } from '@gram/persistence';
import { FileService } from '@gram/filesystem';
import { createMcpHttpServer } from '@gram/mcp';
import { SecretRedactor } from '@gram/secrets';
import { ExternalCodingCapability } from './external-coding-capability.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach((f) => f()); cleanup.length = 0; });
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error('Expected value'); return value; }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function setup(stepTimeoutMs = 10000) {
  const root = mkdtempSync(join(tmpdir(), 'gram-capability-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, 'state.sqlite')); cleanup.push(() => db.close()); runMigrations(db);
  const repoId = 159;
  new RepositoryRepository(db).upsert({ githubRepositoryId: repoId, owner: 'fixture', name: 'repo', defaultBranch: 'main', localBasePath: root });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ repoId, goal: 'Change greeting', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
  const locks = new LockRepository(db);
  locks.acquireAndPrepare({ repoId, taskId: task.id, leaseToken: 'fixture-lease', acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 3600000).toISOString(), ownerPid: process.pid, ownerBootId: 'fixture' });
  tasks.transition(task.id, 'PREPARING', 'RUNNING');
  const workspaces = new WorkspaceRepository(db);
  const workspace = workspaces.create({ taskId: task.id, repoId, linuxPath: join(root, 'worktree'), branch: 'fix/task-source', headSha: 'a'.repeat(40) });
  mkdirSync(join(workspace.linuxPath, 'src'), { recursive: true });
  writeFileSync(join(workspace.linuxPath, 'AGENTS.md'), 'Use tests');
  writeFileSync(join(workspace.linuxPath, 'src/app.ts'), 'old');
  const steps = new CodingStepRepository(db);
  const options = { tasks, workspaces, locks, steps, ownsLease: () => true, redactor: new SecretRedactor(), stepTimeoutMs };
  const capability = new ExternalCodingCapability(options); cleanup.push(() => capability.close());
  const resolved = { taskId: task.id, repoId, branch: workspace.branch, remote: 'origin', localBasePath: root };
  return { root, db, task, tasks, locks, workspace, capability, steps, options, resolved };
}

async function analyze(f: ReturnType<typeof setup>) {
  const pending = f.capability.analyze({ task: f.resolved, workspace: f.workspace, instructions: { content: 'Use tests', source: 'AGENTS.md' } });
  const request = required(f.capability.get(f.task.id));
  f.capability.submit({ taskId: f.task.id, stepId: request.stepId, phase: 'ANALYZE', summary: 'Update greeting', files: ['src/app.ts'] });
  return pending;
}

describe('external coding capability', () => {
  it('requires instruction digest acknowledgment and reconnect preserves pending identity', async () => {
    const f = setup();
    const pending = f.capability.load(f.workspace, f.task.id);
    const step = required(f.capability.get(f.task.id));
    expect(step.phase).toBe('INSTRUCTIONS');
    expect(step.request).toMatchObject({ content: 'Use tests', source: 'AGENTS.md' });
    expect(f.capability.get(f.task.id)).toEqual(step);
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: '0'.repeat(64) })).toThrow();
    f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: String(step.request.digest) });
    await expect(pending).resolves.toEqual({ content: 'Use tests', source: 'AGENTS.md' });
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: String(step.request.digest) })).toThrow();
  });
  it('applies source edits only once through a task-bound modify step', async () => {
    const f = setup(); const analysis = await analyze(f);
    const pending = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis });
    const step = required(f.capability.get(f.task.id));
    const submission = { taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY' as const, patches: [{ path: 'src/app.ts', expectedSha256: hash('old'), content: 'new' }] };
    expect(f.capability.read(f.task.id, step.stepId, 'src/app.ts')).toEqual({ content: 'old', sha256: hash('old') });
    f.capability.submit(submission);
    await expect(pending).resolves.toEqual({ sha: 'a'.repeat(40) });
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('new');
    expect(() => f.capability.submit(submission)).toThrow();
    expect(f.steps.get(step.stepId)?.state).toBe('SUCCEEDED');
  });
  it('rejects wrong task, stale file, unauthorized file and symlink before any write', async () => {
    const f = setup(); const analysis = await analyze(f);
    const pending = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis });
    const step = required(f.capability.get(f.task.id));
    const submit = (path: string, expectedSha256 = hash('old'), taskId = f.task.id) => f.capability.submit({ taskId, stepId: step.stepId, phase: 'MODIFY', patches: [{ path, expectedSha256, content: 'new' }] });
    expect(() => submit('src/app.ts', hash('old'), randomUUID())).toThrow();
    expect(() => submit('src/app.ts', hash('stale'))).toThrow();
    expect(() => submit('src/other.ts')).toThrow();
    expect(() => f.capability.read(f.task.id, step.stepId, '../state.sqlite')).toThrow();
    symlinkSync(join(f.workspace.linuxPath, 'src/app.ts'), join(f.workspace.linuxPath, 'src/link.ts'));
    expect(() => f.capability.read(f.task.id, step.stepId, 'src/link.ts')).toThrow();
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('old');
    f.capability.fail(f.task.id, step.stepId); await expect(pending).rejects.toThrow('controller');
    expect(f.locks.get(159)?.ownerTaskId).toBe(f.task.id);
  });
  it('shutdown rejects pending waits without releasing the lock', async () => {
    const f = setup(); const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
    f.capability.close(); await expect(pending).rejects.toThrow('closed');
    expect(f.steps.get(step.stepId)?.state).toBe('INTERRUPTED');
    expect(f.locks.get(159)?.ownerTaskId).toBe(f.task.id);
  });
  it('rejects changed workspace and lost lease', async () => {
    const f = setup(); const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
    f.locks.release(159, 'fixture-lease');
    expect(() => f.capability.read(f.task.id, step.stepId, 'src/app.ts')).toThrow();
    f.capability.close(); await expect(pending).rejects.toThrow();
  });
});

it('expires unanswered steps and preserves repository ownership', async () => {
  const f = setup(20); const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
  await expect(pending).rejects.toThrow('timed out');
  expect(f.steps.get(step.stepId)?.state).toBe('FAILED');
  expect(f.capability.get(f.task.id)).toBeNull();
  expect(f.locks.get(159)?.ownerTaskId).toBe(f.task.id);
});
it('invalidates old-process identities instead of replaying interrupted steps', async () => {
  const f = setup(); const pending = f.capability.load(f.workspace, f.task.id); const old = required(f.capability.get(f.task.id));
  const restarted = new ExternalCodingCapability(f.options); cleanup.push(() => restarted.close());
  expect(f.steps.get(old.stepId)?.state).toBe('INTERRUPTED');
  expect(restarted.get(f.task.id)).toBeNull();
  expect(() => restarted.submit({ taskId: f.task.id, stepId: old.stepId, phase: 'INSTRUCTIONS', digest: String(old.request.digest) })).toThrow();
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: old.stepId, phase: 'INSTRUCTIONS', digest: String(old.request.digest) })).toThrow();
  f.capability.close(); await expect(pending).rejects.toThrow();
});
it('rejects recorded workspace replacement and canceled tasks', async () => {
  const f = setup(); const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
  f.db.prepare('UPDATE workspaces SET branch = ? WHERE task_id = ?').run('other-branch', f.task.id);
  expect(() => f.capability.read(f.task.id, step.stepId, 'src/app.ts')).toThrow();
  f.db.prepare('UPDATE workspaces SET branch = ? WHERE task_id = ?').run(f.workspace.branch, f.task.id);
  f.tasks.transition(f.task.id, 'RUNNING', 'FAILED');
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: String(step.request.digest) })).toThrow();
  f.capability.close(); await expect(pending).rejects.toThrow();
});
it('validates every patch before mutating any file', async () => {
  const f = setup();
  writeFileSync(join(f.workspace.linuxPath, 'src/other.ts'), 'second');
  const pending = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'two changes', files: ['src/app.ts', 'src/other.ts'] } });
  const step = required(f.capability.get(f.task.id));
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [
    { path: 'src/app.ts', expectedSha256: hash('old'), content: 'new' },
    { path: 'src/other.ts', expectedSha256: hash('stale'), content: 'changed' },
  ] })).toThrow('Stale');
  expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('old');
  expect(f.steps.get(step.stepId)?.state).toBe('PENDING');
  f.capability.close(); await expect(pending).rejects.toThrow();
});
it('rejects empty or unchanged modifications and permits explicit new source files', async () => {
  const f = setup();
  const pending = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'new source', files: ['src/app.ts', 'src/new/deep.ts'] } });
  const step = required(f.capability.get(f.task.id));
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [] })).toThrow();
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [ { path: 'src/app.ts', expectedSha256: hash('old'), content: 'old' } ] })).toThrow('No-op');
  f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [ { path: 'src/new/deep.ts', expectedSha256: null, content: 'export {};' } ] });
  await pending;
  expect(readFileSync(join(f.workspace.linuxPath, 'src/new/deep.ts'), 'utf8')).toBe('export {};');
});
it('fails closed for credentials, Git metadata, hardlinks and oversized source', async () => {
  const f = setup(); const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
  for (const path of ['.git/config', '.github/workflows/run.yml', '.env.local', '.ssh/key', '/etc/passwd', 'src/../app.ts']) {
    expect(() => f.capability.read(f.task.id, step.stepId, path)).toThrow();
  }
  writeFileSync(join(f.workspace.linuxPath, 'src/sensitive.ts'), 'github_pat_abcdefghijklmnop');
  expect(() => f.capability.read(f.task.id, step.stepId, 'src/sensitive.ts')).toThrow('sensitive');
  linkSync(join(f.workspace.linuxPath, 'src/app.ts'), join(f.workspace.linuxPath, 'src/hardlink.ts'));
  expect(() => f.capability.read(f.task.id, step.stepId, 'src/hardlink.ts')).toThrow();
  writeFileSync(join(f.workspace.linuxPath, 'src/large.ts'), 'x'.repeat(262145));
  expect(() => f.capability.read(f.task.id, step.stepId, 'src/large.ts')).toThrow();
  f.capability.close(); await expect(pending).rejects.toThrow();
});
it('acknowledges actual absence of root instructions without inventing instructions', async () => {
  const f = setup(); rmSync(join(f.workspace.linuxPath, 'AGENTS.md'));
  const pending = f.capability.load(f.workspace, f.task.id); const step = required(f.capability.get(f.task.id));
  expect(step.request.content).toBe('');
  expect(step.request.source).toBe('AGENTS.md (absent)');
  f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: String(step.request.digest) });
  await expect(pending).resolves.toMatchObject({ source: 'AGENTS.md (absent)' });
});
it('completes real source editing across authenticated MCP requests and reconnects', async () => {
  const f = setup();
  const server = await createMcpHttpServer({ host: '127.0.0.1', port: 0, internalSecret: 'fixture-secret', codingCapability: f.capability });
  const flow = (async () => {
    const instructions = await f.capability.load(f.workspace, f.task.id);
    const analysis = await f.capability.analyze({ task: f.resolved, workspace: f.workspace, instructions });
    return f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis });
  })();
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-gram-agent-auth': 'fixture-secret',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const text = await response.text();
    const line = text.split('\n').find((value) => value.startsWith('data: '));
    if (line === undefined) throw new Error('Missing MCP result');
    const rpc = JSON.parse(line.slice(6)) as { error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(rpc.error).toBeUndefined(); expect(rpc.result.isError).not.toBe(true);
    const content = rpc.result.content[0]?.text;
    if (content === undefined) throw new Error('Missing MCP content');
    return JSON.parse(content) as Record<string, unknown>;
  }
  try {
    const first = await call('coding_step_get', { taskId: f.task.id });
    expect(first.phase).toBe('INSTRUCTIONS');
    const reconnect = await call('coding_step_get', { taskId: f.task.id });
    expect(reconnect.stepId).toBe(first.stepId);
    await call('coding_step_submit', { taskId: f.task.id, stepId: first.stepId, phase: 'INSTRUCTIONS', digest: (first.request as Record<string, unknown>).digest });
    const second = await call('coding_step_get', { taskId: f.task.id }); expect(second.phase).toBe('ANALYZE');
    await call('coding_step_submit', { taskId: f.task.id, stepId: second.stepId, phase: 'ANALYZE', summary: 'Update greeting', files: ['src/app.ts'] });
    const third = await call('coding_step_get', { taskId: f.task.id }); expect(third.phase).toBe('MODIFY');
    const read = await call('coding_step_read', { taskId: f.task.id, stepId: third.stepId, path: 'src/app.ts' });
    await call('coding_step_submit', { taskId: f.task.id, stepId: third.stepId, phase: 'MODIFY', patches: [{ path: 'src/app.ts', expectedSha256: read.sha256, content: 'new greeting' }] });
    await flow;
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('new greeting');
    expect(f.locks.get(159)?.ownerTaskId).toBe(f.task.id);
  } finally {
    f.capability.close(); await flow.catch(() => undefined); await server.close();
  }
});
it('marks partial IO failure terminal and never replays mutation on retry', async () => {
  const f = setup();
  writeFileSync(join(f.workspace.linuxPath, 'src/second.ts'), 'second');
  const pending = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'two edits', files: ['src/app.ts', 'src/second.ts'] } });
  const rejected = expect(pending).rejects.toThrow('inspect workspace');
  const step = required(f.capability.get(f.task.id));
  const original = FileService.prototype.writeText;
  const failSecondWrite = vi.spyOn(FileService.prototype, 'writeText').mockImplementation(function (this: FileService, taskId, path, content) {
    if (path === 'src/second.ts') throw new Error('fixture disk failure');
    return original.call(this, taskId, path, content);
  });
  const submission = { taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY' as const, patches: [
    { path: 'src/app.ts', expectedSha256: hash('old'), content: 'new' },
    { path: 'src/second.ts', expectedSha256: hash('second'), content: 'changed' },
  ] };
  try {
    expect(() => f.capability.submit(submission)).toThrow('inspect workspace');
    await rejected;
    expect(f.steps.get(step.stepId)?.state).toBe('FAILED');
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('new');
    expect(readFileSync(join(f.workspace.linuxPath, 'src/second.ts'), 'utf8')).toBe('second');
    expect(() => f.capability.submit(submission)).toThrow('stale');
    expect(f.locks.get(159)?.ownerTaskId).toBe(f.task.id);
  } finally { failSecondWrite.mockRestore(); }
});
it('denies unrecognized credentials in hidden configuration stores for read, analysis and mutation', async () => {
  const f = setup();
  const paths = ['.git-credentials', '.gitconfig', '.pypirc', '.docker/config.json', '.config/gcloud/application_default_credentials.json', '.yarnrc.yml'];
  for (const path of paths) {
    const segments = path.split('/'); segments.pop();
    mkdirSync(join(f.workspace.linuxPath, ...segments), { recursive: true });
    writeFileSync(join(f.workspace.linuxPath, path), 'fixture-sensitive-value');
  }
  const analysisWait = f.capability.analyze({ task: f.resolved, workspace: f.workspace, instructions: { source: 'AGENTS.md', content: 'Use tests' } });
  void analysisWait.catch(() => undefined);
  const analysisStep = required(f.capability.get(f.task.id));
  for (const path of paths) {
    expect(() => f.capability.read(f.task.id, analysisStep.stepId, path), path).toThrow();
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: analysisStep.stepId, phase: 'ANALYZE', summary: 'edit', files: [path] }), path).toThrow();
  }
  f.capability.fail(f.task.id, analysisStep.stepId); await expect(analysisWait).rejects.toThrow();
  const mutationWait = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'edit', files: paths } });
  void mutationWait.catch(() => undefined);
  const mutationStep = required(f.capability.get(f.task.id));
  for (const path of paths) {
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: mutationStep.stepId, phase: 'MODIFY', patches: [{ path, expectedSha256: hash('fixture-sensitive-value'), content: 'replacement' }] }), path).toThrow();
    expect(readFileSync(join(f.workspace.linuxPath, path), 'utf8')).toBe('fixture-sensitive-value');
  }
  f.capability.close(); await expect(mutationWait).rejects.toThrow();
});
it.each([['src/new', 'src/new/child.ts'], ['src/new/child.ts', 'src/new']])('rejects prefix-conflicting patch batch %j before creating any file', async (...paths: string[]) => {
  const f = setup();
  const wait = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'create', files: paths } });
  const step = required(f.capability.get(f.task.id));
  const rejection = wait.catch(() => undefined);
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: paths.map((path) => ({ path, expectedSha256: null, content: 'new' })) })).toThrow('Conflicting');
  expect(() => readFileSync(join(f.workspace.linuxPath, 'src/new'))).toThrow();
  expect(f.steps.get(step.stepId)?.state).toBe('PENDING');
  f.capability.close(); await rejection;
});
it('rejects invalid UTF8 byte aliases and ill-formed replacement strings', async () => {
  const f = setup();
  writeFileSync(join(f.workspace.linuxPath, 'src/app.ts'), Buffer.from([0x80]));
  const wait = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'edit', files: ['src/app.ts'] } });
  void wait.catch(() => undefined);
  const step = required(f.capability.get(f.task.id));
  expect(() => f.capability.read(f.task.id, step.stepId, 'src/app.ts')).toThrow();
  writeFileSync(join(f.workspace.linuxPath, 'src/app.ts'), Buffer.from([0x81]));
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [{ path: 'src/app.ts', expectedSha256: hash('\uFFFD'), content: 'replacement' }] })).toThrow();
  expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'))).toEqual(Buffer.from([0x81]));
  writeFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'old');
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [{ path: 'src/app.ts', expectedSha256: hash('old'), content: '\uD800' }] })).toThrow();
  f.capability.close(); await expect(wait).rejects.toThrow();
});
it.each(['changed', 'removed', 'created'])('rejects %s instruction snapshots at acknowledgment', async (change) => {
  const f = setup();
  const path = join(f.workspace.linuxPath, 'AGENTS.md');
  if (change === 'created') rmSync(path);
  const wait = f.capability.load(f.workspace, f.task.id); void wait.catch(() => undefined);
  const step = required(f.capability.get(f.task.id));
  if (change === 'removed') rmSync(path); else writeFileSync(path, 'New instructions');
  expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'INSTRUCTIONS', digest: String(step.request.digest) })).toThrow();
  expect(f.steps.get(step.stepId)?.state).toBe('PENDING');
  f.capability.close(); await expect(wait).rejects.toThrow();
});
it('rechecks task lease after validation before claiming the result', async () => {
  const f = setup();
  const wait = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'edit', files: ['src/app.ts'] } });
  void wait.catch(() => undefined);
  const step = required(f.capability.get(f.task.id));
  const original = FileService.prototype.readTextStrict;
  const expireAfterRead = vi.spyOn(FileService.prototype, 'readTextStrict').mockImplementation(function (this: FileService, taskId, path) {
    const result = original.call(this, taskId, path);
    f.db.prepare('UPDATE repo_locks SET lease_until = ?').run('2000-01-01T00:00:00.000Z');
    return result;
  });
  try {
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [{ path: 'src/app.ts', expectedSha256: hash('old'), content: 'new' }] })).toThrow('lease');
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('old');
    expect(f.steps.get(step.stepId)?.state).toBe('PENDING');
  } finally { expireAfterRead.mockRestore(); f.capability.close(); await wait.catch(() => undefined); }
});
it('stops between writes when lease ownership is lost, preserving uncertain failure', async () => {
  const f = setup(); writeFileSync(join(f.workspace.linuxPath, 'src/second.ts'), 'second');
  const wait = f.capability.modify({ task: f.resolved, workspace: f.workspace, analysis: { summary: 'edit', files: ['src/app.ts', 'src/second.ts'] } });
  void wait.catch(() => undefined);
  const step = required(f.capability.get(f.task.id));
  const original = FileService.prototype.writeText;
  const expireAfterWrite = vi.spyOn(FileService.prototype, 'writeText').mockImplementation(function (this: FileService, taskId, path, content) {
    original.call(this, taskId, path, content);
    f.db.prepare('UPDATE repo_locks SET lease_until = ?').run('2000-01-01T00:00:00.000Z');
  });
  try {
    expect(() => f.capability.submit({ taskId: f.task.id, stepId: step.stepId, phase: 'MODIFY', patches: [
      { path: 'src/app.ts', expectedSha256: hash('old'), content: 'new' },
      { path: 'src/second.ts', expectedSha256: hash('second'), content: 'changed' },
    ] })).toThrow('inspect workspace');
    await expect(wait).rejects.toThrow('inspect workspace');
    expect(readFileSync(join(f.workspace.linuxPath, 'src/app.ts'), 'utf8')).toBe('new');
    expect(readFileSync(join(f.workspace.linuxPath, 'src/second.ts'), 'utf8')).toBe('second');
    expect(f.steps.get(step.stepId)?.state).toBe('FAILED');
  } finally { expireAfterWrite.mockRestore(); f.capability.close(); await wait.catch(() => undefined); }
});
