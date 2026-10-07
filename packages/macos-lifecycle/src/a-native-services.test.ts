import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemServiceHandle } from './a-native-services.js';

const probes = vi.hoisted(() => ({ healthy: vi.fn() }));
vi.mock('./a-native-observer.js', () => ({
  createInstalledHealthObserver: () => ({ healthy: probes.healthy }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { vi.useFakeTimers(); probes.healthy.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('installed health observation deadline', () => {
  it('allows a complete sealed review longer than the short HTTP budget', async () => {
    const ready = deferred<boolean>();
    const entered = deferred<AbortSignal>();
    probes.healthy.mockImplementation((_role: string, signal: AbortSignal) => {
      entered.resolve(signal);
      return ready.promise;
    });
    const work = createSystemServiceHandle(async () => true).ownedHealthy('core');
    const signal = await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(21_507);
      expect(signal.aborted).toBe(false);
      ready.resolve(true);
      expect(await work).toBe(true);
      expect(probes.healthy).toHaveBeenCalledTimes(1);
    } finally {
      ready.resolve(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await work;
    }
  });

  it('returns false at sixty seconds even when an observer ignores abort', async () => {
    const ready = deferred<boolean>();
    const entered = deferred<AbortSignal>();
    probes.healthy.mockImplementation((_role: string, signal: AbortSignal) => {
      entered.resolve(signal);
      return ready.promise;
    });
    let result: boolean | undefined;
    const work = createSystemServiceHandle(async () => true).ownedHealthy('core');
    void work.then(value => { result = value; });
    const signal = await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal.aborted).toBe(true);
      expect(result).toBe(false);
      expect(probes.healthy).toHaveBeenCalledTimes(1);
    } finally {
      ready.resolve(true);
      await work;
    }
    expect(result).toBe(false);
  });

  it('gives retries only the remaining overall deadline', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const entered = deferred<AbortSignal>();
    probes.healthy.mockImplementationOnce(() => first.promise);
    probes.healthy.mockImplementation((_role: string, signal: AbortSignal) => {
      entered.resolve(signal);
      return second.promise;
    });
    let result: boolean | undefined;
    const work = createSystemServiceHandle(async () => true).ownedHealthy('core');
    void work.then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(40_000);
      first.resolve(false);
      await vi.advanceTimersByTimeAsync(200);
      const signal = await entered.promise;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(19_800);
      expect(signal.aborted).toBe(true);
      expect(result).toBe(false);
      expect(probes.healthy).toHaveBeenCalledTimes(2);
    } finally {
      first.resolve(false);
      second.resolve(true);
      await work;
    }
    expect(result).toBe(false);
  });
});
