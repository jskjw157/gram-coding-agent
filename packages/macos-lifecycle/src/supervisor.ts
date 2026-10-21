import { parseConfig } from './config.js';
import type { Clock, OwnedChild, Role, SafeCode, ServiceConfig } from './contracts.js';
import { copyCoreChild, type CoreEvidence } from './health-probe.js';
import type { HistorySnapshot, LifecycleStore } from './lifecycle-store.js';
import { parseStatus, type ServiceState } from './telemetry.js';
import type { TelemetryStore } from './telemetry-store.js';

export interface ManagedChild {
  child: OwnedChild;
  /** Resolves only when the recorded child is confirmed exited. */
  exited: Promise<void>;
}
/** INTERNAL attestation returned by a trusted compatibility provider, not JSON authorization. */
export interface TunnelCompatibility { digest: string }
export type TunnelObservation = 'READY' | 'OFFLINE' | 'AUTH_BLOCKED' | 'UNKNOWN';
/** All ports are trusted local composition dependencies. Native bindings must seal
 * releases/handles and restrict argv/env before spawning. This module exposes no
 * CLI/MCP, installs nothing and does not turn a callback into ownership proof.
 * A spawn rejection must leave no untracked child; stop success means confirmed
 * termination of the recorded child, not merely that a signal was delivered.
 */
export interface SupervisorDeps {
  clock: Clock;
  lifecycle: LifecycleStore;
  telemetry: TelemetryStore;
  nextGeneration(role: Role): string;
  confirmStopped?(role: Role, signal: AbortSignal): Promise<boolean>;
  core: {
    spawn(config: ServiceConfig, generation: string, signal: AbortSignal): Promise<ManagedChild>;
    probe(child: OwnedChild, signal: AbortSignal): Promise<CoreEvidence>;
    stop(child: ManagedChild, deadlineMs: number, signal: AbortSignal): Promise<void>;
  };
  /** Must establish current owned core health, not just read a status file. */
  currentCore(signal: AbortSignal): Promise<CoreEvidence | null>;
  tunnel: {
    compatibility(config: ServiceConfig): Promise<TunnelCompatibility | null>;
    credentialAvailable(ref: 'test-tunnel-key'): Promise<boolean>;
    spawn(config: ServiceConfig, compatibility: TunnelCompatibility, core: CoreEvidence,
      generation: string, signal: AbortSignal): Promise<ManagedChild>;
    probe(child: OwnedChild, core: CoreEvidence, signal: AbortSignal): Promise<TunnelObservation>;
    stop(child: ManagedChild, deadlineMs: number, signal: AbortSignal): Promise<void>;
  };
}
const CADENCE = 5000;
const STARTUP = 60000;
const STOP = 20000;
export function dependencyDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('INVALID_HISTORY');
  return [1000, 2000, 4000, 8000, 16000][attempt] ?? 30000;
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('INTERRUPTED')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // Observe late resolutions/rejections without exposing provider error text.
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(new Error('INTERRUPTED')); });
  });
}
async function limited<T>(ms: number, parent: AbortSignal | undefined,
  use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), ms);
  try {
    if (signal.aborted || ms <= 0) throw new Error('INTERRUPTED');
    return await waitFor(use(signal), signal);
  } finally { clearTimeout(timer); deadline.abort(); }
}
function healthy(value: CoreEvidence | null, release: string, now: number, generation?: string): CoreEvidence | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = ['state', 'code', 'generation', 'releaseDigest', 'observedAtMs'];
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    }
    const status = parseStatus({ ...value, role: 'core', schemaVersion: 1, attemptCount: 0 });
    if (status.state !== 'LOCAL_CORE_HEALTHY' || status.code !== 'OK' || status.releaseDigest !== release
      || (generation !== undefined && generation !== status.generation)
      || status.observedAtMs > now || now - status.observedAtMs >= 30000) return null;
    return Object.freeze({ state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: status.generation,
      releaseDigest: status.releaseDigest, observedAtMs: status.observedAtMs });
  } catch { return null; }
}

