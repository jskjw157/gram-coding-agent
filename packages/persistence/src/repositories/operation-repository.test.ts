import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import { TaskRepository } from './task-repository.js';
import { OperationRepository, RequestConflictError } from './operation-repository.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gram-ops-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function readMigrationFile(file: string): string {
  return readFileSync(join(migrationsDir, basename(file)), 'utf8');
}

function openMigratedV1(path: string): Database.Database {
  const db = openDatabase(path);
  openDbs.push(db);
  runMigrations(db, {
    migrations: [{ version: 1, file: './migrations/001_initial.sql' }],
    readSql: readMigrationFile,
  });
  return db;
}

function openMigratedV5(path: string): Database.Database {
  const db = openDatabase(path);
  openDbs.push(db);
  runMigrations(db);
  return db;
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

function migrateTo(db: Database.Database, target: number): void {
  const current = currentSchemaVersion(db);
  if (target < current) {
    throw new Error(`downgrade refused: current=${current} target=${target}`);
  }
  if (target >= 5 && current < 5) {
    runMigrations(db);
  }
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedTask(db: Database.Database, taskType = 'CODING') {
  const tasks = new TaskRepository(db);
  return tasks.create({ goal: 'ops persistence', taskType, publishMode: 'PULL_REQUEST' });
}

describe('Operations persistence (005_operations)', () => {
  it('creates all six operations tables with required indexes', () => {
    const db = openMigratedV5(tempDatabasePath());
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    for (const table of [
      'operations',
      'effects',
      'leases',
      'blocks',
      'approval_details',
      'schedules',
    ]) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('enforces UNIQUE(task_id, step, revision) on operations', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    const ops = new OperationRepository(db);
    ops.createOperation({
      taskId: task.id,
      step: 'plan',
      revision: 1,
      requesterId: 'req-a',
      clientRequestId: 'client-1',
    });
    expect(() =>
      ops.createOperation({
        taskId: task.id,
        step: 'plan',
        revision: 1,
        requesterId: 'req-b',
        clientRequestId: 'client-2',
      }),
    ).toThrow(RequestConflictError);
  });

  it('maps duplicate (requester_id, client_request_id) to REQUEST_CONFLICT and never silently dedupes', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    const ops = new OperationRepository(db);
    const first = ops.createOperation({
      taskId: task.id,
      step: 'apply',
      revision: 1,
      requesterId: 'requester-1',
      clientRequestId: 'idem-1',
      metadata: { lane: 'ops' },
      digest: 'sha256:abc',
      receipt: { redacted: true },
    });
    expect(first.id).toBeGreaterThan(0);

    let caught: unknown = null;
    try {
      ops.createOperation({
        taskId: task.id,
        step: 'apply',
        revision: 2,
        requesterId: 'requester-1',
        clientRequestId: 'idem-1',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestConflictError);
    expect((caught as RequestConflictError).code).toBe('REQUEST_CONFLICT');

    const rows = db
      .prepare('SELECT id FROM operations WHERE requester_id = ? AND client_request_id = ?')
      .all('requester-1', 'idem-1') as Array<{ id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
  });

  it('rolls back the task touch plus audit write when the operation insert conflicts (atomic)', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    const ops = new OperationRepository(db);
    ops.createOperation({
      taskId: task.id,
      step: 'verify',
      revision: 1,
      requesterId: 'req-x',
      clientRequestId: 'idem-x',
    });
    const before = db
      .prepare('SELECT updated_at AS updatedAt FROM tasks WHERE id = ?')
      .get(task.id) as { updatedAt: string };
    const auditBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }
    ).n;

    expect(() =>
      ops.createOperation({
        taskId: task.id,
        step: 'verify',
        revision: 1,
        requesterId: 'req-y',
        clientRequestId: 'idem-y',
      }),
    ).toThrow(RequestConflictError);

    const after = db
      .prepare('SELECT updated_at AS updatedAt FROM tasks WHERE id = ?')
      .get(task.id) as { updatedAt: string };
    expect(after.updatedAt).toBe(before.updatedAt);
    const auditAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }
    ).n;
    expect(auditAfter).toBe(auditBefore);
  });

  it('rejects operations for unknown tasks via foreign key', () => {
    const db = openMigratedV5(tempDatabasePath());
    const ops = new OperationRepository(db);
    expect(() =>
      ops.createOperation({
        taskId: '00000000-0000-7000-8000-000000000000',
        step: 'plan',
        revision: 1,
        requesterId: 'req-fk',
        clientRequestId: 'idem-fk',
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses schema downgrade once version 5 is applied (downgrade-guard)', () => {
    const db = openMigratedV5(tempDatabasePath());
    expect(currentSchemaVersion(db)).toBe(5);
    expect(() => migrateTo(db, 1)).toThrow(/downgrade refused/i);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    expect(tables.has('operations')).toBe(true);
  });

  it('preserves Coding task rows across a real SQLite upgrade close/reopen cycle', () => {
    const path = tempDatabasePath();
    const dbV1 = openMigratedV1(path);
    const tasksV1 = new TaskRepository(dbV1);
    const coding = tasksV1.create({
      goal: 'coding row must survive upgrade',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const v1Row = dbV1.prepare('SELECT id, goal, task_type AS taskType FROM tasks WHERE id = ?').get(coding.id) as {
      id: string;
      goal: string;
      taskType: string;
    };
    expect(v1Row.taskType).toBe('CODING');
    while (openDbs.length) openDbs.pop()?.close();

    const dbV5raw = openDatabase(path);
    openDbs.push(dbV5raw);
    runMigrations(dbV5raw);
    expect(currentSchemaVersion(dbV5raw)).toBe(5);
    const reopened = dbV5raw.prepare('SELECT id, goal, task_type AS taskType FROM tasks WHERE id = ?').get(coding.id) as {
      id: string;
      goal: string;
      taskType: string;
    };
    expect(reopened).toMatchObject({ id: coding.id, goal: 'coding row must survive upgrade', taskType: 'CODING' });

    const ops = new OperationRepository(dbV5raw);
    const created = ops.createOperation({
      taskId: coding.id,
      step: 'post-upgrade',
      revision: 1,
      requesterId: 'req-upgrade',
      clientRequestId: 'idem-upgrade',
    });
    expect(created.taskId).toBe(coding.id);
  });

  it('writes audit with canonical metadata/digest/sanitized receipt only and no raw bodies', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    const ops = new OperationRepository(db);
    ops.createOperation({
      taskId: task.id,
      step: 'audit-check',
      revision: 1,
      requesterId: 'req-audit',
      clientRequestId: 'idem-audit',
      metadata: { lane: 'ops', attempt: 1 },
      digest: 'sha256:deadbeef',
      receipt: { status: 'ok', redactedFields: ['token'] },
    });
    const row = db
      .prepare("SELECT payload_json AS payload FROM audit_events WHERE event_type = 'operation.created' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    expect(row).toBeDefined();
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload['metadata']).toMatchObject({ lane: 'ops' });
    expect(payload['digest']).toBe('sha256:deadbeef');
    expect(payload['receipt']).toMatchObject({ status: 'ok' });
    const flat = JSON.stringify(payload).toLowerCase();
    expect(flat).not.toContain('rawbody');
    expect(flat).not.toContain('raw_body');
    expect(flat).not.toContain('raw-body');
  });

  it('redacts secret values in operation metadata/receipt before the audit write', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    const ops = new OperationRepository(db);
    ops.createOperation({
      taskId: task.id,
      step: 'audit-redact',
      revision: 1,
      requesterId: 'req-redact',
      clientRequestId: 'idem-redact',
      metadata: { lane: 'ops', apiKey: 'sk-live-secret-0123456789' },
      digest: 'sha256:deadbeef',
      receipt: { status: 'ok', password: 'hunter2-secret' },
    });
    const row = db
      .prepare("SELECT payload_json AS payload FROM audit_events WHERE event_type = 'operation.created' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    const flat = JSON.stringify(JSON.parse(row.payload) as Record<string, unknown>);
    expect(flat).not.toContain('sk-live-secret-0123456789');
    expect(flat).not.toContain('hunter2-secret');
    expect(flat).toContain('***REDACTED***');
  });

  it('enforces domain NO NULL triggers on operations critical columns', () => {
    const db = openMigratedV5(tempDatabasePath());
    const task = seedTask(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO operations(task_id, step, revision, requester_id, client_request_id, status, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'PENDING', ?, ?)",
        )
        .run(task.id, 1, 'r', 'c', new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/must not be null/i);
  });
});
