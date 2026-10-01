import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { runMigrations } from './migrator.js';
import type { Migration, MigrationRunOptions } from './migrator.js';
import { TaskRepository } from './repositories/task-repository.js';

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];
const openDbs: Database.Database[] = [];

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'gram-coding-migrations-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'state.db'));
  databases.push(db);
  return db;
}

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
  while (databases.length) databases.pop()?.close();
  let directory: string | undefined;
  while ((directory = directories.pop()) !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function appliedVersions(db: Database.Database): number[] {
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  return rows.map((row) => row.version);
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function loadMigrationSql(fileName: string): string {
  return readFileSync(new URL(`./migrations/${fileName}`, import.meta.url), 'utf8');
}

// Fixture SQL keyed by fake file name. The new Migration API delivers SQL
// through the injected readSql function, so runner-mechanics tests use fake
// file names with fixture bodies and never touch disk.
const FIXTURE_SQL: Record<string, string> = {
  'v1-noop.sql': 'SELECT 1;',
  'probe-v2.sql': 'CREATE TABLE migrator_probe_v2 (id INTEGER PRIMARY KEY) STRICT;',
  'probe-v3.sql': 'CREATE TABLE migrator_probe_v3 (id INTEGER PRIMARY KEY) STRICT;',
  'probe-v2-broken.sql':
    'CREATE TABLE migrator_probe_v2 (id INTEGER PRIMARY KEY) STRICT; THIS IS NOT VALID SQL;',
};

function testReadSql(file: string): string {
  const fixture = FIXTURE_SQL[file];
  if (fixture !== undefined) return fixture;
  return loadMigrationSql(file);
}

function fixtureOptions(migrations: readonly Migration[]): MigrationRunOptions {
  return { migrations, readSql: testReadSql };
}

// Already-applied versions are skipped without executing their SQL, so the
// SQL body for version 1 in fixture lists is never run and can be a no-op.
const V1_NOOP: Migration = { version: 1, file: 'v1-noop.sql' };
const V2_FIXTURE: Migration = { version: 2, file: 'probe-v2.sql' };
const V3_FIXTURE: Migration = { version: 3, file: 'probe-v3.sql' };
// First statement succeeds, second throws: proves per-version atomicity only
// if the created table is rolled back along with the version row.
const V2_BROKEN: Migration = { version: 2, file: 'probe-v2-broken.sql' };

// Runs only the real v1 migration from disk. Several tests need a database
// "already at v1"; the default no-options call now applies v1..v4, so those
// setups pin v1 explicitly instead.
function v1OnlyOptions(): MigrationRunOptions {
  return { migrations: [{ version: 1, file: '001_initial.sql' }], readSql: testReadSql };
}

const APPROVED_CORE_TABLES: readonly string[] = [
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
];

describe('coding step migrations', () => {
  it('creates identity-only coding step storage on a fresh database', () => {
    const db = database();
    runMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
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
      { version: 4 },
    ]);
    expect(db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get())
      .toEqual({ applied_at: '2026-09-01T00:00:00.000Z' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coding_steps'").get())
      .toEqual({ name: 'coding_steps' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get())
      .toEqual({ name: 'approvals' });
  });
});

describe('production migration manifest', () => {
  it('applies versions in ascending 1 -> 2 -> 3 -> 4 order on a fresh database', () => {
    // Given: a fresh empty database
    const db = database();

    // When: running migrations with the default (no-options) call
    runMigrations(db);

    // Then: the production manifest applied versions 1, 2, 3, 4 in ascending order
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get())
      .toEqual({ name: 'approvals' });
  });
});

describe('multi-version migration runner', () => {
  it('M1: applies the real initial migration on a fresh database', () => {
    // Given: a fresh empty database
    const db = openTestDb();

    // When: running migrations with the real v1 migration only
    runMigrations(db, v1OnlyOptions());

    // Then: schema_migrations exists with version 1, and the real schema is present
    expect(appliedVersions(db)).toEqual([1]);
    const tables = tableNames(db);
    expect(tables.has('tasks')).toBe(true);
    expect(tables.has('schema_migrations')).toBe(true);
  });

  it('M2: applies a pending second version on a database already at v1', () => {
    // Given: a database already at v1 via the real migration
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    expect(appliedVersions(db)).toEqual([1]);

    // When: running with a second version pending
    runMigrations(db, fixtureOptions([V1_NOOP, V2_FIXTURE]));

    // Then: v2 is applied and both rows are present
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tableNames(db).has('migrator_probe_v2')).toBe(true);
  });

  it('M3: running twice is a no-op', () => {
    // Given: a migrated database
    const db = openTestDb();
    runMigrations(db, fixtureOptions([V1_NOOP, V2_FIXTURE]));
    const before = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; applied_at: string }>;

    // When: running the same migrations again
    runMigrations(db, fixtureOptions([V1_NOOP, V2_FIXTURE]));

    // Then: no duplicate rows, no error, schema unchanged
    const after = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; applied_at: string }>;
    expect(after).toEqual(before);
    expect(tableNames(db).has('migrator_probe_v2')).toBe(true);
  });

  it('M4: a failing version rolls back completely', () => {
    // Given: a database at v1
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    expect(appliedVersions(db)).toEqual([1]);

    // When: the pending v2 DDL throws
    expect(() => runMigrations(db, fixtureOptions([V1_NOOP, V2_BROKEN]))).toThrow();

    // Then: no v2 row, no partial DDL (probe table absent), v1 intact and usable
    expect(appliedVersions(db)).toEqual([1]);
    expect(tableNames(db).has('migrator_probe_v2')).toBe(false);
    expect(tableNames(db).has('tasks')).toBe(true);
    db.prepare(
      "INSERT INTO repositories (owner, name, default_branch, local_base_path, created_at, updated_at) VALUES ('acme', 'web', 'main', '/tmp/acme-web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
  });

  it('M5: a failed version can be retried once fixed', () => {
    // Given: a v2 failure that rolled back (see M4)
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    expect(() => runMigrations(db, fixtureOptions([V1_NOOP, V2_BROKEN]))).toThrow();
    expect(appliedVersions(db)).toEqual([1]);

    // When: retrying with the fixed v2
    runMigrations(db, fixtureOptions([V1_NOOP, V2_FIXTURE]));

    // Then: v2 applies cleanly
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tableNames(db).has('migrator_probe_v2')).toBe(true);
  });

  it('M6: a gap in versions applies in ascending order without backfilling', () => {
    // Given: only v1 and v3 supplied (v2 never existed)
    // Expectation: gaps are allowed — pending versions apply in ascending
    // numeric order; the runner must NOT invent or require the missing v2.
    const db = openTestDb();

    // When: running with the gapped list
    runMigrations(db, fixtureOptions([V1_NOOP, V3_FIXTURE]));

    // Then: v1 and v3 applied in order, no v2 row fabricated
    expect(appliedVersions(db)).toEqual([1, 3]);
    expect(tableNames(db).has('migrator_probe_v3')).toBe(true);
    expect(tableNames(db).has('migrator_probe_v2')).toBe(false);
  });

  it('M7: the default one-argument path reproduces the approved schema', () => {
    // Given: a fresh empty database
    const db = openTestDb();

    // When: running with only the database argument (existing caller shape)
    runMigrations(db);

    // Then: every approved core table exists, byte-compatible with the old runner
    const tables = tableNames(db);
    for (const table of APPROVED_CORE_TABLES) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'")
      .get() as { sql: string } | undefined;
    expect(ddl?.sql).toContain('STRICT');
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
  });
});

