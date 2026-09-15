import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const INITIAL_VERSION = 1;

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = db
    .prepare('SELECT version FROM schema_migrations WHERE version = ?')
    .get(INITIAL_VERSION) as { version: number } | undefined;
  if (applied) return;

  const sql = readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
  const migrate = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      INITIAL_VERSION,
      new Date().toISOString(),
    );
  });
  migrate.immediate();
}
