import { configDigest, parseConfig } from './config.js';
import type { OwnedChild } from './contracts.js';
import { abortable, copyCoreChild } from './health-probe.js';
import {
  decodeTunnelRegistration, encodeTunnelRegistration, type TunnelRegistrationStore,
} from './tunnel-registration.js';
import type { ManagedChild } from './supervisor.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';

function failed(): never { throw new Error('TUNNEL_START_FAILED'); }
function stopUnknown(): never { throw new Error('TUNNEL_STOP_UNKNOWN'); }
function copyTunnelChild(value: OwnedChild): OwnedChild {
  if (value.role !== 'tunnel') failed();
  const normalized = copyCoreChild({ ...value, role: 'core' });
  return Object.freeze({ ...normalized, role: 'tunnel' as const });
}
function same(a: OwnedChild, b: OwnedChild): boolean {
  try { return JSON.stringify(copyTunnelChild(a)) === JSON.stringify(copyTunnelChild(b)); }
  catch { return false; }
}
async function limited<T>(ms: number, parent: AbortSignal | undefined,
  use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try {
    if (signal.aborted) failed();
    return await abortable(use(signal), signal);
  } finally {
    clearTimeout(timer); controller.abort();
  }
}

/** Publishes the exact tunnel child against its HELD execution reservation
 * before exposing startup. Publication failure is not treated as no-child until
 * the underlying custody port confirms actual exit.
 */
export function withRegisteredTunnel(tunnel: TunnelCustodyPort,
  registration: Pick<TunnelRegistrationStore, 'publish'>): TunnelCustodyPort {
  let attempted = false;
  let managed: ManagedChild | null = null;
  let identity: OwnedChild | null = null;
  let ended = false;
  let uncertain = false;
  let ready = false;
  let stopping: Promise<void> | null = null;
  let confirmed: Promise<void> = new Promise(() => {});

  return Object.freeze<TunnelCustodyPort>({
    async spawn(input, compatibility, core, generation, signal) {
      if (attempted || signal.aborted) failed();
      attempted = true;
      try {
        const config = parseConfig(input);
        if (!config.tunnel.enabled || compatibility.digest !== config.tunnel.compatibilityDigest) failed();
        const raw = await tunnel.spawn(config, compatibility, core, generation, signal);
        managed = raw;
        if (!(raw.exited instanceof Promise)) { uncertain = true; await confirmed; failed(); }
        confirmed = new Promise<void>(resolve => {
          void raw.exited.then(() => { ended = true; resolve(); }, () => { uncertain = true; });
        });
        identity = copyTunnelChild(raw.child);
        if (identity.generation !== generation || identity.releaseDigest !== config.releaseDigest || ended || uncertain) failed();
        const registered = await limited(10000, signal,
          () => registration.publish(config, identity as OwnedChild));
        const record = decodeTunnelRegistration(encodeTunnelRegistration(registered));
        if (!same(record.child, identity) || record.configDigest !== configDigest(config)
          || ended || uncertain || signal.aborted || !same(raw.child, identity)) failed();
        ready = true;
        return raw;
      } catch {
        ready = false;
        if (managed && !ended) {
          try {
            await limited(20000, undefined, async active => {
              await tunnel.stop(managed as ManagedChild, 20000, active);
              await abortable(confirmed, active);
            });
          } catch { /* uncertain stop must not become a definite no-child rejection */ }
          if (!ended) await confirmed;
        }
        return failed();
      }
    },

    async current(child, signal) {
      if (!ready || !identity || !managed || ended || uncertain || signal.aborted
        || !same(child, identity) || !same(managed.child, identity)) return false;
      try {
        const owned = await tunnel.current(child, signal);
        return owned === true && !ended && !uncertain && !signal.aborted
          && same(child, identity) && same(managed.child, identity);
      } catch { return false; }
    },

    async stop(child, ms, signal) {
      if (!ready || managed !== child || !identity || !same(child.child, identity)
        || !Number.isSafeInteger(ms) || ms <= 0 || ms > 20000 || signal.aborted) stopUnknown();
      try {
        if (stopping === null) {
          stopping = limited(ms, signal, async active => {
            await tunnel.stop(child, ms, active);
            await abortable(confirmed, active);
          });
        }
        await abortable(stopping, signal);
      } catch { stopUnknown(); }
    },
  });
}
