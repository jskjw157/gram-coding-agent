import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly file: string;
}

// Both the manifest and the SQL loader are injectable so tests can exercise
// ordering, rollback, and resume behaviour without adding real files under
// src/migrations. Production keeps the file-based manifest below.
export interface MigrationRunOptions {
  readonly migrations: readonly Migration[];
  readonly readSql: (file: string) => string;
}

// Append-only manifest per WP-07 convergence section (b): versions 2-4 are
// M2-owned (002_coding_steps, 003_verification_reviews, 004_approvals) and
// land with the M2 lineage; the ops lane owns version 5 = MAX(M2 001-004)+1.
const MIGRATIONS: readonly Migration[] = [
  { version: 1, file: './migrations/001_initial.sql' },
  { version: 5, file: './migrations/005_operations.sql' },
];

function readMigrationSql(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

export function runMigrations(
  db: Database.Database,
  options: MigrationRunOptions = { migrations: MIGRATIONS, readSql: readMigrationSql },
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const ordered = [...options.migrations].sort((a, b) => a.version - b.version);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(options.readSql(migration.file));
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply.immediate();
  }
}
