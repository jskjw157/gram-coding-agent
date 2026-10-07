import { ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { configDigest, parseConfig } from '../config.js';
import { root, type AccountIdentity, type OwnedChild, type ServiceConfig } from '../contracts.js';
import { attachChildOutput, type OutputDrain } from '../child-output.js';
import { withExclusiveCore } from '../exclusive-core.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { copyCoreChild, probeCore, type CoreCredentials, type CoreEvidence } from '../health-probe.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from '../release-review-budget.js';
import type { ManagedChild, SupervisorDeps } from '../supervisor.js';
import { createLoopbackConnections } from './loopback-http.js';
import { createMacConnectedPeerVerifier, sealMacOwnedChild, type ExecutableIdentity,
  type MacProcessSeal, type NativePeerProofPort } from './owned-process.js';

export interface CoreLaunchPlan {
  file: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>;
}
/** INTERNAL: acquire must independently validate the account, sealed release,
 * state/secret directories, exclusivity and native helper provenance. These
 * fields do not create that trust. No default authority or serialized grant. */
export interface CoreLaunchGrant {
  configDigest: string; account: AccountIdentity; executable: ExecutableIdentity; proof: NativePeerProofPort;
}
export interface CoreAuthority {
  acquire(config: ServiceConfig, signal: AbortSignal): Promise<CoreLaunchGrant | null>;
}
export interface NativeCoreOptions {
  authority?: CoreAuthority;
  credentials?: CoreCredentials;
  /** Required for the default native launcher. Bootstrap must bind all factories
   * to the same independently trusted, explicitly initialized run directory. */
  execution?: ExecutionLeaseStore;
  /** Trusted in-process dependency for isolated fixtures, not a config/CLI tool. */
  launch?: (plan: Readonly<CoreLaunchPlan>) => ChildProcess;
}
export function coreLaunchPlan(input: ServiceConfig): Readonly<CoreLaunchPlan> {
  const config = parseConfig(input); const release = `${root}/releases/${config.releaseId}`;
  return Object.freeze({ file: `${release}/bin/node`, args: Object.freeze([`${release}/apps/agent/dist/main.js`]),
    cwd: release, env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent',
      GRAM_AGENT_STATE_DIR: `${root}/state`, GRAM_AGENT_SECRET_DIR: `${root}/secrets` }) });
}
function nativeLaunch(plan: Readonly<CoreLaunchPlan>): ChildProcess {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || (process.getuid?.() ?? 0) === 0) {
    throw new Error('CORE_START_FAILED');
  }
  // Explicit environment: never inherit loader options, proxies or tokens.
  // No shell, detached session, inherited stdio, uid switch or process-group kill.
  return spawnProcess(plan.file, [...plan.args], { cwd: plan.cwd, env: { ...plan.env },
    shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
}
function startFailed(): never { throw new Error('CORE_START_FAILED'); }
function stopUnknown(): never { throw new Error('CORE_STOP_UNKNOWN'); }
function waitSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value?: T) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort);
      if (ok) resolve(value as T); else reject(new Error('CORE_STOP_UNKNOWN'));
    };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => finish(!signal.aborted, value), () => finish(false));
    if (signal.aborted) abort();
  });
}
async function within<T>(ms: number, parent: AbortSignal | undefined,
  use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try { if (signal.aborted) stopUnknown(); return await waitSignal(use(signal), signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
function validatedGrant(value: CoreLaunchGrant | null, config: ServiceConfig): CoreLaunchGrant {
  if (!value || value.configDigest !== configDigest(config)) startFailed();
  const a = value.account; const e = value.executable;
  if (!a || a.name !== 'gram-agent' || a.admin !== false || !Number.isSafeInteger(a.uid) || a.uid < 1
    || a.uid !== process.getuid?.() || !Number.isSafeInteger(a.gid) || a.gid < 0 || a.gid !== process.getgid?.()
    || !e || typeof e.dev !== 'bigint' || typeof e.ino !== 'bigint' || e.dev < 0n || e.ino < 1n
    || e.dev > 0xffff_ffff_ffff_ffffn || e.ino > 0xffff_ffff_ffff_ffffn
    || !value.proof || typeof value.proof.capture !== 'function' || typeof value.proof.current !== 'function'
    || typeof value.proof.peer !== 'function') startFailed();
  return Object.freeze({ configDigest: value.configDigest, account: Object.freeze({ ...a }),
    executable: Object.freeze({ dev: e.dev, ino: e.ino }), proof: value.proof });
}
interface Custody {
  raw: ChildProcess; exited: boolean; noProcess: boolean; spawned: Promise<void>; exit: Promise<void>;
  output: OutputDrain; seal: MacProcessSeal | null; proof: NativePeerProofPort;
  managed: ManagedChild | null; stopping: Promise<void> | null;
}
function takeCustody(raw: ChildProcess, proof: NativePeerProofPort): Custody {
  if (!(raw instanceof ChildProcess)) startFailed();
  let resolveExit: () => void = () => {};
  let resolveSpawn: () => void = () => {}; let rejectSpawn: () => void = () => {};
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  const spawned = new Promise<void>((resolve, reject) => {
    resolveSpawn = resolve; rejectSpawn = () => reject(new Error('CORE_START_FAILED'));
  });
  let started = false;
  const c: Custody = { raw, exited: false, noProcess: false, spawned, exit,
    output: attachChildOutput(raw.stdout, raw.stderr), seal: null, proof, managed: null, stopping: null };
  const onSpawn = () => { started = true; resolveSpawn(); };
  const onError = () => {
    // kill()/IPC errors after launch are NOT termination evidence.
    if (!started && raw.pid === undefined) { c.noProcess = true; rejectSpawn(); }
  };
  const onExit = () => { c.exited = true; resolveExit(); if (!started) rejectSpawn(); void c.output.finish(); };
  raw.once('spawn', onSpawn); raw.on('error', onError); raw.once('exit', onExit);
  raw.once('close', () => { raw.off('spawn', onSpawn); raw.off('error', onError); raw.off('exit', onExit); });
  return c;
}
function sameChild(a: OwnedChild, b: OwnedChild): boolean {
  try {
    const value = copyCoreChild(a);
    return value.pid === b.pid && value.uid === b.uid && value.startIdentity === b.startIdentity
      && value.generation === b.generation && value.releaseDigest === b.releaseDigest;
  } catch { return false; }
}
async function signalOwned(c: Custody, kind: 'SIGTERM' | 'SIGKILL', signal: AbortSignal): Promise<void> {
  if (c.exited) return;
  if (!c.seal || signal.aborted || c.raw.pid !== c.seal.child.pid) stopUnknown();
  // Do not use LiveProcessHandle.killed: successful SIGTERM is not an exit.
  const verdict = await waitSignal(c.proof.current(c.seal.identity, signal), signal);
  if (c.exited) return;
  if (verdict !== 'OWNED' || signal.aborted || c.raw.pid !== c.seal.child.pid) stopUnknown();
  if (!c.raw.kill(kind) && !c.exited) stopUnknown();
}
async function stopCustody(c: Custody, ms: number, parent: AbortSignal): Promise<void> {
  await within(ms, parent, async signal => {
    if (!c.exited) {
      const started = performance.now();
      await signalOwned(c, 'SIGTERM', signal);
      const grace = Math.max(0, Math.min(15000, ms * 0.75) - (performance.now() - started));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await waitSignal(Promise.race([c.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, grace); })]), signal); }
      finally { clearTimeout(timer); }
      if (!c.exited) await signalOwned(c, 'SIGKILL', signal);
      await waitSignal(c.exit, signal);
    }
    // The shared output owner discards bytes; drain results are never log bodies.
    await waitSignal(c.output.finish(signal), signal);
    if (!c.exited) stopUnknown();
  });
}
function unknown(): CoreEvidence {
  return { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: '', releaseDigest: '', observedAtMs: Date.now() };
}

