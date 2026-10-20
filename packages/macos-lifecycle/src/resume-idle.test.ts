import { afterEach, expect, it, vi } from 'vitest';
import { waitForResumeIdle } from './resume-idle.js';
afterEach(() => vi.useRealTimers());
it('observes occupied sockets draining without changing a service', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const result = waitForResumeIdle(async () => ({ core: ++calls < 3 ? 'occupied' : 'free', tunnel: 'free' }));
  await vi.advanceTimersByTimeAsync(401);
  expect(await result).toBe(true);
  expect(calls).toBe(3);
});
it('refuses unknown observations immediately', async () => {
  const read = vi.fn(async () => ({ core: 'unknown' as const, tunnel: 'free' as const }));
  expect(await waitForResumeIdle(read)).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
});
it.each(['occupied', 'never'] as const)('bounds %s observations and returns without a stop retry', async (kind) => {
  vi.useFakeTimers();
  let settled = false;
  const result = waitForResumeIdle(async () =>
    kind === 'never' ? new Promise<never>(() => {}) : { core: 'occupied', tunnel: 'free' },
  ).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(90001);
  expect(settled).toBe(true);
  expect(await result).toBe(false);
});
