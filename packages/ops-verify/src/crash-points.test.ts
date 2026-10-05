// crash-points.test.ts — Gate A fixture matrix, crash-point rows (D12/D13).
//
// Each test injects a crash at one point and asserts the D12 wiring through
// CrashSafeExecutor: UNKNOWN preserved until queried, tri-state resolved via
// ground-truth query, reconcile before any retry, zero blind retransmits.
// RED history: these rows failed against NaiveExecutor (see commit
// 165edfd and naive-wiring-pinned.test.ts for the recorded behavior).
import { describe, expect, it } from 'vitest';
import { CrashSafeExecutor } from './harness.js';

describe('Gate A crash-point matrix (UNKNOWN -> query -> tri-state, zero blind retransmits)', () => {
  it('CP1 before-ledger: intent linkage survives, exactly one intent, one send', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('before-ledger');
    expect(outcome.intentCount).toBe(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP2 after-PREPARED: prepared effect is dispatched, never orphaned', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('after-prepared');
    expect(outcome.finalState).toBe('CONFIRMED');
    expect(outcome.sends).toBe(1);
  });

  it('CP3 DISPATCHING-committed-pre-send: UNKNOWN observed, query before any send', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('dispatching-pre-send');
    expect(outcome.unknownObserved).toBe(true);
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP4 send-connection-loss: query resolves NOT_APPLIED, WRITE never blind-retries', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('send-connection-loss');
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('NOT_APPLIED:REAPPROVAL_REQUIRED');
  });

  it('CP5 applied-response-lost: query resolves CONFIRMED, zero resends', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('applied-response-lost');
    expect(outcome.unknownObserved).toBe(true);
    expect(outcome.queries).toBeGreaterThanOrEqual(1);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP6 response-before-receipt: receipt rewritten idempotently, zero resends', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('response-before-receipt');
    expect(outcome.sends).toBe(1);
    expect(outcome.receipts).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP7 receipt-before-task-update: task completes idempotently, zero re-applies', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('receipt-before-task-update');
    expect(outcome.sends).toBe(1);
    expect(outcome.taskUpdates).toBe(1);
    expect(outcome.finalState).toBe('CONFIRMED');
  });

  it('CP8 during-reconcile: stays UNKNOWN, ambiguous surfaced, zero retries', async () => {
    const executor = new CrashSafeExecutor();
    const outcome = await executor.run('during-reconcile');
    expect(outcome.unknownObserved).toBe(true);
    expect(outcome.sends).toBe(1);
    expect(outcome.finalState).toBe('UNKNOWN');
  });
});
