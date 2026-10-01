import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import { ConcurrentTaskTransitionError, TaskRepository, TaskRepositoryBindingConflictError } from './task-repository.js';
import { RepositoryRepository } from './repository-repository.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gram-persistence-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

function openMigrated(path: string) {
  const db = openDatabase(path);
  openDbs.push(db);
  runMigrations(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLite persistence foundation', () => {
  it('opens SQLite in WAL mode with foreign keys enabled', () => {
    const db = openMigrated(tempDatabasePath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates every approved core state table in the initial migration', () => {
    const db = openMigrated(tempDatabasePath());
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );

    for (const table of [
      'tasks',
      'task_steps',
      'command_runs',
      'repositories',
      'repo_locks',
      'workspaces',
      'verification_plans',
      'verification_checks',
      'git_commits',
      'pull_requests',
      'ci_runs',
      'policy_decisions',
      'approvals',
      'audit_events',
    ]) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('allocates unique contiguous display sequences across two repository instances', () => {
    const path = tempDatabasePath();
    const dbA = openMigrated(path);
    const dbB = openDatabase(path);
    openDbs.push(dbB);
    const repoA = new TaskRepository(dbA);
    const repoB = new TaskRepository(dbB);

    const tasks = Array.from({ length: 100 }, (_, index) =>
      (index % 2 === 0 ? repoA : repoB).create({
        goal: `task-${index}`,
        taskType: 'CODING',
        publishMode: 'PULL_REQUEST',
      }),
    );

    expect(new Set(tasks.map((task) => task.id)).size).toBe(100);
    expect(new Set(tasks.map((task) => task.seq)).size).toBe(100);
    expect(tasks.map((task) => task.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    for (const task of tasks) {
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(task.status).toBe('QUEUED');
    }
  });

  it('guards task state transitions against stale expected state', () => {
    const db = openMigrated(tempDatabasePath());
    const repo = new TaskRepository(db);
    const task = repo.create({ goal: 'guard transition', taskType: 'CODING', publishMode: 'PULL_REQUEST' });

    repo.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
    expect(repo.get(task.id)?.status).toBe('WAITING_REPO_LOCK');
    expect(() => repo.transition(task.id, 'QUEUED', 'PREPARING')).toThrow(ConcurrentTaskTransitionError);
  });

  it('lists waiting tasks before queued tasks by ascending priority and sequence without requiring repo_id', () => {
    const db = openMigrated(tempDatabasePath());
    const repo = new TaskRepository(db);

    const waitingLateLow = repo.create({ goal: 'w-late-low', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 2, repoSelector: 'acme/web' });
    const waitingLateLow2 = repo.create({ goal: 'w-late-low-2', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 2, repoSelector: 'acme/web' });
    const waitingLateHigh = repo.create({ goal: 'w-late-high', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 1, repoSelector: 'acme/web' });
    const queuedUrgent = repo.create({ goal: 'q-urgent', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 0, repoSelector: 'acme/web' });

    repo.transition(waitingLateLow.id, 'QUEUED', 'WAITING_REPO_LOCK');
    repo.transition(waitingLateLow2.id, 'QUEUED', 'WAITING_REPO_LOCK');
    repo.transition(waitingLateHigh.id, 'QUEUED', 'WAITING_REPO_LOCK');

    const runnable = (repo as unknown as { listRunnable(limit: number): Array<{ id: string }> }).listRunnable(10);

    expect(runnable.map((task) => task.id)).toEqual([
      waitingLateHigh.id,
      waitingLateLow.id,
      waitingLateLow2.id,
      queuedUrgent.id,
    ]);
  });

  it('caps waiting and queued candidates independently so lock contention cannot starve queued work', () => {
    const db = openMigrated(tempDatabasePath());
    const repo = new TaskRepository(db);

    const waiting = [1, 2, 3, 4].map((priority) => {
      const task = repo.create({ goal: `w-p${priority}`, taskType: 'CODING', publishMode: 'PULL_REQUEST', priority, repoSelector: 'acme/web' });
      repo.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
      return task;
    });
    const queuedHigh = repo.create({ goal: 'q-p1', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 1, repoSelector: 'acme/web' });
    const queuedLow = repo.create({ goal: 'q-p2', taskType: 'CODING', publishMode: 'PULL_REQUEST', priority: 2, repoSelector: 'acme/web' });

    const runnable = (repo as unknown as { listRunnable(limit: number): Array<{ id: string }> }).listRunnable(2);

    const firstWaiting = waiting[0];
    const secondWaiting = waiting[1];
    if (firstWaiting === undefined || secondWaiting === undefined) throw new Error('expected two waiting tasks');
    expect(runnable.map((task) => task.id)).toEqual([firstWaiting.id, secondWaiting.id, queuedHigh.id, queuedLow.id]);
  });

  it('binds a selector-only task to the resolved repository idempotently', () => {
    const db = openMigrated(tempDatabasePath());
    const tasks = new TaskRepository(db);
    const repos = new RepositoryRepository(db);
    repos.upsert({ githubRepositoryId: 123, owner: 'acme', name: 'web', defaultBranch: 'main', localBasePath: '/tmp/acme-web' });

    const task = tasks.create({ goal: 'bind me', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoSelector: 'acme/web' });
    expect(task.repoId).toBeNull();

    (tasks as unknown as { bindRepository(taskId: string, repoId: number): void }).bindRepository(task.id, 123);
    expect(tasks.get(task.id)?.repoId).toBe(123);

    (tasks as unknown as { bindRepository(taskId: string, repoId: number): void }).bindRepository(task.id, 123);
    expect(tasks.get(task.id)?.repoId).toBe(123);
  });

  it('rejects a concurrent binding to another repository and preserves the first binding', () => {
    const db = openMigrated(tempDatabasePath());
    const tasks = new TaskRepository(db);
    const repos = new RepositoryRepository(db);
    repos.upsert({ githubRepositoryId: 111, owner: 'acme', name: 'web', defaultBranch: 'main', localBasePath: '/tmp/acme-web' });
    repos.upsert({ githubRepositoryId: 222, owner: 'acme', name: 'api', defaultBranch: 'main', localBasePath: '/tmp/acme-api' });

    const task = tasks.create({ goal: 'race me', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoSelector: 'acme/web' });
    (tasks as unknown as { bindRepository(taskId: string, repoId: number): void }).bindRepository(task.id, 111);

    expect(() => (tasks as unknown as { bindRepository(taskId: string, repoId: number): void }).bindRepository(task.id, 222)).toThrow(TaskRepositoryBindingConflictError);
    expect(tasks.get(task.id)?.repoId).toBe(111);
  });
});
