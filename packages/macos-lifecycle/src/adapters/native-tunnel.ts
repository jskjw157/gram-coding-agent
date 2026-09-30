import { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { configDigest, parseConfig } from '../config.js';
import { root, type AccountIdentity, type ServiceConfig } from '../contracts.js';
import { attachChildOutput, type OutputDrain } from '../child-output.js';
import type { CoreEvidence } from '../health-probe.js';
import type { ManagedChild, TunnelCompatibility } from '../supervisor.js';
import { sealMacOwnedProcess, type ExecutableIdentity, type MacProcessSeal,
  type NativePeerProofPort } from './owned-process.js';

export interface TunnelLaunchPlan {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

/** Pure fixed invocation. Runtime tunnel credentials are deliberately absent:
 * a later narrow launcher may add only reviewed use-only values after every
 * compatibility/core-ownership gate. No argv/path/header comes from callers.
 */
export function tunnelLaunchPlan(input: ServiceConfig): Readonly<TunnelLaunchPlan> {
  const config = parseConfig(input);
  if (!config.tunnel.enabled) throw new Error('TUNNEL_COMPATIBILITY_REQUIRED');
  const release = `${root}/releases/${config.releaseId}`;
  const args = Object.freeze(['run', '--config', `${root}/config/tunnel-client.yaml`]);
  const env = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent' });
  return Object.freeze({ file: `${release}/bin/tunnel-client`, args, cwd: release, env });
}

export interface TunnelLaunchGrant {
  configDigest: string;
  compatibilityDigest: string;
  account: AccountIdentity;
  executable: ExecutableIdentity;
  proof: NativePeerProofPort;
}
export interface TunnelAuthority {
  acquire(config: ServiceConfig, compatibility: TunnelCompatibility, core: CoreEvidence,
    signal: AbortSignal): Promise<TunnelLaunchGrant | null>;
}
export interface TunnelCustodyOptions {
  authority?: TunnelAuthority;
  /** Trusted fixture/bootstrap capability. It receives only the fixed nonsecret
   * plan. Production credential injection remains a separate reviewed gate. */
  launch?: (plan: Readonly<TunnelLaunchPlan>) => ChildProcess;
}
export interface TunnelCustodyPort {
  spawn(config: ServiceConfig, compatibility: TunnelCompatibility, core: CoreEvidence,
    generation: string, signal: AbortSignal): Promise<ManagedChild>;
  stop(child: ManagedChild, deadlineMs: number, signal: AbortSignal): Promise<void>;
}

interface Custody {
  raw: ChildProcess;
  spawned: Promise<void>;
  exited: Promise<void>;
  output: OutputDrain;
  didExit: boolean;
  noProcess: boolean;
  seal: MacProcessSeal | null;
  managed: ManagedChild | null;
  stopping: Promise<void> | null;
  proof: NativePeerProofPort;
}

function startFailed(): never { throw new Error('TUNNEL_START_FAILED'); }
function stopUnknown(): never { throw new Error('TUNNEL_STOP_UNKNOWN'); }
function generation(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._-]/u.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function validCore(value: CoreEvidence, releaseDigest: string): boolean {
  return value !== null && typeof value === 'object' && value.state === 'LOCAL_CORE_HEALTHY' && value.code === 'OK'
    && generation(value.generation) && value.releaseDigest === releaseDigest
    && Number.isSafeInteger(value.observedAtMs) && value.observedAtMs >= 0;
}
function validGrant(value: TunnelLaunchGrant | null, config: ServiceConfig,
  compatibility: TunnelCompatibility): TunnelLaunchGrant {
  if (!value || value.configDigest !== configDigest(config) || !digest(value.compatibilityDigest)
    || value.compatibilityDigest !== compatibility.digest) startFailed();
  const a = value.account; const e = value.executable;
  if (!a || a.name !== 'gram-agent' || a.admin !== false || !Number.isSafeInteger(a.uid) || a.uid < 1
    || a.uid !== process.getuid?.() || !Number.isSafeInteger(a.gid) || a.gid < 0 || a.gid !== process.getgid?.()
    || !e || typeof e.dev !== 'bigint' || typeof e.ino !== 'bigint' || e.dev < 0n || e.ino < 1n
    || e.dev > 0xffff_ffff_ffff_ffffn || e.ino > 0xffff_ffff_ffff_ffffn
    || !value.proof || typeof value.proof.capture !== 'function' || typeof value.proof.current !== 'function'
    || typeof value.proof.peer !== 'function') startFailed();
  return Object.freeze({
    configDigest: value.configDigest, compatibilityDigest: value.compatibilityDigest,
    account: Object.freeze({ ...a }), executable: Object.freeze({ dev: e.dev, ino: e.ino }), proof: value.proof,
  });
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (ok) resolve(value as T); else reject(new Error('TUNNEL_STOP_UNKNOWN'));
    };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => finish(!signal.aborted, value), () => finish(false));
    if (signal.aborted) abort();
  });
}
function takeCustody(raw: ChildProcess, proof: NativePeerProofPort): Custody {
  if (!(raw instanceof ChildProcess)) startFailed();
  let resolveSpawn: () => void = () => {};
  let rejectSpawn: () => void = () => {};
  let resolveExit: () => void = () => {};
  const spawned = new Promise<void>((resolve, reject) => {
    resolveSpawn = resolve; rejectSpawn = () => reject(new Error('TUNNEL_START_FAILED'));
  });
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  let started = false;
  const custody: Custody = {
    raw, spawned, exited, output: attachChildOutput(raw.stdout, raw.stderr),
    didExit: false, noProcess: false, seal: null, managed: null, stopping: null, proof,
  };
  const onSpawn = () => { started = true; resolveSpawn(); };
  const onError = () => {
    if (!started && raw.pid === undefined) { custody.noProcess = true; rejectSpawn(); }
  };
  const onExit = () => {
    custody.didExit = true; resolveExit(); if (!started) rejectSpawn(); void custody.output.finish();
  };
  raw.once('spawn', onSpawn); raw.on('error', onError); raw.once('exit', onExit);
  raw.once('close', () => { raw.off('spawn', onSpawn); raw.off('error', onError); raw.off('exit', onExit); });
  return custody;
}
async function signalOwned(c: Custody, signalName: 'SIGTERM' | 'SIGKILL', signal: AbortSignal): Promise<void> {
  if (c.didExit) return;
  const seal = c.seal;
  if (!seal || signal.aborted || c.raw.pid !== seal.child.pid) stopUnknown();
  const verdict = await wait(c.proof.current(seal.identity, signal), signal);
  if (c.didExit) return;
  if (verdict !== 'OWNED' || signal.aborted || c.raw.pid !== seal.child.pid) stopUnknown();
  if (!c.raw.kill(signalName) && !c.didExit) stopUnknown();
}
async function stopCustody(c: Custody, deadlineMs: number, parent: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 20000 || parent.aborted) stopUnknown();
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const signal = AbortSignal.any([parent, deadline.signal]);
  try {
    if (!c.didExit) {
      const started = performance.now();
      await signalOwned(c, 'SIGTERM', signal);
      const grace = Math.max(0, Math.min(15000, deadlineMs * 0.75) - (performance.now() - started));
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await wait(Promise.race([c.exited, new Promise<void>(resolve => { graceTimer = setTimeout(resolve, grace); })]), signal);
      } finally { clearTimeout(graceTimer); }
      if (!c.didExit) await signalOwned(c, 'SIGKILL', signal);
      await wait(c.exited, signal);
    }
    await wait(c.output.finish(signal), signal);
    if (!c.didExit) stopUnknown();
  } catch { return stopUnknown(); }
  finally { clearTimeout(timer); deadline.abort(); }
}

