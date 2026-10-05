import { describe, expect, it } from 'vitest';
import {
  BlindRetryRefusedError,
  EffectLedger,
  LedgerError,
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

describe('EffectLedger Gate A F1: UNKNOWN settles only via provider-query evidence', () => {
  it('RED F1: UNKNOWN + provider-confirmed-applied settles to CONFIRMED', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const settled = ledger.reconcile(rec.effectId, {
      observedState: 'CONFIRMED',
      policyDecision: 'ALLOW',
      providerEvidence: 'provider-confirmed-applied',
    });
    expect(settled.state).toBe('CONFIRMED');
    expect(ledger.get(rec.effectId)?.state).toBe('CONFIRMED');
  });

  it('RED F1: UNKNOWN + provider-confirmed-not-applied settles to NOT_APPLIED', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const settled = ledger.reconcile(rec.effectId, {
      observedState: 'NOT_APPLIED',
      policyDecision: 'ALLOW',
      providerEvidence: 'provider-confirmed-not-applied',
    });
    expect(settled.state).toBe('NOT_APPLIED');
    // Then retry flows only through the governed path (policy/approval recheck).
    const retried = ledger.requestRetry(rec.effectId, {
      evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
    });
    expect(retried.state).toBe('PREPARED');
  });

  it('RED F1: UNKNOWN without provider evidence stays UNKNOWN', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const settled = ledger.reconcile(rec.effectId, {
      observedState: 'UNKNOWN',
      policyDecision: 'ALLOW',
    });
    expect(settled.state).toBe('UNKNOWN');
  });

  it('RED F1: evidence-less UNKNOWN->CONFIRMED settlement stays refused', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    expect(() =>
      ledger.reconcile(rec.effectId, { observedState: 'CONFIRMED', policyDecision: 'ALLOW' }),
    ).toThrow(LedgerError);
    expect(ledger.get(rec.effectId)?.state).toBe('UNKNOWN');
  });

  it('RED F1: mismatched provider evidence stays refused', () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    expect(() =>
      ledger.reconcile(rec.effectId, {
        observedState: 'CONFIRMED',
        policyDecision: 'ALLOW',
        providerEvidence: 'provider-confirmed-not-applied',
      }),
    ).toThrow(LedgerError);
    expect(ledger.get(rec.effectId)?.state).toBe('UNKNOWN');
  });
});

describe('EffectLedger durable wiring T4/D12 RED (rehydrate + provider-query lane API)', () => {
  it('RED T4i: restart loses ledger state (fresh ledger sees nothing)', () => {
    const journal: EffectRecord[] = [];
    const ledger1 = new EffectLedger((record: EffectRecord) => {
      journal.push(record);
    });
    const rec = ledger1.prepare('op-1', 'WRITE');
    expect(journal).toHaveLength(1);
    const fresh = new EffectLedger();
    expect(fresh.get(rec.effectId)).toBeNull();
    // Rehydrate from the durable journal restores the record; crash recovery
    // then maps the interrupted DISPATCHING to UNKNOWN instead of losing it.
    const restored = new EffectLedger();
    restored.rehydrate(journal);
    expect(restored.get(rec.effectId)?.state).toBe('PREPARED');
  });

  it('RED T4j: DISPATCHING committed to the journal survives restart as UNKNOWN after recovery', async () => {
    const journal: EffectRecord[] = [];
    const ledger1 = new EffectLedger((record: EffectRecord) => {
      journal.push(record);
    });
    const rec = ledger1.prepare('op-1', 'WRITE');
    await expect(
      ledger1.dispatch(rec.effectId, () => Promise.reject(new Error('crash: power loss'))),
    ).rejects.toThrow();
    const lastCommitted = journal[journal.length - 1];
    expect(lastCommitted?.state).toBe('DISPATCHING');
    const restored = new EffectLedger();
    restored.rehydrate(journal);
    expect(restored.get(rec.effectId)?.state).toBe('DISPATCHING');
    const recovered = restored.crashRecover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state).toBe('UNKNOWN');
    expect(restored.get(rec.effectId)?.state).toBe('UNKNOWN');
  });

  it('RED T4k: UNKNOWN settles via the provider-query lane API (applied)', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const seen: string[] = [];
    const settled = await ledger.queryAndSettleUnknown(rec.effectId, (operationId) => {
      seen.push(operationId);
      return Promise.resolve('applied');
    });
    expect(seen).toEqual(['op-1']);
    expect(settled.state).toBe('CONFIRMED');
    expect(ledger.get(rec.effectId)?.state).toBe('CONFIRMED');
  });

  it('RED T4l: UNKNOWN settles via the provider-query lane API (not-applied, then governed retry)', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'READ');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const settled = await ledger.queryAndSettleUnknown(rec.effectId, () =>
      Promise.resolve('not-applied'),
    );
    expect(settled.state).toBe('NOT_APPLIED');
    const retried = ledger.requestRetry(rec.effectId, {
      evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
    });
    expect(retried.state).toBe('PREPARED');
  });

  it('RED T4m: provider-query answering unknown leaves UNKNOWN stuck (still needs evidence)', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    ledger.reconcile(rec.effectId, { observedState: 'UNKNOWN', policyDecision: 'ALLOW' });
    const settled = await ledger.queryAndSettleUnknown(rec.effectId, () =>
      Promise.resolve('unknown'),
    );
    expect(settled.state).toBe('UNKNOWN');
    expect(ledger.get(rec.effectId)?.state).toBe('UNKNOWN');
  });

  it('RED T4n: provider-query settlement refuses non-UNKNOWN effects', async () => {
    const ledger = new EffectLedger();
    const rec = ledger.prepare('op-1', 'WRITE');
    await expect(
      ledger.queryAndSettleUnknown(rec.effectId, () => Promise.resolve('applied')),
    ).rejects.toThrow(LedgerError);
    expect(ledger.get(rec.effectId)?.state).toBe('PREPARED');
  });

  it('RED F2: journal hook carries the full record for the WP-07 persistence target', () => {
    const journal: EffectRecord[] = [];
    const ledger = new EffectLedger((record: EffectRecord) => {
      journal.push(record);
    });
    const rec = ledger.prepare('op-1', 'READ');
    ledger.reconcile(rec.effectId, { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' });
    const last = journal[journal.length - 1];
    // The persistence lane must be able to rebuild retry eligibility from the
    // journal alone: reconciledObserved has to travel on the record.
    expect(last?.reconciled).toBe(true);
    expect(last?.reconciledObserved).toBe('NOT_APPLIED');
    // And a restart replayed from the journal keeps the governed retry path.
    const restored = new EffectLedger();
    restored.rehydrate(journal);
    const retried = restored.requestRetry(rec.effectId, {
      evidence: { observedState: 'NOT_APPLIED', policyDecision: 'ALLOW' },
    });
    expect(retried.state).toBe('PREPARED');
  });
});
