import { configDigest, parseConfig } from './config.js';
import type { OwnedChild } from './contracts.js';
import { decodeCoreRegistration, encodeCoreRegistration, type CoreRegistrationStore } from './core-registration.js';
import { abortable, copyCoreChild, type CoreEvidence } from './health-probe.js';
import type { ManagedChild, SupervisorDeps } from './supervisor.js';

function failed(): never { throw new Error('CORE_START_FAILED'); }
function same(a: OwnedChild, b: OwnedChild): boolean {
  try { return JSON.stringify(copyCoreChild(a)) === JSON.stringify(copyCoreChild(b)); } catch { return false; }
}
async function limited<T>(ms: number, parent: AbortSignal | undefined, use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try { if (signal.aborted) failed(); return await abortable(use(signal), signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
/** Wrap only the existing managed native Core port; no arbitrary process API.
 * A failed publication is not a definite no-child result until cleanup confirms
 * termination. A retained registration is invalidated by native exit/lease
 * release; no PID-driven cleanup or discovery-record deletion is needed.
 */
export function withRegisteredCore(core: SupervisorDeps['core'], registration: Pick<CoreRegistrationStore, 'publish'>):
  SupervisorDeps['core'] {
  let attempted = false; let managed: ManagedChild | null = null; let identity: OwnedChild | null = null;
  let ended = false; let uncertain = false; let ready = false; let stopping: Promise<void> | null = null;
  let confirmed: Promise<void> = new Promise(() => {});
  const unknown = (): CoreEvidence => ({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: '', releaseDigest: '', observedAtMs: Date.now() });
  return Object.freeze<SupervisorDeps['core']>({
    async spawn(input, generation, signal) {
      if (attempted || signal.aborted) failed(); attempted = true;
      try {
        const config = parseConfig(input); Object.freeze(config.tunnel); Object.freeze(config);
        const raw = await core.spawn(config, generation, signal); managed = raw;
        if (!(raw.exited instanceof Promise)) { uncertain = true; await confirmed; failed(); }
        confirmed = new Promise<void>(resolve => {
          void raw.exited.then(() => { ended = true; resolve(); }, () => { uncertain = true; });
        });
        identity = copyCoreChild(raw.child);
        if (identity.generation !== generation || identity.releaseDigest !== config.releaseDigest || ended || uncertain) failed();
        const registered = await limited(10000, signal, () => registration.publish(config, identity as OwnedChild));
        const record = decodeCoreRegistration(encodeCoreRegistration(registered));
        if (!same(record.child, identity) || record.configDigest !== configDigest(config)
          || ended || uncertain || signal.aborted || !same(raw.child, identity)) failed();
        ready = true; return raw;
      } catch {
        ready = false;
        if (managed && !ended) {
          try { await limited(20000, undefined, async active => {
            await core.stop(managed as ManagedChild, 20000, active); await abortable(confirmed, active);
          }); } catch { /* An uncertain stop must not become a no-child rejection. */ }
          if (!ended) await confirmed;
        }
        return failed();
      }
    },
    async probe(child, signal) {
      if (!ready || !identity || !managed || ended || uncertain || signal.aborted
        || !same(child, identity) || !same(managed.child, identity)) return unknown();
      try { return await core.probe(child, signal); } catch { return unknown(); }
    },
    async stop(child, ms, signal) {
      if (!ready || managed !== child || !identity || !same(child.child, identity)
        || !Number.isSafeInteger(ms) || ms <= 0 || ms > 20000 || signal.aborted) throw new Error('CORE_STOP_UNKNOWN');
      try {
        if (stopping === null) stopping = limited(ms, signal, async active => {
          await core.stop(child, ms, active); await abortable(confirmed, active);
        });
        await abortable(stopping, signal);
      } catch { throw new Error('CORE_STOP_UNKNOWN'); }
    },
  });
}
