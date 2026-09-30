import { describe, expect, it, vi } from 'vitest';
import { LeaseHeartbeat, type IntervalScheduler } from './lease-heartbeat.js';

/**
 * `drain()` exists so that a lease can be quiesced without releasing it while
 * guaranteeing that no heartbeat callback is still running. Without it,
 * `quiesce()` could resolve while a beat is mid-flight, and that beat would
 * then touch SQLite after the database was closed.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('LeaseHeartbeat', () => {
  it('resolves drain immediately when no beat is in flight', async () => {
    const scheduler: IntervalScheduler = {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    };
    const heartbeat = new LeaseHeartbeat(
      scheduler,
      15_000,
      async () => undefined,
      () => undefined,
    );
    heartbeat.start();

    await expect(heartbeat.drain()).resolves.toBeUndefined();
  });

  it('does not resolve drain until an in-flight beat has finished', async () => {
    let tick: (() => void) | undefined;
    const scheduler: IntervalScheduler = {
      setInterval: vi.fn((callback: () => void) => {
        tick = callback;
        return 1;
      }),
      clearInterval: vi.fn(),
    };
    const beat = deferred();
    const beatStarted = deferred();
    const heartbeat = new LeaseHeartbeat(
      scheduler,
      15_000,
      () => {
        beatStarted.resolve();
        return beat.promise;
      },
      () => undefined,
    );
    heartbeat.start();

    expect(tick).toBeDefined();
    tick?.();
    await beatStarted.promise;

    let drained = false;
    const pending = heartbeat.drain().then(() => {
      drained = true;
    });

    // The beat is still running, so drain must stay pending. Flush microtasks
    // so a wrongly-resolved drain would be observable here.
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    beat.resolve();
    await pending;
    expect(drained).toBe(true);
  });

  it('drain also waits for the failure recovery callback', async () => {
    let tick: (() => void) | undefined;
    const scheduler: IntervalScheduler = {
      setInterval: vi.fn((callback: () => void) => {
        tick = callback;
        return 1;
      }),
      clearInterval: vi.fn(),
    };
    const beatStarted = deferred();
    const recovery = deferred();
    const heartbeat = new LeaseHeartbeat(
      scheduler,
      15_000,
      () => {
        beatStarted.resolve();
        return Promise.reject(new Error('lease lost'));
      },
      () => recovery.promise,
    );
    heartbeat.start();

    tick?.();
    await beatStarted.promise;

    let drained = false;
    const pending = heartbeat.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    recovery.resolve();
    await pending;
    expect(drained).toBe(true);
  });

  it('drain never rejects even when the beat and recovery both fail', async () => {
    let tick: (() => void) | undefined;
    const scheduler: IntervalScheduler = {
      setInterval: vi.fn((callback: () => void) => {
        tick = callback;
        return 1;
      }),
      clearInterval: vi.fn(),
    };
    const beatStarted = deferred();
    const heartbeat = new LeaseHeartbeat(
      scheduler,
      15_000,
      () => {
        beatStarted.resolve();
        return Promise.reject(new Error('boom'));
      },
      () => Promise.reject(new Error('recovery failed too')),
    );
    heartbeat.start();

    tick?.();
    await beatStarted.promise;

    await expect(heartbeat.drain()).resolves.toBeUndefined();
  });
});
