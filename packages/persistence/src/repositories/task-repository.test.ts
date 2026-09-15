import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import { ConcurrentTaskTransitionError, TaskRepository } from './task-repository.js';

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
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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

    expect(tables).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
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
});
