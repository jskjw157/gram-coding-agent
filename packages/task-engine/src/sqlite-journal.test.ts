import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EffectLedger } from './effect-ledger.js';
import type { EffectRecord } from './effect-ledger.js';
import { LeaseManager } from './lease-manager.js';
import { SqliteJournalStore } from './sqlite-journal.js';

const tempDbPath = (): { dir: string; db: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'task-engine-sqlite-journal-'));
  return { dir, db: join(dir, 'journal.db') };
};

describe('SqliteJournalStore (W2e F2: SQLite-backed LedgerJournal/LeaseJournal)', () => {
  it('RED F2a: restart with the in-memory default journal loses file-DB state', () => {
    const { dir, db } = tempDbPath();
    try {
      // No SQLite backing: the default in-memory ledger cannot rehydrate
      // from a real file DB after restart.
      const ledger1 = new EffectLedger();
      const rec = ledger1.prepare('op-file-1', 'WRITE');
      expect(rec.state).toBe('PREPARED');
      void db;
      const fresh = new EffectLedger();
      expect(fresh.get(rec.effectId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GREEN F2b: ledger events survive file-DB restart then rehydrate + reconcile', async () => {
    const { dir, db } = tempDbPath();
    try {
      const store1 = new SqliteJournalStore(db);
      const ledger1 = new EffectLedger(store1.ledgerJournal);
      const rec = ledger1.prepare('op-file-1', 'WRITE');
      await expect(
        ledger1.dispatch(rec.effectId, () => Promise.reject(new Error('crash: power loss'))),
      ).rejects.toThrow();
      store1.close();

      // Restart: reopen the SAME file DB and replay the journal.
      const store2 = new SqliteJournalStore(db);
      const journal: EffectRecord[] = store2.loadLedgerRecords();
      expect(journal.length).toBeGreaterThanOrEqual(2);
      const restored = new EffectLedger(store2.ledgerJournal);
      restored.rehydrate(journal);
      expect(restored.get(rec.effectId)?.state).toBe('DISPATCHING');
      const recovered = restored.crashRecover();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.state).toBe('UNKNOWN');
      const settled = await restored.queryAndSettleUnknown(rec.effectId, () =>
        Promise.resolve('applied'),
      );
      expect(settled.state).toBe('CONFIRMED');
      expect(restored.get(rec.effectId)?.state).toBe('CONFIRMED');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GREEN F2c: lease snapshot + events survive file-DB restart', () => {
    const { dir, db } = tempDbPath();
    try {
      const store1 = new SqliteJournalStore(db);
      const lm1 = new LeaseManager({ now: () => 1_000, journal: store1.leaseJournal });
      const lease = lm1.acquire(['res-a'], 'owner-1');
      lm1.block('res-b', 'incident-hold');
      store1.saveLeaseSnapshot(lm1.snapshot());
      expect(store1.loadLeaseEvents()).toHaveLength(2);
      store1.close();

      const store2 = new SqliteJournalStore(db);
      const snap = store2.loadLeaseSnapshot();
      if (snap === null) throw new Error('missing lease snapshot');
      const restored = new LeaseManager({ now: () => 1_000, journal: store2.leaseJournal });
      restored.rehydrate(snap);
      expect(() => restored.acquire(['res-a'], 'owner-2')).toThrow();
      expect(restored.isBlocked('res-b')).toBe(true);
      restored.release(['res-a'], lease.owner, lease.token);
      const next = restored.acquire(['res-a'], 'owner-2');
      expect(next.fenceEpoch).toBeGreaterThan(lease.fenceEpoch);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
