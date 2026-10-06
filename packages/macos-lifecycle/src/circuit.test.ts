import { describe, expect, it } from 'vitest';
import { beginAttempt, freshHistory, parseHistory, recordExit, recoverAttempt, resetFailure, type CircuitHistory } from './circuit.js';

const fresh = (): CircuitHistory => ({ schemaVersion: 1, blocked: false, lastSeenMs: 0,
  exitsMs: [], lastGeneration: null, activeAttempt: null });
const invalid = /^INVALID_HISTORY$/;
function blocked(): CircuitHistory {
  let h = fresh();
  for (const t of [1000, 2000, 3000, 4000, 5000]) {
    h = beginAttempt(h, `gen-${t}`, t);
    h = recordExit(h, t, false);
  }
  return h;
}
describe('persistent restart budget accounting', () => {
  it('creates an explicit fresh history, not a recovered one', () => {
    expect(freshHistory(123)).toEqual({ ...fresh(), lastSeenMs: 123 });
  });
  it('opens on the fifth unexpected exit, not the fourth', () => {
    let h = fresh();
    for (const t of [1, 2, 3, 4]) h = recordExit(h, t, false);
    expect(h.blocked).toBe(false);
    expect(recordExit(h, 5, false).blocked).toBe(true);
  });
  it('keeps a circuit open across time, reload and recovery', () => {
    const h = parseHistory(JSON.parse(JSON.stringify(blocked())));
    expect(recoverAttempt(h, 900000).blocked).toBe(true);
    expect(() => beginAttempt(h, 'new', 900000)).toThrow(/^RESTART_BUDGET$/);
  });
  it('excludes an exit at the exact 300000ms boundary', () => {
    const h = { ...fresh(), exitsMs: [1, 2, 3, 4], lastSeenMs: 4 };
    expect(recordExit(h, 300001, false)).toMatchObject({ blocked: false, exitsMs: [2, 3, 4, 300001] });
    expect(recordExit(h, 300000, false).blocked).toBe(true);
  });
  it('does not count an intentional stop as an unexpected exit', () => {
    const active = beginAttempt(fresh(), 'g1', 100);
    expect(recordExit(active, 200, true)).toEqual({ ...fresh(), lastSeenMs: 200, lastGeneration: 'g1' });
  });
  it('records an active attempt before a caller could spawn', () => {
    expect(beginAttempt(fresh(), 'g1', 100)).toEqual({ ...fresh(), lastSeenMs: 100,
      lastGeneration: 'g1', activeAttempt: { generation: 'g1', startedAtMs: 100 } });
  });
  it('counts a hard-killed active attempt only once after durable reload', () => {
    const active = beginAttempt(fresh(), 'g1', 100);
    const first = recoverAttempt(parseHistory(JSON.parse(JSON.stringify(active))), 200);
    expect(first.exitsMs).toEqual([200]); expect(first.activeAttempt).toBeNull();
    const second = recoverAttempt(parseHistory(JSON.parse(JSON.stringify(first))), 300);
    expect(second.exitsMs).toEqual([200]);
  });
  it('five incomplete executions exhaust the budget', () => {
    let h = fresh();
    for (let n = 1; n <= 5; n++) h = recoverAttempt(beginAttempt(h, `g${n}`, n * 100), n * 100 + 1);
    expect(h.blocked).toBe(true); expect(h.exitsMs).toHaveLength(5);
  });
  it('refuses a second active attempt without losing the first', () => {
    const h = beginAttempt(fresh(), 'g1', 1); const bytes = JSON.stringify(h);
    expect(() => beginAttempt(h, 'g1', 2)).toThrow(/^ACTIVE_ATTEMPT$/);
    expect(() => beginAttempt(h, 'g2', 2)).toThrow(/^ACTIVE_ATTEMPT$/);
    expect(JSON.stringify(h)).toBe(bytes);
  });
  it('refuses immediate generation reuse even after intentional exit', () => {
    const h = recordExit(beginAttempt(fresh(), 'g1', 1), 2, true);
    expect(() => beginAttempt(h, 'g1', 3)).toThrow(invalid);
    expect(beginAttempt(h, 'g2', 3).lastGeneration).toBe('g2');
  });
  it('reset acknowledges the stopped generation, without spawning', () => {
    const h = blocked();
    expect(() => resetFailure(h, 'stale', 6000)).toThrow(invalid);
    const reset = resetFailure(h, 'gen-5000', 6000);
    expect(reset).toEqual({ ...fresh(), lastSeenMs: 6000, lastGeneration: 'gen-5000' });
    expect(beginAttempt(reset, 'fresh-generation', 7000).activeAttempt?.generation).toBe('fresh-generation');
  });
  it('refuses reset while an attempt is unresolved', () => {
    expect(() => resetFailure(beginAttempt(fresh(), 'g1', 1), 'g1', 2)).toThrow(/^ACTIVE_ATTEMPT$/);
  });
  it('never mutates input history or aliases returned arrays', () => {
    const h = beginAttempt(fresh(), 'g1', 100); const bytes = JSON.stringify(h);
    const parsed = parseHistory(h); parsed.exitsMs.push(5); if (parsed.activeAttempt) parsed.activeAttempt.generation = 'other';
    recoverAttempt(h, 101); expect(JSON.stringify(h)).toBe(bytes);
  });
  it('bounds sticky history even if exit reports continue', () => {
    let h = blocked(); for (let i = 6000; i < 10000; i++) h = recordExit(h, i, false);
    expect(h.blocked).toBe(true); expect(h.exitsMs).toHaveLength(5);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid now %s', now => {
    expect(() => freshHistory(now)).toThrow(invalid);
    expect(() => recordExit(fresh(), now, false)).toThrow(invalid);
    expect(() => recoverAttempt(fresh(), now)).toThrow(invalid);
  });
  it('refuses reversed time without creating a reset history', () => {
    const h = beginAttempt(fresh(), 'g1', 20);
    expect(() => recoverAttempt(h, 19)).toThrow(invalid);
    expect(() => recordExit(h, 19, true)).toThrow(invalid);
    expect(() => resetFailure(h, 'g1', 19)).toThrow(invalid);
  });
  it.each(['', '../x', 'contains space', 'line\n', 'g'.repeat(129)])('refuses invalid generation %j', generation => {
    expect(() => beginAttempt(fresh(), generation, 1)).toThrow(invalid);
  });
  it('rejects nonboolean intentional rather than truthiness', () => {
    expect(() => recordExit(fresh(), 1, 'false' as never)).toThrow(invalid);
  });
  it.each([
    null, [], {}, { ...fresh(), schemaVersion: 2 }, { ...fresh(), blocked: 0 },
    { ...fresh(), lastSeenMs: -1 }, { ...fresh(), exitsMs: [1] },
    { ...fresh(), exitsMs: [2, 1], lastSeenMs: 2 }, { ...fresh(), exitsMs: [0, 0, 0, 0, 0] },
    { ...fresh(), blocked: true, exitsMs: Array(6).fill(0) },
    { ...fresh(), extra: 'synthetic-sensitive' }, { ...fresh(), activeAttempt: { generation: 'g', startedAtMs: 0 } },
    { ...fresh(), lastGeneration: 'g', activeAttempt: { generation: 'g', startedAtMs: 1 } },
    { ...fresh(), lastGeneration: 'g', activeAttempt: { generation: 'g', startedAtMs: 0, extra: 1 } },
  ])('rejects invalid persisted shape %#', value => { expect(() => parseHistory(value)).toThrow(invalid); });
  it('does not invoke getters in untrusted input', () => {
    let calls = 0;
    const h = { ...fresh(), get blocked() { calls++; return false; } };
    expect(() => parseHistory(h)).toThrow(invalid); expect(calls).toBe(0);
  });
  it('rejects sparse arrays, symbols, hidden data and nonstandard prototypes', () => {
    const sparse = Array(2); sparse[1] = 0;
    for (const h of [{ ...fresh(), exitsMs: sparse }, { ...fresh(), [Symbol('extra')]: true },
      Object.defineProperty(fresh(), 'extra', { value: true }), Object.assign(Object.create({}), fresh())]) {
      expect(() => parseHistory(h)).toThrow(invalid);
    }
  });
});
