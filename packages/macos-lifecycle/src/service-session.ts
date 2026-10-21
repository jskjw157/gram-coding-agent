import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Role, ServiceConfig, Clock } from './contracts.js';
import { parseConfig } from './config.js';
import { runSupervisor, type SupervisorDeps } from './supervisor.js';
import type { RuntimeStores } from './adapters/runtime-stores.js';
import type { ReviewedServiceRuntime } from './adapters/runtime-authority.js';
import type { CoreCredentials } from './health-probe.js';
import { createReviewedCorePorts } from './core-runtime.js';
export interface ServiceSession { run(signal: AbortSignal): Promise<number> }
/** All dependencies are trusted local composition capabilities, never tool data. */
export interface ServiceSessionDeps {
  stores: RuntimeStores;
  core: SupervisorDeps['core']; currentCore: SupervisorDeps['currentCore'];
  tunnel?: SupervisorDeps['tunnel']; confirmStopped?: SupervisorDeps['confirmStopped'];
  clock?: Clock; nextGeneration?: SupervisorDeps['nextGeneration'];
}
const nativeClock: Clock = Object.freeze({
  nowMs: () => Date.now(),
  async sleep(ms: number, signal: AbortSignal) { await sleep(ms, undefined, { signal }); },
});
const noTunnel: SupervisorDeps['tunnel'] = Object.freeze<SupervisorDeps['tunnel']>({
  async compatibility() { return null; }, async credentialAvailable() { return false; },
  async spawn() { throw new Error('TUNNEL_COMPATIBILITY_REQUIRED'); },
  async probe() { return 'UNKNOWN'; }, async stop() { throw new Error('TUNNEL_COMPATIBILITY_REQUIRED'); },
});
/** One invocation can execute at most one existing supervisor lifecycle. It
 * initializes/resets no records and creates no alternative state machine.
 */
export function createServiceSession(role: Role, input: ServiceConfig, inputDeps: ServiceSessionDeps): ServiceSession {
  if (role !== 'core' && role !== 'tunnel') throw new Error('INVALID_CONFIG');
  const config = parseConfig(input); Object.freeze(config.tunnel); Object.freeze(config);
  if (role === 'tunnel' && config.tunnel.enabled && !inputDeps.tunnel) throw new Error('TUNNEL_COMPATIBILITY_REQUIRED');
  let deps: SupervisorDeps;
  try {
    const source = inputDeps.core; const transport = inputDeps.tunnel ?? noTunnel;
    const clock = inputDeps.clock ?? nativeClock; const stores = inputDeps.stores;
    if (typeof stores.lifecycle.read !== 'function' || typeof stores.lifecycle.write !== 'function'
      || typeof stores.telemetry.writeStatus !== 'function' || typeof stores.telemetry.appendEvent !== 'function') throw new Error();
    deps = Object.freeze({
      lifecycle: stores.lifecycle, telemetry: stores.telemetry,
      clock: Object.freeze({ nowMs: clock.nowMs.bind(clock), sleep: clock.sleep.bind(clock) }),
      nextGeneration: inputDeps.nextGeneration?.bind(inputDeps) ?? (() => randomUUID()),
      ...(inputDeps.confirmStopped ? { confirmStopped: inputDeps.confirmStopped.bind(inputDeps) } : {}),
      core: Object.freeze({ spawn: source.spawn.bind(source), probe: source.probe.bind(source), stop: source.stop.bind(source) }),
      currentCore: inputDeps.currentCore.bind(inputDeps),
      tunnel: Object.freeze({ compatibility: transport.compatibility.bind(transport), credentialAvailable: transport.credentialAvailable.bind(transport),
        spawn: transport.spawn.bind(transport), probe: transport.probe.bind(transport), stop: transport.stop.bind(transport) }),
    });
  } catch { throw new Error('SERVICE_SESSION_UNAVAILABLE'); }
  let used = false;
  return Object.freeze({ async run(signal: AbortSignal) {
    if (used) throw new Error('SESSION_ALREADY_USED'); used = true;
    return runSupervisor(role, config, deps, signal);
  } });
}

/** Compose real native Core custody/discovery with verified store directories.
 * Trust and credential use must already be supplied by the fixed local bootstrap.
 * Construction performs no process, credential or recovery action.
 */
export function createReviewedServiceSessionDeps(runtime: ReviewedServiceRuntime,
  credentials: CoreCredentials, tunnel?: SupervisorDeps['tunnel']): ServiceSessionDeps {
  const ports = createReviewedCorePorts(runtime.configuration, runtime, credentials);
  const confirmStopped = runtime.confirmStopped.bind(runtime);
  return Object.freeze({
    stores: runtime.stores,
    ...ports,
    confirmStopped,
    ...(tunnel ? { tunnel } : {}),
  });
}

export function createReviewedServiceSession(role: Role, runtime: ReviewedServiceRuntime,
  credentials: CoreCredentials, tunnel?: SupervisorDeps['tunnel']): ServiceSession {
  return createServiceSession(role, runtime.configuration,
    createReviewedServiceSessionDeps(runtime, credentials, tunnel));
}
