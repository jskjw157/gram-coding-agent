// sqlite-journal.ts — SQLite-backed LedgerJournal/LeaseJournal ports (W2e F2, D12).
//
// This is the WP-07 persistence target hook for the durable wiring: it backs
// the in-lane journal ports with a real file DB so restart -> rehydrate ->
// reconcile survives a process exit. Lane logic is untouched (no
// effect-ledger/lease-manager changes): the store only appends journal
// payloads and replays them as plain JSON for snapshot()/rehydrate().
//
// Tables (this lane only, no M2 fork, no migrator/004/005 edits):
// - ledger_events(id, effect_id, payload): one row per LedgerJournal commit,
//   commit order = rowid order; replay = SELECT payload ORDER BY id.
// - lease_events(id, kind, payload): one row per LeaseJournalEvent.
// - lease_snapshot(id CHECK id = 1, payload): latest PersistedLeaseSnapshot.
import Database from 'better-sqlite3';
import type { EffectRecord, LedgerJournal } from './effect-ledger.js';
import type {
  LeaseJournal,
  LeaseJournalEvent,
  PersistedLeaseSnapshot,
} from './lease-manager.js';

export class SqliteJournalStore {
  private readonly db: Database.Database;
  readonly ledgerJournal: LedgerJournal;
  readonly leaseJournal: LeaseJournal;

  constructor(dbPath: string) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new Error('sqlite journal needs a non-empty file path');
    }
    const db = new Database(dbPath, { timeout: 5_000 });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(
      `CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        effect_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_events_effect ON ledger_events (effect_id);
      CREATE TABLE IF NOT EXISTS lease_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lease_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL
      );`,
    );
    this.db = db;
    this.ledgerJournal = (record: EffectRecord): void => {
      db.prepare('INSERT INTO ledger_events (effect_id, payload) VALUES (?, ?)').run(
        record.effectId,
        JSON.stringify(record),
      );
    };
    this.leaseJournal = (event: LeaseJournalEvent): void => {
      db.prepare('INSERT INTO lease_events (kind, payload) VALUES (?, ?)').run(
        event.kind,
        JSON.stringify(event),
      );
    };
  }

  /** Replay ledger commits in commit order for ledger.rehydrate(). */
  loadLedgerRecords(): EffectRecord[] {
    const rows = this.db
      .prepare('SELECT payload FROM ledger_events ORDER BY id ASC')
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as EffectRecord);
  }

  /** Replay lease journal events in commit order (audit/debug; rehydrate uses the snapshot). */
  loadLeaseEvents(): LeaseJournalEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM lease_events ORDER BY id ASC')
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as LeaseJournalEvent);
  }

  /** Persist the latest lease snapshot (holds + epochs + blocks + nextEpoch). */
  saveLeaseSnapshot(snapshot: PersistedLeaseSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO lease_snapshot (id, payload) VALUES (1, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET payload = excluded.payload',
      )
      .run(JSON.stringify(snapshot));
  }

  /** Load the latest lease snapshot for manager.rehydrate(), or null when none saved. */
  loadLeaseSnapshot(): PersistedLeaseSnapshot | null {
    const row = this.db
      .prepare('SELECT payload FROM lease_snapshot WHERE id = 1')
      .get() as { payload: string } | undefined;
    if (row === undefined) return null;
    return JSON.parse(row.payload) as PersistedLeaseSnapshot;
  }

  close(): void {
    this.db.close();
  }
}
