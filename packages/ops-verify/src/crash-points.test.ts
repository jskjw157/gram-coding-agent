// crash-points.test.ts — Gate A fixture matrix, crash-point rows (D12/D13).
//
// Each test injects a crash at one point and asserts the D12 wiring:
// UNKNOWN preserved until queried, tri-state resolved via ground-truth
// query, reconcile before any retry, zero blind retransmits. RED: driven
// against NaiveExecutor (unfixed wiring) — every row FAILS and the failure
// output records the actual unfixed behavior.
import { describe, expect, it } from 'vitest';
import { NaiveExecutor } from './harness.js';

describe('Gate A crash-point matrix (UNKNOWN -> query -> tri-state, zero blind retransmits)', () => {
  it('CP1 before-ledger: intent linkage survives, exactly one intent, one send', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('before-ledger');
    // RED actual: intentCount == 2 (fresh operationId minted, linkage lost).
    expect(outcome.intentCount).toBe(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP2 after-PREPARED: prepared effect is dispatched, never orphaned', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('after-prepared');
    // RED actual: DROPPED, sends == 0 (orphan PREPARED, work lost).
    expect(outcome.finalState).toBe('CONFIRMED');
    expect(outcome.sends).toBe(1);
  });

  it('CP3 DISPATCHING-committed-pre-send: UNKNOWN observed, query before any send', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('dispatching-pre-send');
    // RED actual: unknownObserved == false, queries == 0 (assumed, not queried).
    expect(outcome.unknownObserved).toBe(true);
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP4 send-connection-loss: query resolves NOT_APPLIED, WRITE never blind-retries', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('send-connection-loss');
    // RED actual: sends == 2, queries == 0 (blind retransmit of a WRITE).
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.sends).toBe(1);
  });

  it('CP5 applied-response-lost: query resolves CONFIRMED, zero resends', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('applied-response-lost');
    // RED actual: sends == 2 (duplicate remote apply), queries == 0.
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP6 response-before-receipt: receipt rewritten idempotently, zero resends', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('response-before-receipt');
    // RED actual: sends == 2 (blind re-apply after losing the receipt).
    expect(outcome.sends).toBe(1);
    expect(outcome.receipts).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP7 receipt-before-task-update: task completes idempotently, zero re-applies', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('receipt-before-task-update');
    // RED actual: sends == 2 (full re-execution double-applies).
    expect(outcome.sends).toBe(1);
    expect(outcome.taskUpdates).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP8 during-reconcile: stays UNKNOWN, ambiguous surfaced, zero retries', async () => {
    const executor = new NaiveExecutor();
    const outcome = await executor.run('during-reconcile');
    // RED actual: CONFIRMED with queries == 0 (never queried, never UNKNOWN).
    expect(outcome.unknownObserved).toBe(true);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('UNKNOWN');
  });
});
