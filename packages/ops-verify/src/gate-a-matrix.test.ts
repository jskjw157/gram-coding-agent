// gate-a-matrix.test.ts — Gate A fixture matrix runner.
//
// Executes the full matrix (8 crash points + READ reconcile-first retry)
// through the crash-safe wiring and prints the Gate A table to stdout for
// the PR record. Every cell is asserted; the table is evidence, not proof.
import { describe, expect, it } from 'vitest';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';
import { CRASH_POINTS, CrashSafeExecutor } from './harness.js';
import type { CrashPoint } from './harness.js';

const expectedFinal: Record<CrashPoint, string> = {
  'before-ledger': 'CONFIRMED',
  'after-prepared': 'CONFIRMED',
  'dispatching-pre-send': 'CONFIRMED',
  'send-connection-loss': 'NOT_APPLIED:REAPPROVAL_REQUIRED',
  'applied-response-lost': 'CONFIRMED',
  'response-before-receipt': 'CONFIRMED',
  'receipt-before-task-update': 'CONFIRMED',
  'during-reconcile': 'UNKNOWN',
};

describe('Gate A fixture matrix', () => {
  it('every crash-point cell resolves with zero blind retransmits', async () => {
    const rows: string[] = ['| crash point | sends | queries | final |', '|---|---|---|---|'];
    for (const point of CRASH_POINTS) {
      const outcome = await new CrashSafeExecutor().run(point);
      expect(outcome.sends).toBe(1);
      expect(outcome.finalState).toBe(expectedFinal[point]);
      rows.push(`| ${point} | ${String(outcome.sends)} | ${String(outcome.queries)} | ${outcome.finalState} |`);
    }
    process.stdout.write(`Gate A matrix (fixture):\n${rows.join('\n')}\n`);
  });

  it('READ reconciled NOT_APPLIED retries within budget after policy recheck', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-read-retry', 'READ');
    await ledger.dispatch(rec.effectId, () => Promise.resolve('NOT_APPLIED' as const));
    ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    const retried = ledger.requestRetry(rec.effectId, {
      evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
    });
    expect(retried.state).toBe('PREPARED');
    const settled = await ledger.dispatch(retried.effectId, () => Promise.resolve('CONFIRMED' as const));
    expect(settled.state).toBe('CONFIRMED');
  });
});
