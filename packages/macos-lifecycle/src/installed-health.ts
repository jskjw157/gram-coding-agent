import type { Role } from './contracts.js';
import type { InstalledHealthObserver } from './a-native-observer.js';
import { abortable } from './health-probe.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from './release-review-budget.js';

/** Running-control observations retain their original shared 60-second budget. */
export async function runningControlHealthy(
  tunnelEnabled: boolean,
  observer: Pick<InstalledHealthObserver, 'healthy'>,
): Promise<boolean> {
  const deadline = Date.now() + RELEASE_REVIEW_TIMEOUT_MS;
  const controller = new AbortController();
  // Retain the original single hard timer across roles and retries. A wall
  // clock rollback must not grant another real 60-second observation window.
  const timer = setTimeout(() => controller.abort(), RELEASE_REVIEW_TIMEOUT_MS);
  try {
    if (!await boundedInstalledHealth('core', observer, deadline, controller.signal)) return false;
    return !tunnelEnabled || await boundedInstalledHealth('tunnel', observer, deadline, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Read-only complete observations share one absolute caller-owned deadline.
 * A stale/unknown sample never authorizes control; only a new independently
 * verified healthy sample can succeed. No service or recovery operation here.
 */
async function boundedInstalledHealth(
  role: Role,
  observer: Pick<InstalledHealthObserver, 'healthy'>,
  deadline: number,
  signal: AbortSignal,
): Promise<boolean> {
  while (!signal.aborted && Date.now() < deadline) {
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      if (await abortable(observer.healthy(role, active), active) === true
        && !active.aborted && Date.now() < deadline) return true;
    } catch (error) {
      if (!active.aborted) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (signal.aborted || Date.now() >= deadline) break;
    try {
      await abortable(new Promise<void>(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now()))), signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return false;
}
