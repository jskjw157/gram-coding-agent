import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { runMigrations } from './migrator.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gram-migrator-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

function openDb(path: string): Database.Database {
  const db = openDatabase(path);
  openDbs.push(db);
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map(({ name }) => name));
}

function appliedVersions(db: Database.Database): number[] {
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  return rows.map(({ version }) => version);
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrator manifest (WP-07 next-migration rule: 005 = MAX(M2 001-004) + 1)', () => {
  it('runMigrations applies the operations migration (005) on a fresh database', () => {
    const db = openDb(tempDatabasePath());
    runMigrations(db);
    const tables = tableNames(db);
    for (const table of [
      'operations',
      'effects',
      'leases',
      'blocks',
      'approval_details',
      'schedules',
    ]) {
      expect(tables.has(table), `migrator skipped unregistered migration: missing ${table}`).toBe(true);
    }
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('runMigrations is idempotent across resume (applied versions are skipped)', () => {
    const db = openDb(tempDatabasePath());
    runMigrations(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    runMigrations(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tableNames(db).has('operations')).toBe(true);
  });

  it('applies pending migrations in version order even when the manifest is unordered', () => {
    const db = openDb(tempDatabasePath());
    const here = dirname(fileURLToPath(import.meta.url));
    runMigrations(db, {
      migrations: [
        { version: 5, file: './migrations/005_operations.sql' },
        { version: 3, file: './migrations/003_verification_reviews.sql' },
        { version: 1, file: './migrations/001_initial.sql' },
        { version: 4, file: './migrations/004_approvals.sql' },
        { version: 2, file: './migrations/002_coding_steps.sql' },
      ],
      readSql: (file: string) => readFileSync(join(here, file), 'utf8'),
    });
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tableNames(db).has('operations')).toBe(true);
  });
});