/** One invocation owns at most one child. launchd supplies throttled retries.
 * Sticky blocks idle until cancellation; no elapsed-time reset or raw error log.
 */
export async function runSupervisor(role: Role, input: ServiceConfig, deps: SupervisorDeps,
  signal: AbortSignal): Promise<number> {
  if (role !== 'core' && role !== 'tunnel') return 1;
  const idle = async (): Promise<number> => {
    while (!signal.aborted) {
      try { await waitFor(deps.clock.sleep(CADENCE, signal), signal); }
      catch { return signal.aborted ? 0 : 1; }
    }
    return 0;
  };
  if (signal.aborted) return 0;
  let config: ServiceConfig;
  try {
    config = parseConfig(input);
    Object.freeze(config.tunnel);
    Object.freeze(config);
  } catch { return idle(); }
  if (role === 'tunnel' && !config.tunnel.enabled) return 0;
  let history: HistorySnapshot | null = null;
  let generation = 'unstarted';
  let lastTime = -1;
  const now = () => {
    const time = deps.clock.nowMs();
    if (!Number.isSafeInteger(time) || time < 0 || time < lastTime) throw new Error('INVALID_HISTORY');
    lastTime = time; return time;
  };
  const emit = async (state: ServiceState, code: SafeCode = 'OK') => {
    const owner = { role, generation, releaseDigest: config.releaseDigest };
    const event = { schemaVersion: 1, ...owner, code, observedAtMs: now(),
      attemptCount: Math.min(5, history?.history.exitsMs.length ?? 0) };
    await deps.telemetry.writeStatus(role, { ...event, state }, owner);
    await deps.telemetry.appendEvent(role, event);
  };
  const block = async (state: ServiceState, code: SafeCode) => {
    try { await emit(state, code); } catch { /* Keep blocked if telemetry is unavailable. */ }
    return idle();
  };
  try {
    history = await deps.lifecycle.read(role);
    generation = history.history.lastGeneration ?? generation;
    if (history.history.blocked) return block('BLOCKED_RESTART_BUDGET', 'RESTART_BUDGET');
    if (now() < history.history.lastSeenMs) return block('BLOCKED_CONFIGURATION', 'INVALID_HISTORY');
    if (history.history.activeAttempt !== null) {
      if (!deps.confirmStopped || (await limited(10000, signal,
        s => deps.confirmStopped?.(role, s) ?? Promise.resolve(false))) !== true) {
        return block('UNKNOWN', 'FOREIGN_SERVICE');
      }
      history = await deps.lifecycle.write(role, history, { kind: 'recover', nowMs: now() });
      if (history.history.blocked) return block('BLOCKED_RESTART_BUDGET', 'RESTART_BUDGET');
    }
  } catch { return block('BLOCKED_CONFIGURATION', 'INVALID_HISTORY'); }

  let coreEvidence: CoreEvidence | null = null;
  let compatibility: TunnelCompatibility | null = null;
  if (role === 'tunnel') {
    let attempt = 0;
    try {
      while (!signal.aborted) {
        coreEvidence = healthy(await limited(10000, signal, s => deps.currentCore(s)), config.releaseDigest, now());
        if (coreEvidence) {
          compatibility = await limited(2000, signal, () => deps.tunnel.compatibility(config));
          if (!config.tunnel.enabled || !compatibility || compatibility.digest !== config.tunnel.compatibilityDigest) {
            return block('BLOCKED_CONFIGURATION', 'TUNNEL_COMPATIBILITY_REQUIRED');
          }
          compatibility = Object.freeze({ digest: compatibility.digest });
          const beforeCredential = healthy(await limited(10000, signal, s => deps.currentCore(s)),
            config.releaseDigest, now(), coreEvidence.generation);
          if (!beforeCredential) {
            await emit('WAITING_CORE', 'HEALTH_UNKNOWN');
            await waitFor(deps.clock.sleep(dependencyDelayMs(attempt), signal), signal);
            attempt = Math.min(attempt + 1, 5);
            continue;
          }
          coreEvidence = beforeCredential;
          if ((await limited(2000, signal, () => deps.tunnel.credentialAvailable('test-tunnel-key'))) !== true) {
            return block('AUTH_BLOCKED', 'AUTH_BLOCKED');
          }
          const checked = healthy(await limited(10000, signal, s => deps.currentCore(s)),
            config.releaseDigest, now(), coreEvidence.generation);
          if (checked) { coreEvidence = checked; break; }
        }
        await emit('WAITING_CORE', 'HEALTH_UNKNOWN');
        await waitFor(deps.clock.sleep(dependencyDelayMs(attempt), signal), signal);
        attempt = Math.min(attempt + 1, 5);
      }
    } catch { return signal.aborted ? 0 : block('UNKNOWN', 'HEALTH_UNKNOWN'); }
    if (signal.aborted) return 0;
  }

  let managed: ManagedChild | null = null;
  let owned: OwnedChild | null = null;
  let exited = false;
  let spawned = false;
  let spawnSettled = false;
  let unsafeChild = false;
  let abandonedSpawn = false;
  const dead = new AbortController();
  let intentional = false;
  let result = 1;
  let blocked: SafeCode | null = null;
  const stopPort = role === 'core' ? deps.core.stop.bind(deps.core) : deps.tunnel.stop.bind(deps.tunnel);
  const accepted = (child: ManagedChild) => {
    if (child.child.role !== role) throw new Error('FOREIGN_SERVICE');
    const normalized = copyCoreChild({ ...child.child, role: 'core' });
    if (normalized.generation !== generation || normalized.releaseDigest !== config.releaseDigest
      || !(child.exited instanceof Promise)) throw new Error('FOREIGN_SERVICE');
    return Object.freeze({ ...normalized, role });
  };
  const stopped = async () => {
    if (!managed || exited) return;
    if (!owned || JSON.stringify(accepted(managed)) !== JSON.stringify(owned)) throw new Error('FOREIGN_SERVICE');
    await limited(STOP, undefined, s => stopPort(managed as ManagedChild, STOP, s));
    exited = true;
  };
  try {
    generation = deps.nextGeneration(role);
    // Validate local identifiers before recording or asking any native port to spawn.
    parseStatus({ schemaVersion: 1, role, generation, releaseDigest: config.releaseDigest,
      state: 'STARTING', code: 'OK', observedAtMs: now(), attemptCount: 0 });
    const started = now();
    history = await deps.lifecycle.write(role, history, { kind: 'begin', generation, nowMs: started });
    await emit('STARTING');
    if (signal.aborted) { intentional = true; result = 0; }
    else {
      if (role === 'tunnel') {
        coreEvidence = healthy(await limited(10000, signal, s => deps.currentCore(s)),
          config.releaseDigest, now(), coreEvidence?.generation);
        if (!coreEvidence) { intentional = true; throw new Error('CORE_CHANGED'); }
      }
      spawned = true;
      await limited(Math.max(0, STARTUP - (now() - started)), signal, async local => {
        const promise = role === 'core' ? deps.core.spawn(config, generation, local)
          : deps.tunnel.spawn(config, compatibility as TunnelCompatibility, coreEvidence as CoreEvidence, generation, local);
        const tracked = promise.then(value => {
          spawnSettled = true;
          try { owned = accepted(value); managed = value; }
          catch { unsafeChild = true; throw new Error('FOREIGN_SERVICE'); }
          void value.exited.then(() => { exited = true; dead.abort(); }, () => { unsafeChild = true; dead.abort(); });
          if (abandonedSpawn) void limited(STOP, undefined, s => stopPort(value, STOP, s)).catch(() => undefined);
          return value;
        }, () => { spawnSettled = true; throw new Error('SPAWN_FAILED'); });
        await waitFor(tracked, local);
      });
      let healthyOnce = false;
      let retries = 0;
      while (!signal.aborted && !exited && !unsafeChild) {
        if (!owned) throw new Error('FOREIGN_SERVICE');
        const activeSignal = AbortSignal.any([signal, dead.signal]);
        if (role === 'core') {
          const remaining = STARTUP - (now() - started);
          if (!healthyOnce && remaining <= 0) break;
          let evidence: CoreEvidence | null = null;
          try { evidence = await limited(healthyOnce ? 10000 : Math.min(10000, remaining), activeSignal,
            s => deps.core.probe(owned as OwnedChild, s)); } catch { /* UNKNOWN, never raw error text. */ }
          if (signal.aborted || exited || unsafeChild) break;
          if (evidence?.state === 'BLOCKED' && (evidence.code === 'AUTH_BLOCKED' || evidence.code === 'TOOL_SURFACE_MISMATCH')) {
            blocked = evidence.code; intentional = true; break;
          }
          if (healthy(evidence, config.releaseDigest, now(), generation)) {
            healthyOnce = true; await emit('LOCAL_CORE_HEALTHY');
          } else {
            await emit('UNKNOWN', 'HEALTH_UNKNOWN');
            if (healthyOnce || now() - started >= STARTUP) break;
            await waitFor(deps.clock.sleep(Math.min(dependencyDelayMs(retries), STARTUP - (now() - started)), activeSignal), activeSignal);
            retries = Math.min(5, retries + 1); continue;
          }
        } else {
          const current = healthy(await limited(10000, activeSignal, s => deps.currentCore(s)),
            config.releaseDigest, now(), coreEvidence?.generation);
          if (!current) { intentional = true; break; }
          coreEvidence = current;
          let state: TunnelObservation = 'UNKNOWN';
          try { state = await limited(2000, activeSignal, s => deps.tunnel.probe(owned as OwnedChild, current, s)); }
          catch { /* An ambiguous transport is UNKNOWN, not authenticated success. */ }
          if (signal.aborted || exited || unsafeChild) break;
          if (state === 'AUTH_BLOCKED') { intentional = true; blocked = 'AUTH_BLOCKED'; break; }
          const rechecked = healthy(await limited(10000, activeSignal, s => deps.currentCore(s)),
            config.releaseDigest, now(), current.generation);
          if (!rechecked) { intentional = true; break; }
          await emit(state === 'READY' ? 'TRANSPORT_READY' : state === 'OFFLINE' ? 'OFFLINE' : 'UNKNOWN',
            state === 'READY' ? 'OK' : 'HEALTH_UNKNOWN');
        }
        await waitFor(deps.clock.sleep(CADENCE, activeSignal), activeSignal);
      }
      if (signal.aborted && !exited) { intentional = true; result = 0; }
    }
  } catch {
    if (signal.aborted && !exited) { intentional = true; result = 0; }
  }
  // An uncooperative/late spawn is not proof of absence. Keep its marker and
  // refuse another start until stopped recovery establishes the actual outcome.
  if (unsafeChild || (spawned && !spawnSettled)) {
    abandonedSpawn = true;
    try { await emit('UNKNOWN', 'FOREIGN_SERVICE'); } catch { /* Fail closed. */ }
    return 1;
  }
  try {
    if (managed && !exited) {
      // Recording intent must not prevent owned-child cleanup on a log failure.
      try { await emit('STOPPING'); } catch { /* Stop still required. */ }
      await stopped();
    }
    if (history.history.activeAttempt?.generation === generation) {
      history = await deps.lifecycle.write(role, history, { kind: 'exit', generation, nowMs: now(), intentional });
    }
    if (blocked) return block(blocked === 'AUTH_BLOCKED' ? 'AUTH_BLOCKED' : 'BLOCKED_CONFIGURATION', blocked);
    if (history.history.blocked) return block('BLOCKED_RESTART_BUDGET', 'RESTART_BUDGET');
    await emit('STOPPED', result === 0 ? 'OK' : 'HEALTH_UNKNOWN');
    return result;
  } catch {
    try { await emit('UNKNOWN', 'INTERNAL_ERROR'); } catch { /* Keep the durable marker on uncertainty. */ }
    return 1;
  } finally { dead.abort(); }
}
