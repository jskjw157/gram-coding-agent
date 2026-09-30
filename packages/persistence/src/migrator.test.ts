import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { runMigrations } from './migrator.js';
import { TaskRepository } from './repositories/task-repository.js';

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'gram-coding-migrations-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'state.db'));
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let directory: string | undefined;
  while ((directory = directories.pop()) !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('coding step migrations', () => {
  it('creates identity-only coding step storage on a fresh database', () => {
    const db = database();
    runMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
    ]);
    const columns = db.pragma('table_info(coding_steps)') as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      'id', 'task_id', 'workspace_id', 'workspace_path', 'branch', 'phase',
      'run_id', 'state', 'created_at', 'updated_at', 'expires_at', 'finished_at',
    ]);
    const foreignKeys = db.pragma('foreign_key_list(coding_steps)') as Array<{ table: string }>;
    expect(new Set(foreignKeys.map(({ table }) => table))).toEqual(new Set(['tasks', 'workspaces']));
  });

  it('upgrades a version-one database without replacing existing data and is repeatable', () => {
    const db = database();
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;`);
    db.exec(readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)')
      .run('2026-09-01T00:00:00.000Z');
    const tasks = new TaskRepository(db);
    const task = tasks.create({ goal: 'retain this task', taskType: 'CODING', publishMode: 'PULL_REQUEST' });

    runMigrations(db);
    runMigrations(db);

    expect(tasks.get(task.id)).toEqual(task);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
    ]);
    expect(db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get())
      .toEqual({ applied_at: '2026-09-01T00:00:00.000Z' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coding_steps'").get())
      .toEqual({ name: 'coding_steps' });
  });
});
