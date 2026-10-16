import { performance } from 'node:perf_hooks';

/** CI fixture synchronization only. Port idleness is never ownership or health. */
export async function waitForIdlePorts(probe, {
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 90_000,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    // The native read-only probe has its own two-second command timeout.
    const ports = await probe();
    if (now() >= deadline) break;
    if (!['free', 'occupied'].includes(ports?.core) || !['free', 'occupied'].includes(ports?.tunnel)) {
      throw new Error('FIXTURE_PORTS_UNKNOWN');
    }
    if (ports.core === 'free' && ports.tunnel === 'free') return;
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  }
  throw new Error('FIXTURE_PORTS_NOT_IDLE');
}
