// lane-findings.test.ts — required lane-package fixes (NOT applied here).
//
// Lane packages are never edited by ops-verify; when the D12 wiring needs a
// lane change, it is reported as a finding and pinned by this file. Each pin
// asserts CURRENT lane behavior and names the fix; flip the pin when the
// lane is fixed.
import { describe, expect, it } from 'vitest';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';

describe('lane-fix findings (pinned current behavior)', () => {
  it('F1: reconcile refuses UNKNOWN->CONFIRMED after crashRecover (needs lane fix)', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-f1', 'WRITE');
    await expect(
      ledger.dispatch(rec.effectId, () => Promise.reject(new Error('fixture crash'))),
    ).rejects.toThrow();
    const recovered = ledger.crashRecover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state).toBe('UNKNOWN');
    expect(() =>
      ledger.reconcile(rec.effectId, { observedState: 'CONFIRMED', policyDecision: 'ALLOW' }),
    ).toThrow(/conflicts with settled UNKNOWN/);
    expect(() =>
      ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' }),
    ).toThrow(/conflicts with settled UNKNOWN/);
  });

  it('F2: ledger is memory-only, cross-restart recovery needs an external journal', () => {
    const commits: string[] = [];
    const ledger = new EffectLedger((record) => {
      commits.push(record.state);
    });
    const rec = ledger.prepare('op-f2', 'WRITE');
    expect(commits).toEqual(['PREPARED']);
    expect(ledger.get(rec.effectId)?.state).toBe('PREPARED');
  });
});