describe('004 approvals migration', () => {
  function v1RealMigration(): Migration {
    return { version: 1, file: '001_initial.sql' };
  }

  function v4ApprovalsMigration(): Migration {
    return { version: 4, file: '004_approvals.sql' };
  }

  function migrateToV4(db: Database.Database): void {
    runMigrations(db, fixtureOptions([v1RealMigration(), v4ApprovalsMigration()]));
  }

  function upgradeToV4(db: Database.Database): void {
    runMigrations(db, fixtureOptions([V1_NOOP, v4ApprovalsMigration()]));
  }

  function insertTask(db: Database.Database, id: string, seq: number): void {
    db.prepare(
      `INSERT INTO tasks (id, seq, goal, status, task_type, publish_mode, created_at, updated_at)
       VALUES (?, ?, 'goal', 'QUEUED', 'CODING', 'PULL_REQUEST', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(id, seq);
  }

  function insertApprovalPreUpgrade(
    db: Database.Database,
    seed: { taskId: string; operationHash: string; status: string; requestedAt: string },
  ): number | bigint {
    return db
      .prepare(
        `INSERT INTO approvals (task_id, operation_hash, status, requested_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(seed.taskId, seed.operationHash, seed.status, seed.requestedAt).lastInsertRowid;
  }

  function insertApprovalPostUpgrade(
    db: Database.Database,
    seed: {
      taskId: string;
      operationHash: string;
      status: string;
      requestedAt?: string;
      approvedAt?: string | null;
      consumedAt?: string | null;
      expiresAt?: string | null;
    },
  ): number | bigint {
    return db
      .prepare(
        `INSERT INTO approvals (task_id, operation_hash, status, requested_at, approved_at, consumed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.taskId,
        seed.operationHash,
        seed.status,
        seed.requestedAt ?? '2026-01-01T00:00:00.000Z',
        seed.approvedAt ?? null,
        seed.consumedAt ?? null,
        seed.expiresAt ?? null,
      ).lastInsertRowid;
  }

  function countPair(db: Database.Database, taskId: string, operationHash: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM approvals WHERE task_id = ? AND operation_hash = ?')
      .get(taskId, operationHash) as { count: number } | undefined;
    return row?.count ?? -1;
  }

  function expectSqliteError(fn: () => void, expectedCode: string): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const code = (error as { code?: unknown }).code;
      expect(code).toBe(expectedCode);
      return;
    }
    throw new Error(`${expectedCode} was expected but the statement succeeded`);
  }

  it('N1: fresh database migrated to the end has expires_at, the live-pair index, and surviving PK/FK', () => {
    // Given: a fresh empty database
    const db = openTestDb();

    // When: migrating to the end of the chain
    migrateToV4(db);

    // Then: version 4 recorded, expires_at present and nullable, live-pair index present, PK/FK intact
    expect(appliedVersions(db)).toEqual([1, 4]);
    const columns = db.prepare('PRAGMA table_info(approvals)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const expiresAt = columns.find((column) => column.name === 'expires_at');
    expect(expiresAt).toBeDefined();
    expect(expiresAt?.notnull).toBe(0);
    const liveIndex = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'approvals_live_pair_idx'")
      .get() as { sql: string } | undefined;
    expect(liveIndex?.sql).toContain('UNIQUE INDEX approvals_live_pair_idx');
    expect(liveIndex?.sql).toContain("WHERE status IN ('PENDING', 'APPROVED')");
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() as {
        sql: string;
      } | undefined
    )?.sql;
    expect(ddl).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(ddl).toContain('REFERENCES tasks(id) ON DELETE CASCADE');
    expect(ddl).toContain('REFERENCES policy_decisions(id) ON DELETE CASCADE');
    expect(ddl).toContain('STRICT');
    expect(ddl).toContain("CHECK (status IN ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED', 'EXPIRED'))");
    const legacyIndex = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'approvals_task_id_idx'")
      .get() as { sql: string } | undefined;
    expect(legacyIndex?.sql).toContain('ON approvals(task_id)');
  });

  it('N2: a database already at v1 upgrades, keeping every v1 table', () => {
    // Given: a database at version 1 via the real initial migration
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    expect(appliedVersions(db)).toEqual([1]);

    // When: upgrading with the approvals migration pending
    upgradeToV4(db);

    // Then: version 4 recorded and every v1 table still exists
    expect(appliedVersions(db)).toEqual([1, 4]);
    const tables = tableNames(db);
    for (const table of APPROVED_CORE_TABLES) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('N3: a v1 approval row survives the upgrade with every column intact', () => {
    // Given: a v1 database holding one approval row
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    insertTask(db, 'task-n3', 1);
    const createdId = insertApprovalPreUpgrade(db, {
      taskId: 'task-n3',
      operationHash: 'op-n3',
      status: 'PENDING',
      requestedAt: '2026-02-01T00:00:00.000Z',
    });
    const before = db
      .prepare(
        'SELECT id, task_id, policy_decision_id, operation_hash, status, requested_at, approved_at, consumed_at FROM approvals',
      )
      .get() as Record<string, unknown> | undefined;
    expect(before).toBeDefined();

    // When: upgrading to v4
    upgradeToV4(db);

    // Then: the row survives verbatim, expires_at is NULL, and autoincrement continues past it
    const after = db
      .prepare(
        'SELECT id, task_id, policy_decision_id, operation_hash, status, requested_at, approved_at, consumed_at, expires_at FROM approvals',
      )
      .get() as Record<string, unknown> | undefined;
    expect(after).toEqual({ ...(before as Record<string, unknown>), expires_at: null });
    const nextId = insertApprovalPostUpgrade(db, {
      taskId: 'task-n3',
      operationHash: 'op-n3-next',
      status: 'PENDING',
    });
    expect(Number(nextId)).toBe(Number(createdId) + 1);
    const sequence = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'approvals'")
      .get() as { seq: number } | undefined;
    expect(sequence?.seq).toBe(Number(createdId) + 1);
  });

  it('N4: a second live PENDING pair is rejected', () => {
    // Given: a migrated database with one PENDING approval for a pair
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n4', 1);
    insertApprovalPostUpgrade(db, { taskId: 'task-n4', operationHash: 'op-n4', status: 'PENDING' });

    // When/Then: a second PENDING row for the same pair fails unique and leaves no partial row
    expectSqliteError(
      () => insertApprovalPostUpgrade(db, { taskId: 'task-n4', operationHash: 'op-n4', status: 'PENDING' }),
      'SQLITE_CONSTRAINT_UNIQUE',
    );
    expect(countPair(db, 'task-n4', 'op-n4')).toBe(1);
  });

  it('N5: a second live pair over an APPROVED row is rejected', () => {
    // Given: a migrated database with one APPROVED approval for a pair
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n5', 1);
    insertApprovalPostUpgrade(db, {
      taskId: 'task-n5',
      operationHash: 'op-n5',
      status: 'APPROVED',
      approvedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-02-01T01:00:00.000Z',
    });

    // When/Then: a second live row for the same pair fails unique and leaves no partial row
    expectSqliteError(
      () => insertApprovalPostUpgrade(db, { taskId: 'task-n5', operationHash: 'op-n5', status: 'PENDING' }),
      'SQLITE_CONSTRAINT_UNIQUE',
    );
    expect(countPair(db, 'task-n5', 'op-n5')).toBe(1);
  });

  it('N6: the same pair may be requested again after CONSUMED', () => {
    // Given: a migrated database with a terminal CONSUMED row for a pair
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n6', 1);
    insertApprovalPostUpgrade(db, {
      taskId: 'task-n6',
      operationHash: 'op-n6',
      status: 'CONSUMED',
      approvedAt: '2026-02-01T00:00:00.000Z',
      consumedAt: '2026-02-01T00:05:00.000Z',
    });

    // When: requesting the same pair again
    insertApprovalPostUpgrade(db, { taskId: 'task-n6', operationHash: 'op-n6', status: 'PENDING' });

    // Then: both rows exist
    expect(countPair(db, 'task-n6', 'op-n6')).toBe(2);
  });

  it('N7: the same pair may be requested again after DENIED', () => {
    // Given: a migrated database with a terminal DENIED row for a pair
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n7', 1);
    insertApprovalPostUpgrade(db, { taskId: 'task-n7', operationHash: 'op-n7', status: 'DENIED' });

    // When: requesting the same pair again
    insertApprovalPostUpgrade(db, { taskId: 'task-n7', operationHash: 'op-n7', status: 'PENDING' });

    // Then: both rows exist
    expect(countPair(db, 'task-n7', 'op-n7')).toBe(2);
  });

  it('N8: the same pair may be requested again after EXPIRED', () => {
    // Given: a migrated database with a terminal EXPIRED row for a pair
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n8', 1);
    insertApprovalPostUpgrade(db, {
      taskId: 'task-n8',
      operationHash: 'op-n8',
      status: 'EXPIRED',
      approvedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-02-01T01:00:00.000Z',
    });

    // When: requesting the same pair again
    insertApprovalPostUpgrade(db, { taskId: 'task-n8', operationHash: 'op-n8', status: 'PENDING' });

    // Then: both rows exist
    expect(countPair(db, 'task-n8', 'op-n8')).toBe(2);
  });

  it('N9: a status outside the five legal values is rejected', () => {
    // Given: a migrated database
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n9', 1);

    // When/Then: inserting an unknown status fails the check and leaves no partial row
    expectSqliteError(
      () => insertApprovalPostUpgrade(db, { taskId: 'task-n9', operationHash: 'op-n9', status: 'BOGUS' }),
      'SQLITE_CONSTRAINT_CHECK',
    );
    expect(countPair(db, 'task-n9', 'op-n9')).toBe(0);
  });

  it('N10: expires_at stays nullable for PENDING and settable for APPROVED', () => {
    // Given: a migrated database
    const db = openTestDb();
    migrateToV4(db);
    insertTask(db, 'task-n10', 1);

    // When: inserting a PENDING row without expiry and an APPROVED row with expiry
    insertApprovalPostUpgrade(db, { taskId: 'task-n10', operationHash: 'op-n10-pending', status: 'PENDING' });
    insertApprovalPostUpgrade(db, {
      taskId: 'task-n10',
      operationHash: 'op-n10-approved',
      status: 'APPROVED',
      approvedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-02-01T01:00:00.000Z',
    });

    // Then: both rows exist with the expected expiry values
    const rows = db
      .prepare('SELECT operation_hash, expires_at FROM approvals WHERE task_id = ? ORDER BY operation_hash')
      .all('task-n10') as Array<{ operation_hash: string; expires_at: string | null }>;
    expect(rows).toEqual([
      { operation_hash: 'op-n10-approved', expires_at: '2026-02-01T01:00:00.000Z' },
      { operation_hash: 'op-n10-pending', expires_at: null },
    ]);
  });

  it('N11: rows in other tables survive the upgrade untouched', () => {
    // Given: a v1 database holding rows in unrelated tables
    const db = openTestDb();
    runMigrations(db, v1OnlyOptions());
    db.prepare(
      `INSERT INTO repositories (owner, name, default_branch, local_base_path, created_at, updated_at)
       VALUES ('acme', 'web', 'main', '/tmp/acme-web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    insertTask(db, 'task-n11', 1);
    db.prepare(
      `INSERT INTO policy_decisions (task_id, operation_hash, decision, rule_id, reason, normalized_operation_json, created_at)
       VALUES ('task-n11', 'op-n11', 'ALLOW', 'rule-1', 'reason', '{}', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO command_runs (task_id, category, cwd, status, started_at)
       VALUES ('task-n11', 'shell', '/tmp', 'OK', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const beforeRepositories = db.prepare('SELECT * FROM repositories').all();
    const beforeTasks = db.prepare('SELECT * FROM tasks').all();
    const beforeDecisions = db.prepare('SELECT * FROM policy_decisions').all();
    const beforeRuns = db.prepare('SELECT * FROM command_runs').all();

    // When: upgrading to v4
    upgradeToV4(db);

    // Then: every unrelated row survives verbatim
    expect(db.prepare('SELECT * FROM repositories').all()).toEqual(beforeRepositories);
    expect(db.prepare('SELECT * FROM tasks').all()).toEqual(beforeTasks);
    expect(db.prepare('SELECT * FROM policy_decisions').all()).toEqual(beforeDecisions);
    expect(db.prepare('SELECT * FROM command_runs').all()).toEqual(beforeRuns);
  });

  it('N12: running the full migration set twice is a no-op', () => {
    // Given: a database already migrated to the end
    const db = openTestDb();
    migrateToV4(db);
    const beforeMigrations = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all();
    const beforeIndexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' ORDER BY name")
      .all();

    // When: running the same migration set again
    migrateToV4(db);

    // Then: no duplicate rows or indexes, no error
    expect(db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()).toEqual(
      beforeMigrations,
    );
    expect(
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' ORDER BY name").all(),
    ).toEqual(beforeIndexes);
    expect(appliedVersions(db)).toEqual([1, 4]);
  });
});