/** Custody only. It does not read credentials, verify provider protocol, expose
 * health, or provision a tunnel. One instance permits one launch attempt and
 * can signal only the exact ManagedChild object it returned after native seal.
 */
export function createNativeTunnelCustody(options: TunnelCustodyOptions = {}): TunnelCustodyPort {
  const authority = options.authority;
  const launch = options.launch;
  let attempted = false;
  let active: Custody | null = null;
  const records = new WeakMap<ManagedChild, Custody>();
  return Object.freeze({
    async spawn(input: ServiceConfig, compatibility: TunnelCompatibility, core: CoreEvidence,
      nextGeneration: string, signal: AbortSignal) {
      if (attempted || signal.aborted || !authority || !launch || !generation(nextGeneration)) startFailed();
      attempted = true;
      let custody: Custody | null = null;
      try {
        const config = parseConfig(input);
        if (!config.tunnel.enabled || compatibility.digest !== config.tunnel.compatibilityDigest
          || !digest(compatibility.digest) || !validCore(core, config.releaseDigest)) startFailed();
        const grant = validGrant(await authority.acquire(config, compatibility, core, signal), config, compatibility);
        if (signal.aborted) startFailed();
        custody = takeCustody(launch(tunnelLaunchPlan(config)), grant.proof);
        active = custody;
        await custody.spawned;
        if (custody.raw.pid === undefined || !Number.isSafeInteger(custody.raw.pid) || custody.raw.pid < 1) {
          if (!custody.didExit) await custody.exited;
          startFailed();
        }
        const live = custody.raw as ChildProcess & { pid: number };
        custody.seal = await sealMacOwnedProcess(live, {
          role: 'tunnel', uid: grant.account.uid, generation: nextGeneration,
          releaseDigest: config.releaseDigest, executable: grant.executable,
        }, grant.proof, signal);
        if (custody.didExit || custody.seal === null) {
          if (!custody.didExit) await custody.exited;
          startFailed();
        }
        const managed = Object.freeze({ child: custody.seal.child, exited: custody.exited });
        custody.managed = managed; records.set(managed, custody);
        if (signal.aborted) {
          await stopCustody(custody, 20000, new AbortController().signal);
          startFailed();
        }
        return managed;
      } catch {
        if (custody && !custody.noProcess && !custody.didExit && custody.seal !== null) {
          try { await stopCustody(custody, 20000, new AbortController().signal); } catch { /* remains tracked */ }
        }
        return startFailed();
      }
    },
    async stop(managed: ManagedChild, deadlineMs: number, signal: AbortSignal) {
      const custody = records.get(managed);
      if (!custody || active !== custody || custody.managed !== managed || signal.aborted) stopUnknown();
      if (custody.stopping === null) custody.stopping = stopCustody(custody, deadlineMs, signal);
      await wait(custody.stopping, signal);
    },
  });
}
