import { describe, expect, it } from 'vitest';
import {
  BlindRetryRefusedError,
  EffectLedger,
  RetryBudgetExhaustedError,
  StaleFenceDispatchError,
} from './effect-ledger.js';
import type { EffectRecord } from './effect-ledger.js';

describe('EffectLedger (durable-before-effect, UNKNOWN, reconcile-before-retry)', () => {
  it('RED: DISPATCHING is durably committed BEFORE transmit', async () => {
    const order: string[] = [];
    const ledger = new EffectLedger((record: EffectRecord) => {
      order.push(`commit:${record.state}`);
    });
    const rec = ledger.prepare('op-1', 'READ');
    await ledger.dispatch(rec.effectId, () => {
      order.push('transmit');
      return Promise.resolve('CONFIRMED');
    });
    expect(order).toEqual(['commit:PREPARED', 'commit:DISPATCHING', 'transmit', 'commit:CONFIRMED']);
  });

  it('RED: stale-fence dispatch is refused before transmit', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    let transmitted = false;
    await expect(
      ledger.dispatch(
        rec.effectId,
        () => {
          transmitted = true;
          return Promise.resolve('CONFIRMED');
        },
        {
          resource: 'res-a',
          fenceEpoch: 1,
          assertUsable: () => {
            throw new StaleFenceDispatchError('stale fence');
          },
        },
      ),
    ).rejects.toThrow(StaleFenceDispatchError);
    expect(transmitted).toBe(false);
  });

  it('RED: crash during DISPATCHING maps to UNKNOWN on recovery', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    await expect(
      ledger.dispatch(rec.effectId, () => Promise.reject(new Error('crash: power loss'))),
    ).rejects.toThrow();
    const recovered = ledger.crashRecover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state).toBe('UNKNOWN');
    expect(ledger.get(rec.effectId)?.state).toBe('UNKNOWN');
  });

  it('RED: blind retry with local key alone is refused', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    expect(() => ledger.requestRetry(rec.effectId, { localKey: 'idem-123' })).toThrow(
      BlindRetryRefusedError,
    );
  });

  it('RED: retry without reconcile-first is refused', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    expect(() =>
      ledger.requestRetry(rec.effectId, {
        evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
      }),
    ).toThrow(BlindRetryRefusedError);
  });

  it('RED: retry only on confirmed NOT_APPLIED + policy/approval recheck', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    // UNKNOWN must not authorize retry even with policy ALLOW.
    expect(() =>
      ledger.requestRetry(rec.effectId, {
        evidence: { observedState: 'UNKNOWN', policyDecision: 'ALLOW' },
      }),
    ).toThrow(BlindRetryRefusedError);
    // NEEDS_APPROVAL without a resolved approval must not authorize retry.
    const rec2 = ledger.prepare('op-2', 'WRITE');
    ledger.reconcile(rec2.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'NEEDS_APPROVAL' });
    expect(() =>
      ledger.requestRetry(rec2.effectId, {
        evidence: { observedState: 'NOT_APPLIED', policyDecision: 'NEEDS_APPROVAL' },
      }),
    ).toThrow(BlindRetryRefusedError);
    // NOT_APPLIED + ALLOW authorizes exactly one re-dispatch to PREPARED.
    const rec3 = ledger.prepare('op-3', 'READ');
    ledger.reconcile(rec3.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    const retried = ledger.requestRetry(rec3.effectId, {
      evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
    });
    expect(retried.state).toBe('PREPARED');
  });

  it('RED: READ retry budget is bounded', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    // Budget: 3 retries. The 4th retry request must fail.
    for (let i = 0; i < 3; i += 1) {
      ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
      ledger.requestRetry(rec.effectId, {
        evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
      });
    }
    ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    expect(() =>
      ledger.requestRetry(rec.effectId, {
        evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
      }),
    ).toThrow(RetryBudgetExhaustedError);
  });

  it('RED: WRITE/DELETE never get a retry budget', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    expect(() =>
      ledger.requestRetry(rec.effectId, {
        evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
      }),
    ).toThrow(RetryBudgetExhaustedError);
  });
});
