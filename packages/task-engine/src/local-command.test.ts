import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditRepository, CommandRunRepository, openDatabase, RepositoryRepository, runMigrations, TaskRepository, WorkspaceRepository } from '@gram/persistence';
import { canTransitionTaskStatus } from '@gram/domain';
import { LocalCommandDispatcher } from './local-command.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const clean of cleanup.splice(0)) clean(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gram-local-command-'));const db = openDatabase(join(dir, 'state.db'));runMigrations(db);
  cleanup.push(() => { db.close();rmSync(dir, { recursive: true, force: true }); });
  const tasks = new TaskRepository(db), repositories = new RepositoryRepository(db), workspaces = new WorkspaceRepository(db), runs = new CommandRunRepository(db);
  const repo = repositories.upsert({ githubRepositoryId: 7, owner: 'fixture', name: 'repo', localBasePath: '/fixture', defaultBranch: 'main', packageManager: 'npm', commands: { test: 'npm run test' } });
  let owned = false;let released = false;let exitCode = 0;let forged = false;let prepareError = false;
  const dispatcher = new LocalCommandDispatcher({ tasks, repositories, workspaces, commandRuns: runs, audit: new AuditRepository(db),
    locks: { acquire: async (_repoId, taskId) => { owned = true;tasks.transition(taskId, 'WAITING_REPO_LOCK', 'PREPARING');return { release: async () => { released = true;owned = false; } }; } },
    ownsLease: () => owned,
    prepare: async taskId => { if (prepareError) throw new Error('fixture error');workspaces.create({ taskId, repoId: 7, linuxPath: '/fixture/task', branch: 'chore/local' }); },
    execute: async request => {
      const id = runs.start({ taskId: request.taskId, category: 'DEVELOPMENT', cwd: request.cwd, executable: request.executable, args: request.args });
      runs.finish(id, { status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode });
      return { commandRunId: forged ? id + 100 : id, exitCode, stdout: 'fixture output', stderr: '' };
    },
  });
  return { db, tasks, repositories, dispatcher, repo, released: () => released, setExit: (n: number) => { exitCode = n; }, forge: () => { forged = true; }, prepareError: () => { prepareError = true; } };
}
describe('local command dispatcher with real SQLite; execution port is a test fake, not isolation evidence', () => {
  it('persists LOCAL_COMMAND and genuine command evidence without coding verification or publication', async () => {
    const f = fixture();const result = await f.dispatcher.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 });
    expect(f.tasks.get(result.taskId)).toMatchObject({ taskType: 'LOCAL_COMMAND', status: 'COMPLETED' });
    expect(result).toMatchObject({ status: 'SUCCEEDED', exitCode: 0, stdout: 'fixture output' });expect(f.released()).toBe(true);
    expect(f.db.prepare('SELECT * FROM verification_plans').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM git_commits').all()).toEqual([]);
    expect(canTransitionTaskStatus('RUNNING', 'COMPLETED')).toBe(false);
  });
  it('keeps nonzero command outcomes FAILED and releases only after execution', async () => {
    const f = fixture();f.setExit(7);const result = await f.dispatcher.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 });
    expect(result.status).toBe('FAILED');expect(f.tasks.get(result.taskId)?.status).toBe('FAILED');expect(f.released()).toBe(true);
  });
  it('rejects arbitrary profile shell commands before creating a task', async () => {
    const f = fixture();f.repositories.upsert({ ...f.repo, commands: { test: 'npm test && arbitrary' } });
    await expect(f.dispatcher.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 })).rejects.toThrow();
    expect(f.db.prepare('SELECT * FROM tasks').all()).toEqual([]);
  });
  it('rejects forged command receipts and fails the task instead of completing', async () => {
    const f = fixture();f.forge();await expect(f.dispatcher.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 })).rejects.toThrow();
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'FAILED' });expect(f.released()).toBe(true);
  });
  it('marks preparation failure and releases the real held lane', async () => {
    const f = fixture();f.prepareError();await expect(f.dispatcher.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 })).rejects.toThrow();
    expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'FAILED' });expect(f.released()).toBe(true);
  });
});
