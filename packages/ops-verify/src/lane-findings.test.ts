// lane-findings.test.ts — lane-boundary pins (lane packages never edited here).
//
// F1 (FIXED in exec-core 89b5b8c): EffectLedger.reconcile settles UNKNOWN
// only via matching provider-query evidence. These pins drive the
// crashRecover path (the D12 recovery flow) and assert the fixed contract:
// matching evidence settles, evidence-less/mismatched stays refused.
// F2 (FIXED in exec-core 5b0834c): SqliteJournalStore backs the
// LedgerJournal/LeaseJournal ports with a real file DB; restart ->
// rehydrate -> crashRecover -> queryAndSettleUnknown survives a process
// exit. The memory-only default journal pin below stays as the contrast
// case (proves the file DB, not the default, carries state).
// F3 (open, Gate A regen): logger.test.ts collection is environment-// sensitive. Under the local root runner (Node 22) collection fails:
// the test imports `@gram/secrets` by name, whose exports default targets
// `./dist/index.js`, but no dist is built before `pnpm test` and the root
// has no `@gram/secrets` src alias (only the per-package config does).
// Hosted CI (Node 24, run 37236910021) collects and passes it, so this is
// a local-runner gap, not a lane break. Untouched since bootstrap #131
// and by all 10 regen merges; any fix needs a lane or root-config edit,
// both out of ops-verify scope. Pinned here, never skipped.
// F4 (open, W3 Gate A regen): the ops-common-approvals merge lands M2
// migrations 002-004, so the default manifest is now [1..5] and
// runMigrations applies all five (pinned below, idempotent). The
// persistence lane's own migrator.test.ts still asserts the pre-merge
// [1,5] manifest, so 2 of its tests RED. Lane-owner fix (update those
// two expectations); no lane edits made here.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';
import { SqliteJournalStore } from '../../task-engine/src/sqlite-journal.js';
import { openDatabase } from '../../persistence/src/database.js';
import { runMigrations } from '../../persistence/src/migrator.js';

const crashToUnknown = async (ledger: EffectLedger, operationId: string): Promise<string> => {
  const rec = ledger.prepare(operationId, 'WRITE');
  await expect(
    ledger.dispatch(rec.effectId, () => Promise.reject(new Error('fixture crash'))),
  ).rejects.toThrow();
  const recovered = ledger.crashRecover();
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.state).toBe('UNKNOWN');
  return rec.effectId;
};

describe('lane-boundary pins', () => {
  it('F1 fixed: crashRecover UNKNOWN + provider-confirmed-applied settles CONFIRMED', async () => {
    const ledger = new EffectLedger();
    const effectId = await crashToUnknown(ledger, 'op-f1-applied');
    const settled = ledger.reconcile(effectId, {
      observedState: 'CONFIRMED',
      policyDecision: 'ALLOW',
      providerEvidence: 'provider-confirmed-applied',
    });
    expect(settled.state).toBe('CONFIRMED');
    expect(ledger.get(effectId)?.state).toBe('CONFIRMED');
  });

  it('F1 fixed: crashRecover UNKNOWN + provider-confirmed-not-applied settles NOT_APPLIED', async () => {
    const ledger = new EffectLedger();
    const effectId = await crashToUnknown(ledger, 'op-f1-not-applied');
    const settled = ledger.reconcile(effectId, {
      observedState: 'NOT_APPLIED',
      policyDecision: 'ALLOW',
      providerEvidence: 'provider-confirmed-not-applied',
    });
    expect(settled.state).toBe('NOT_APPLIED');
    expect(ledger.get(effectId)?.state).toBe('NOT_APPLIED');
  });

  it('F1 fixed: evidence-less UNKNOWN settlement stays refused', async () => {
    const ledger = new EffectLedger();
    const effectId = await crashToUnknown(ledger, 'op-f1-no-evidence');
    expect(() =>
      ledger.reconcile(effectId, { observedState: 'CONFIRMED', policyDecision: 'ALLOW' }),
    ).toThrow(/conflicts with settled UNKNOWN/);
    expect(ledger.get(effectId)?.state).toBe('UNKNOWN');
  });

  it('F1 fixed: mismatched provider evidence stays refused', async () => {
    const ledger = new EffectLedger();
    const effectId = await crashToUnknown(ledger, 'op-f1-mismatch');
    expect(() =>
      ledger.reconcile(effectId, {
        observedState: 'CONFIRMED',
        policyDecision: 'ALLOW',
        providerEvidence: 'provider-confirmed-not-applied',
      }),
    ).toThrow(/conflicts with settled UNKNOWN/);
    expect(ledger.get(effectId)?.state).toBe('UNKNOWN');
  });

  it('F2 fixed: file-DB journal survives restart -> rehydrate -> UNKNOWN -> CONFIRMED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-verify-f2-'));
    try {
      const db = join(dir, 'journal.db');
      const store1 = new SqliteJournalStore(db);
      const ledger1 = new EffectLedger(store1.ledgerJournal);
      const rec = ledger1.prepare('op-f2-file', 'WRITE');
      await expect(
        ledger1.dispatch(rec.effectId, () => Promise.reject(new Error('fixture power loss'))),
      ).rejects.toThrow();
      store1.close();
      const store2 = new SqliteJournalStore(db);
      const restored = new EffectLedger(store2.ledgerJournal);
      restored.rehydrate(store2.loadLedgerRecords());
      expect(restored.crashRecover()).toHaveLength(1);
      const settled = await restored.queryAndSettleUnknown(rec.effectId, () =>
        Promise.resolve('applied'),
      );
      expect(settled.state).toBe('CONFIRMED');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2 contrast: default journal is memory-only, durability comes from the file-DB store', () => {
    const commits: string[] = [];
    const ledger = new EffectLedger((record) => {
      commits.push(record.state);
    });
    const rec = ledger.prepare('op-f2', 'WRITE');
    expect(commits).toEqual(['PREPARED']);
    expect(ledger.get(rec.effectId)?.state).toBe('PREPARED');
  });

  it('F4 open: merged manifest applies [1..5]; lane migrator.test.ts still pins pre-merge [1,5]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-verify-f4-'));
    try {
      const db = openDatabase(join(dir, 'state.db'));
      try {
        runMigrations(db);
        const rows = db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as Array<{ version: number }>;
        expect(rows.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
        runMigrations(db);
        const resumed = db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as Array<{ version: number }>;
        expect(resumed.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3 open: local root-runner collection preconditions for logger.test.ts (dist-less secrets, no root alias)', async () => {
    const root = new URL('../../../', import.meta.url);
    const secretsPkg = JSON.parse(
      await readFile(new URL('packages/secrets/package.json', root), 'utf8'),
    ) as { exports: { '.': { default: string } } };
    expect(secretsPkg.exports['.'].default).toBe('./dist/index.js');
    await expect(
      readFile(new URL('packages/secrets/dist/index.js', root), 'utf8'),
    ).rejects.toThrow();
    const rootVitest = await readFile(new URL('vitest.config.ts', root), 'utf8').then(
      (content) => content,
      () => '',
    );
    expect(rootVitest.includes('@gram/secrets')).toBe(false);
  });
});
