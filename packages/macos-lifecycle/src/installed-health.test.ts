import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runningControlHealthy } from './installed-health.js';
import { currentStatus } from './telemetry.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(30_050); });
afterEach(() => vi.useRealTimers());
const owner = { role: 'core' as const, generation: 'current', releaseDigest: 'a'.repeat(64) };
const status = (observedAtMs: number, generation = owner.generation) => ({
  schemaVersion: 1, ...owner, generation, observedAtMs, state: 'LOCAL_CORE_HEALTHY', code: 'OK', attemptCount: 0,
});

describe('running control health sampling within the existing review budget', () => {
  it('waits through an actual 30.7-second publication gap for independently fresh status', async () => {
    let published = status(0);
    const healthy = vi.fn(async () => currentStatus(published, owner, Date.now()) !== null);
    let result: boolean | undefined;
    const work = runningControlHealthy(false, { healthy });
    void work.then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(650);
    expect(result).toBeUndefined();
    published = status(Date.now());
    await vi.advanceTimersByTimeAsync(150);
    expect(await work).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(5);
  });

  it.each(['stale', 'future', 'foreign'] as const)('never accepts continuing %s evidence or extends the absolute budget', async kind => {
    const healthy = vi.fn(async () => currentStatus(
      status(kind === 'stale' ? 0 : kind === 'future' ? Date.now() + 1 : Date.now(), kind === 'foreign' ? 'foreign' : 'current'),
      owner, Date.now(),
    ) !== null);
    const work = runningControlHealthy(false, { healthy });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await work).toBe(false);
    expect(healthy).toHaveBeenCalledTimes(300);
  });

  it('aborts a non-cooperative observation at the shared deadline and ignores its late result', async () => {
    let resolve!: (value: boolean) => void;
    let signal!: AbortSignal;
    const healthy = vi.fn((_role: string, active: AbortSignal) => {
      signal = active; return new Promise<boolean>(done => { resolve = done; });
    });
    const work = runningControlHealthy(false, { healthy });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await work).toBe(false);
    expect(signal.aborted).toBe(true);
    resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('refuses a late healthy result before deadline timer dispatch', async () => {
    const deadline = Date.now() + 60_000;
    const healthy = vi.fn(async () => { vi.setSystemTime(deadline); return true; });
    expect(await runningControlHealthy(false, { healthy })).toBe(false);
  });

  it('gives tunnel only the remaining shared budget after core observation', async () => {
    const signals: AbortSignal[] = [];
    const healthy = vi.fn(async (role: string, signal: AbortSignal) => {
      signals.push(signal);
      if (role === 'core') {
        await new Promise(resolve => setTimeout(resolve, 45_000)); return true;
      }
      return new Promise<boolean>(() => undefined);
    });
    let result: boolean | undefined;
    const work = runningControlHealthy(true, { healthy });
    void work.then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(result).toBeUndefined();
    expect(healthy.mock.calls.map(([role]) => role)).toEqual(['core', 'tunnel']);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toBe(false);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('does not reinterpret a non-abort observer exception as healthy', async () => {
    const healthy = vi.fn(async () => { throw new Error('STATE_IO'); });
    await expect(runningControlHealthy(false, { healthy })).rejects.toThrow('STATE_IO');
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('retains the original hard deadline when the wall clock moves backward', async () => {
    const healthy = vi.fn(async () => false);
    let result: boolean | undefined;
    const work = runningControlHealthy(false, { healthy });
    void work.then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(0);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toBe(false);
    const calls = healthy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthy).toHaveBeenCalledTimes(calls);
  });
});
