import Database from 'better-sqlite3';

export function openDatabase(path: string): Database.Database {
  const db = new Database(path, { timeout: 5_000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
