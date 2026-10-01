import { configDigest, parseConfig } from './config.js';
import type { OwnedChild } from './contracts.js';
import type { ExecutionLeaseStore } from './execution-lease.js';
import { copyCoreChild } from './health-probe.js';
import type { ManagedChild } from './supervisor.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';

function fail(start: boolean): never {
  throw new Error(start ? 'TUNNEL_START_FAILED' : 'TUNNEL_STOP_UNKNOWN');
}

function copyTunnelChild(value: OwnedChild): OwnedChild {
  if (value.role !== 'tunnel') fail(false);
  const core = copyCoreChild({ ...value, role: 'core' });
  return Object.freeze({ ...core, role: 'tunnel' });
}

function same(a: OwnedChild, b: OwnedChild): boolean {
  try {
    return JSON.stringify(copyTunnelChild(a)) === JSON.stringify(copyTunnelChild(b));
  } catch {
    return false;
  }
}

function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('TUNNEL_STOP_UNKNOWN'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      else resolve(value);
    }, () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('TUNNEL_STOP_UNKNOWN'));
    });
    if (signal.aborted) abort();
  });
}

interface Active {
  raw: ManagedChild;
  outward: ManagedChild;
  ended: boolean;
  stopping: Promise<void> | null;
}

/** Durable cross-process reservation around the reviewed tunnel custody port.
 * Provider compatibility, credentials and health remain outside this layer.
 * A rejected inner spawn must mean no live child remains.
 */
export function withExclusiveTunnelCustody(
  custody: TunnelCustodyPort,
  leases: ExecutionLeaseStore,
): TunnelCustodyPort {
  let attempted = false;
  let active: Active | null = null;

  return Object.freeze<TunnelCustodyPort>({
    async spawn(input, compatibility, core, generation, signal) {
      if (attempted || signal.aborted) fail(true);
      attempted = true;
      try {
        const config = parseConfig(input);
        Object.freeze(config.tunnel);
        Object.freeze(config);
        if (!config.tunnel.enabled || compatibility.digest !== config.tunnel.compatibilityDigest) fail(true);

        const lease = await leases.acquire('tunnel', generation, configDigest(config), config.releaseDigest);
        if (signal.aborted) {
          await leases.release(lease);
          fail(true);
        }

        let raw: ManagedChild;
        try {
          raw = await custody.spawn(config, compatibility, core, generation, signal);
        } catch {
          await leases.release(lease);
          return fail(true);
        }

        const child = copyTunnelChild(raw.child);
        if (child.generation !== generation || child.releaseDigest !== config.releaseDigest
          || !(raw.exited instanceof Promise)) fail(true);

        const record: Active = { raw, outward: raw, ended: false, stopping: null };
        const completed = raw.exited.then(async () => {
          record.ended = true;
          await leases.release(lease);
        }).catch(() => {
          record.ended = true;
          return fail(false);
        });
        void completed.catch(() => undefined);

        const outward = Object.freeze({ child, exited: completed });
        record.outward = outward;
        active = record;
        return outward;
      } catch {
        return fail(true);
      }
    },

    async stop(managed, deadlineMs, signal) {
      const record = active;
      if (!record || record.outward !== managed || !same(record.raw.child, managed.child)
        || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 20000 || signal.aborted) fail(false);

      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), deadlineMs);
      const combined = AbortSignal.any([signal, deadline.signal]);
      try {
        if (record.stopping === null) {
          record.stopping = (async () => {
            await custody.stop(record.raw, deadlineMs, combined);
            await wait(record.outward.exited, combined);
          })();
        }
        await wait(record.stopping, combined);
      } catch {
        fail(false);
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    },
  });
}