/** One factory/one start attempt. Default native execution additionally requires
 * a shared durable reservation store. Fixed-root binding remains bootstrap's
 * responsibility. An ambiguous child remains tracked until actual exit. */
export function createNativeCorePort(options: NativeCoreOptions = {}): SupervisorDeps['core'] {
  const authority = options.authority; const credentials = options.credentials;
  // Normalize once: a supplied null/false is not an execution capability.
  const execution = options.execution instanceof ExecutionLeaseStore ? options.execution : undefined;
  const permitted = options.launch !== undefined || execution !== undefined;
  const launch = options.launch ?? nativeLaunch;
  let claimed = false; let custody: Custody | null = null;
  const records = new WeakMap<ManagedChild, Custody>();
  const port: SupervisorDeps['core'] = {
    async spawn(input, generation, signal) {
      if (claimed || signal.aborted || !authority || !credentials || !permitted) startFailed();
      claimed = true;
      try {
        const config = parseConfig(input); Object.freeze(config.tunnel); Object.freeze(config);
        copyCoreChild({ role: 'core', pid: 1, uid: 1, startIdentity: 'validation-only',
          generation, releaseDigest: config.releaseDigest });
        const grant = validatedGrant(await within(RELEASE_REVIEW_TIMEOUT_MS, signal, s => authority.acquire(config, s)), config);
        if (signal.aborted) startFailed();
        // Both command and environment are derived, never supplied by the grant.
        custody = takeCustody(launch(coreLaunchPlan(config)), grant.proof);
        const c = custody;
        await c.spawned;
        if (c.raw.pid === undefined || !Number.isSafeInteger(c.raw.pid) || c.raw.pid < 1) {
          if (!c.exited) await c.exit;
          startFailed();
        }
        // Narrow only after the spawn event and explicit PID validation. Retain
        // the original live object, not a spread/snapshot of its exit properties.
        const liveHandle = c.raw as ChildProcess & { pid: number };
        // A short independent seal attempt permits cleanup even when the caller
        // cancelled immediately after the OS created the process.
        try { c.seal = await within(2000, undefined, s => sealMacOwnedChild(liveHandle, {
          role: 'core', uid: grant.account.uid, generation, releaseDigest: config.releaseDigest,
          executable: grant.executable,
        }, c.proof, s)); } catch { c.seal = null; }
        if (c.exited || c.seal === null) { if (!c.exited) await c.exit; startFailed(); }
        const managed = Object.freeze({ child: c.seal.child, exited: c.exit });
        c.managed = managed; records.set(managed, c);
        if (signal.aborted) {
          try { await stopCustody(c, 20000, new AbortController().signal); } catch { if (!c.exited) await c.exit; }
          startFailed();
        }
        return managed;
      } catch {
        if (custody && !custody.noProcess && !custody.exited) await custody.exit;
        return startFailed();
      }
    },
    async probe(child, signal) {
      const c = custody;
      if (!c?.seal || !c.managed || c.exited || !sameChild(child, c.seal.child) || !credentials || signal.aborted) return unknown();
      try {
        const connections = createLoopbackConnections(createMacConnectedPeerVerifier(c.seal, c.proof));
        return await probeCore(c.seal.child, connections, credentials, { signal });
      } catch { return unknown(); }
    },
    async stop(managed, deadlineMs, signal) {
      const c = records.get(managed);
      if (!c || c.managed !== managed || !c.seal || !sameChild(managed.child, c.seal.child)
        || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 20000 || signal.aborted) stopUnknown();
      try {
        // Concurrent callers share one signal/termination operation, never two.
        if (c.stopping === null) c.stopping = stopCustody(c, deadlineMs, signal);
        await waitSignal(c.stopping, signal);
      } catch { return stopUnknown(); }
    },
  };
  return execution ? withExclusiveCore(Object.freeze(port), execution) : Object.freeze(port);
}
