// lane-findings.test.ts — lane-boundary pins (lane packages never edited here).
//
// F1 (FIXED in exec-core 89b5b8c): EffectLedger.reconcile settles UNKNOWN
// only via matching provider-query evidence. These pins drive the
// crashRecover path (the D12 recovery flow) and assert the fixed contract:
// matching evidence settles, evidence-less/mismatched stays refused.
// F2 (open): ledger is memory-only; cross-restart recovery needs an
// external durable journal.
import { describe, expect, it } from 'vitest';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';

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

  it('F2 open: ledger is memory-only, cross-restart recovery needs an external journal', () => {
    const commits: string[] = [];
    const ledger = new EffectLedger((record) => {
      commits.push(record.state);
    });
    const rec = ledger.prepare('op-f2', 'WRITE');
    expect(commits).toEqual(['PREPARED']);
    expect(ledger.get(rec.effectId)?.state).toBe('PREPARED');
  });
});
