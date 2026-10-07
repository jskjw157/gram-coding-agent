import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreEvidence } from './health-probe.js';
import { runSupervisor } from './supervisor.js';
import { fixture, labConfig, managed } from './test-support/supervisor-fixture.js';

afterEach(() => vi.useRealTimers());
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** Keep the real stores, but advance elapsed time and deadline timers together. */
async function timedFixture() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const f = await fixture(Number.MAX_SAFE_INTEGER);
  f.clock.nowMs = Date.now;
  f.clock.sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
    f.clock.delays.push(ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('ABORTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const evidence = (generation: string): CoreEvidence => ({ ...f.evidence(generation), observedAtMs: Date.now() });
  return { ...f, evidence };
}
const run = (f: Awaited<ReturnType<typeof timedFixture>>) => runSupervisor('core', labConfig(), f.deps, f.controller.signal);
const healthyTimes = (f: Awaited<ReturnType<typeof timedFixture>>) =>
  f.statuses.filter(status => status.state === 'LOCAL_CORE_HEALTHY').map(status => status.observedAtMs);

describe('complete Core health probe deadlines', () => {
  it('allows a valid first complete probe beyond ten seconds within startup', async () => {
    const f = await timedFixture();
    const probe = vi.fn(async (child: Parameters<typeof f.deps.core.probe>[0]) => {
      await pause(15000); return f.evidence(child.generation);
    });
    f.deps.core.probe = probe;
    const work = run(f);
    try {
      await vi.advanceTimersByTimeAsync(14999);
      expect(probe).toHaveBeenCalledOnce(); expect(healthyTimes(f)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(healthyTimes(f)).toEqual([15000]);
      f.controller.abort(); await vi.advanceTimersByTimeAsync(0);
      expect(await work).toBe(0); expect(f.trace).toContain('stop:core:20000:false');
    } finally { f.controller.abort(); await vi.advanceTimersByTimeAsync(0); await work; }
  });

  it('allows a valid periodic complete probe beyond ten seconds and preserves cadence', async () => {
    const f = await timedFixture(); let probes = 0;
    f.deps.core.probe = async child => {
      if (++probes === 2) await pause(15000);
      return f.evidence(child.generation);
    };
    const work = run(f);
    try {
      await vi.advanceTimersByTimeAsync(5000); expect(probes).toBe(2); expect(healthyTimes(f)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(14999); expect(healthyTimes(f)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(healthyTimes(f)).toEqual([0, 20000]); expect(f.clock.delays).toEqual([5000, 5000]);
      f.controller.abort(); await vi.advanceTimersByTimeAsync(0); expect(await work).toBe(0);
    } finally { f.controller.abort(); await vi.advanceTimersByTimeAsync(0); await work; }
  });

  it('bounds a non-cooperative periodic probe at sixty seconds and ignores its late evidence', async () => {
    const f = await timedFixture(); const late = deferred<CoreEvidence>(); let probes = 0;
    let active: AbortSignal | undefined; let generation = ''; let result: number | undefined;
    f.deps.core.probe = async (child, signal) => {
      generation = child.generation;
      if (++probes === 1) return f.evidence(generation);
      active = signal; return late.promise;
    };
    const work = run(f).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(64999);
      expect(probes).toBe(2); expect(result).toBeUndefined(); expect(active?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await work;
      expect(result).toBe(1); expect(active?.aborted).toBe(true); expect(healthyTimes(f)).toEqual([0]);
      expect((await f.deps.lifecycle.read('core')).history.exitsMs).toEqual([65000]);
      late.resolve(f.evidence(generation)); await vi.advanceTimersByTimeAsync(0);
      expect(healthyTimes(f)).toEqual([0]); expect(probes).toBe(2);
    } finally { f.controller.abort(); late.resolve(f.evidence(generation)); await vi.advanceTimersByTimeAsync(0); await work; }
  });

  it('gives the initial probe only the startup time remaining after spawn without resetting it', async () => {
    const f = await timedFixture(); const signals: AbortSignal[] = []; let result: number | undefined;
    f.deps.core.spawn = async (_config, generation) => { await pause(45000); return managed('core', generation); };
    f.deps.core.probe = async (child, signal) => {
      signals.push(signal); await pause(20000); return f.evidence(child.generation);
    };
    const work = run(f).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(59999);
      expect(result).toBeUndefined(); expect(signals).toHaveLength(1); expect(healthyTimes(f)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); await work;
      expect(result).toBe(1); expect(signals[0]?.aborted).toBe(true); expect(healthyTimes(f)).toEqual([]);
      expect((await f.deps.lifecycle.read('core')).history.exitsMs).toEqual([60000]);
      expect(f.trace).toContain('stop:core:20000:false');
      await vi.advanceTimersByTimeAsync(5000);
      expect(signals).toHaveLength(1); expect(healthyTimes(f)).toEqual([]);
    } finally { f.controller.abort(); await vi.advanceTimersByTimeAsync(0); await work; }
  });

  it.each(['caller', 'child'] as const)('lets %s cancellation end a pending complete probe before its deadline', async source => {
    const f = await timedFixture(); const late = deferred<CoreEvidence>(); const exited = deferred<void>();
    let active: AbortSignal | undefined; let generation = ''; let result: number | undefined;
    f.deps.core.spawn = async (_config, value) => ({ ...managed('core', value), exited: exited.promise });
    f.deps.core.probe = async (child, signal) => { generation = child.generation; active = signal; return late.promise; };
    const work = run(f).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(5000); expect(result).toBeUndefined(); expect(active?.aborted).toBe(false);
      if (source === 'caller') f.controller.abort('SYNTHETIC_PRIVATE_ABORT'); else exited.resolve();
      await vi.advanceTimersByTimeAsync(0); await work;
      expect(result).toBe(source === 'caller' ? 0 : 1); expect(active?.aborted).toBe(true);
      late.resolve(f.evidence(generation)); await vi.advanceTimersByTimeAsync(0);
      expect(healthyTimes(f)).toEqual([]); expect(JSON.stringify(f.statuses)).not.toContain('SYNTHETIC');
      expect(f.trace.filter(value => value.startsWith('stop:core:'))).toHaveLength(source === 'caller' ? 1 : 0);
    } finally { f.controller.abort(); late.resolve(f.evidence(generation)); await vi.advanceTimersByTimeAsync(0); await work; }
  });

  it('rejects first healthy evidence at the absolute startup deadline before timer dispatch', async () => {
    const f = await timedFixture(); const entered = deferred<void>(); let result: number | undefined;
    f.deps.core.probe = async child => {
      vi.setSystemTime(60000); entered.resolve(); return f.evidence(child.generation);
    };
    const work = run(f).then(value => { result = value; });
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(0);
      expect(healthyTimes(f)).toEqual([]); expect(result).toBe(1);
    } finally { f.controller.abort(); await vi.advanceTimersByTimeAsync(0); await work; }
  });
});
