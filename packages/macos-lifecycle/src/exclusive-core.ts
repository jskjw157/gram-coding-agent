import { configDigest, parseConfig } from './config.js';
import type { ExecutionLease, ExecutionLeaseStore } from './execution-lease.js';
import type { ManagedChild, SupervisorDeps } from './supervisor.js';
import { copyCoreChild, type CoreEvidence } from './health-probe.js';
import type { OwnedChild } from './contracts.js';

function fail(start: boolean): never { throw new Error(start ? 'CORE_START_FAILED' : 'CORE_STOP_UNKNOWN'); }
function same(a: OwnedChild, b: OwnedChild): boolean {
  try { return JSON.stringify(copyCoreChild(a)) === JSON.stringify(copyCoreChild(b)); } catch { return false; }
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('CORE_STOP_UNKNOWN')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(new Error('CORE_STOP_UNKNOWN')); });
    if (signal.aborted) abort();
  });
}
interface Active { raw: ManagedChild; outward: ManagedChild; ended: boolean; stopping: Promise<void> | null }
/** Compose the actual native Core port, not a remote or arbitrary process API.
 * The inner port's rejection contract is strict: no untracked live child. An
 * unresolved/ambiguous start must remain pending. A HELD record has no TTL.
 * This reservation does not attest the release/helper or replace native proof.
 */
export function withExclusiveCore(core: SupervisorDeps['core'], leases: ExecutionLeaseStore): SupervisorDeps['core'] {
  let attempted = false; let active: Active | null = null;
  const unknown = (): CoreEvidence => ({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: '',
    releaseDigest: '', observedAtMs: Date.now() });
  return Object.freeze({
    async spawn(input, generation, signal) {
      if (attempted || signal.aborted) fail(true); attempted = true;
      let lease: ExecutionLease | null = null;
      let received = false;
      try {
        const config = parseConfig(input); Object.freeze(config.tunnel); Object.freeze(config);
        lease = await leases.acquire('core', generation, configDigest(config), config.releaseDigest);
        if (signal.aborted) { await leases.release(lease); fail(true); }
        let raw: ManagedChild;
        try { raw = await core.spawn(config, generation, signal); }
        catch { await leases.release(lease); fail(true); }
        received = true;
        const child = Object.freeze(copyCoreChild(raw.child));
        if (child.generation !== generation || child.releaseDigest !== config.releaseDigest
          || !(raw.exited instanceof Promise)) fail(true);
        const held = lease;
        const record: Active = { raw, outward: raw, ended: false, stopping: null };
        const completed = raw.exited.then(async () => {
          record.ended = true; await leases.release(held);
        }).catch(() => fail(false));
        // Observe spontaneous-exit release errors even before a consumer waits.
        void completed.catch(() => undefined);
        const outward = Object.freeze({ child, exited: completed }); record.outward = outward; active = record;
        return outward;
      } catch {
        // An invalid fulfilled result is ambiguous, not a definite no-child
        // failure. Its slot remains HELD. No PID-based cleanup is attempted.
        if (!received && lease === null) { /* A failed CAS may already have committed: do not reset. */ }
        return fail(true);
      }
    },
    async probe(child, signal) {
      const record = active;
      if (!record || record.ended || signal.aborted || !same(child, record.outward.child)
        || !same(record.raw.child, record.outward.child)) return unknown();
      try { return await core.probe(record.outward.child, signal); } catch { return unknown(); }
    },
    async stop(managed, deadlineMs, signal) {
      const record = active;
      if (!record || record.outward !== managed || !same(record.raw.child, managed.child)
        || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 20000 || signal.aborted) fail(false);
      const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), deadlineMs);
      const combined = AbortSignal.any([signal, deadline.signal]);
      try {
        if (record.stopping === null) {
          record.stopping = (async () => {
            await core.stop(record.raw, deadlineMs, combined);
            // Signal delivery or a prematurely resolved stop is not exit proof.
            await wait(record.outward.exited, combined);
          })();
        }
        await wait(record.stopping, combined);
      } catch { fail(false); }
      finally { clearTimeout(timer); deadline.abort(); }
    },
  });
}
