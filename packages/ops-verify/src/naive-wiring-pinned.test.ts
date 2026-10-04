// naive-wiring-pinned.test.ts — pins the recorded RED behavior of the
// unfixed wiring (NaiveExecutor): blind retransmit or state loss at every
// crash point. Guards the harness itself: if naive wiring ever stops
// violating D12, this file fails and the matrix assumptions need review.
import { describe, expect, it } from 'vitest';
import { NaiveExecutor } from './harness.js';

describe('unfixed wiring pins (RED behavior record)', () => {
  it('CP1 loses intent linkage: two intents for one client request', async () => {
    const outcome = await new NaiveExecutor().run('before-ledger');
    expect(outcome.intentCount).toBe(2);
  });

  it('CP2 orphans the prepared effect: work silently dropped', async () => {
    const outcome = await new NaiveExecutor().run('after-prepared');
    expect(outcome.finalState).toBe('DROPPED');
    expect(outcome.sends).toBe(0);
  });

  it('CP5 blind-retransmits a WRITE: duplicate remote apply, zero queries', async () => {
    const outcome = await new NaiveExecutor().run('applied-response-lost');
    expect(outcome.sends).toBe(2);
    expect(outcome.queries).toBe(0);
  });

  it('CP8 never observes UNKNOWN: success claimed with zero queries', async () => {
    const outcome = await new NaiveExecutor().run('during-reconcile');
    expect(outcome.unknownObserved).toBe(false);
    expect(outcome.queries).toBe(0);
  });
});
