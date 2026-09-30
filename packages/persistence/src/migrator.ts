import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const MIGRATIONS = [
  { version: 1, file: './migrations/001_initial.sql' },
  { version: 2, file: './migrations/002_coding_steps.sql' },
  { version: 3, file: './migrations/003_verification_reviews.sql' },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  for (const migration of MIGRATIONS) {
    const migrate = db.transaction(() => {
      const applied = db
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(migration.version) as { version: number } | undefined;
      if (applied) return;

      const sql = readFileSync(new URL(migration.file, import.meta.url), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
    migrate.immediate();
  }
}
