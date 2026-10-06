import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDigest, parseConfig } from '../config.js';
import { root } from '../contracts.js';
import type { ManagedChild } from '../supervisor.js';
import { coreLaunchPlan, createNativeCorePort, type CoreLaunchGrant, type CoreLaunchPlan,
  type NativeCoreOptions } from './native-core.js';
import type { NativePeerProofPort } from './owned-process.js';

const children: ChildProcess[] = [];
const signal = () => new AbortController().signal;
const lab = () => parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } });
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not ready'); };
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function ended(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
function actualExit(child: ChildProcess): Promise<void> {
  return ended(child) ? Promise.resolve() : new Promise(done => child.once('exit', () => done()));
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.pid && !ended(child)) { const exit = actualExit(child); child.kill('SIGKILL'); await exit; }
    child.stdout?.destroy(); child.stderr?.destroy();
    if (child.connected) child.disconnect();
  }
});
async function fixture(ignoreTerm = false) {
  const executable = await stat(process.execPath, { bigint: true });
  const commands: Readonly<CoreLaunchPlan>[] = []; const spawned = deferred<ChildProcess>();
  let raw: ChildProcess | undefined; let ready: Promise<void> = Promise.resolve(); let uses = 0;
  const proof: NativePeerProofPort = {
    async capture() { await ready; return { sec: '1700000000', usec: '1' }; },
    async current() { return raw && !ended(raw) ? 'OWNED' : 'UNKNOWN'; },
    async peer() { return 'UNKNOWN'; },
  };
  const grant: CoreLaunchGrant = { configDigest: configDigest(lab()),
    account: { name: 'gram-agent', uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, admin: false },
    executable: { dev: executable.dev, ino: executable.ino }, proof };
  const options: NativeCoreOptions = {
    authority: { async acquire() { return grant; } },
    credentials: { async withValue(use) { uses++; return use('synthetic-native-core-secret'); } },
    launch(plan) {
      commands.push(plan);
      raw = spawn(process.execPath, ['-e', [
        ignoreTerm ? "process.on('SIGTERM',()=>{});" : '',
        "process.stdout.write('synthetic-output-not-for-logs');",
        "process.stderr.write('synthetic-error-not-for-logs');",
        "setInterval(()=>{},1000);process.send({ready:true});",
      ].join('')], { shell: false, detached: false, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(raw);
      const child = raw;
      ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('fixture timeout')); }, 3000);
        const onMessage = () => { cleanup(); resolve(); };
        const onExit = () => { cleanup(); reject(new Error('fixture ended')); };
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
        child.once('message', onMessage); child.once('exit', onExit);
      });
      void ready.catch(() => {}); spawned.resolve(raw); return raw;
    },
  };
  return { options, grant, proof, commands, spawned: spawned.promise, uses: () => uses };
}

describe('fixed core launch recipe', () => {
  it('has one fixed entry and only nonsecret allowlisted environment paths', () => {
    const p = coreLaunchPlan(lab()); const release = `${root}/releases/lab-001`;
    expect(p).toEqual({ file: `${release}/bin/node`, args: [`${release}/apps/agent/dist/main.js`], cwd: release,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent',
        GRAM_AGENT_STATE_DIR: `${root}/state`, GRAM_AGENT_SECRET_DIR: `${root}/secrets` } });
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.args)).toBe(true); expect(Object.isFrozen(p.env)).toBe(true);
  });
  it.each(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'HTTP_PROXY', 'HTTPS_PROXY',
    'OPENAI_API_KEY', 'GRAM_AGENT_STATE_DIR'])('does not inherit %s', key => {
    vi.stubEnv(key, 'synthetic-untrusted-parent-value');
    expect(JSON.stringify(coreLaunchPlan(lab()))).not.toContain('synthetic-untrusted-parent-value');
  });
  it('does not accept executable/argument/port additions or retain caller mutations', () => {
    const config = lab(); const plan = coreLaunchPlan(config); config.releaseId = 'changed';
    expect(plan.file).toContain('/lab-001/');
    expect(() => coreLaunchPlan({ ...lab(), executable: '/bin/sh' } as ReturnType<typeof lab>)).toThrow(/^INVALID_CONFIG$/);
  });
});

describe('real direct-child custody with synthetic identity proof', () => {
  it('fails closed without independent launch authority and never calls launcher', async () => {
    const f = await fixture(); delete f.options.authority;
    await expect(createNativeCorePort(f.options).spawn(lab(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.commands).toHaveLength(0);
  });
  it.each(['digest', 'admin', 'uid', 'inode'])('refuses invalid %s before launching', async kind => {
    const f = await fixture();
    if (kind === 'digest') f.grant.configDigest = 'b'.repeat(64);
    if (kind === 'admin') f.grant.account.admin = true;
    if (kind === 'uid') f.grant.account.uid = 0;
    if (kind === 'inode') f.grant.executable.ino = 0n;
    await expect(createNativeCorePort(f.options).spawn(lab(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.commands).toHaveLength(0); expect(f.uses()).toBe(0);
  });
  it('starts exactly one registered child and resolves exited only after actual termination', async () => {
    const f = await fixture(); const port = createNativeCorePort(f.options);
    const item = await port.spawn(lab(), 'g1', signal()); const raw = await f.spawned;
    let exited = false; void item.exited.then(() => { exited = true; });
    await new Promise<void>(done => setImmediate(done)); expect(exited).toBe(false);
    expect(item.child.pid).toBe(raw.pid); expect(item.child.generation).toBe('g1');
    expect(JSON.stringify(item)).not.toContain('synthetic-output-not-for-logs');
    await expect(port.spawn(lab(), 'g2', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    await port.stop(item, 2000, signal()); await item.exited;
    expect(ended(raw)).toBe(true); expect(exited).toBe(true); expect(f.commands).toHaveLength(1); expect(f.uses()).toBe(0);
  });
  it('does not accept a copied handle or foreign health identity', async () => {
    const f = await fixture(); const port = createNativeCorePort(f.options); const item = await port.spawn(lab(), 'g1', signal());
    const raw = await f.spawned; const kill = vi.spyOn(raw, 'kill');
    await expect(port.stop({ ...item }, 2000, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect(kill).not.toHaveBeenCalled();
    expect((await port.probe({ ...item.child, generation: 'foreign' }, signal())).state).toBe('UNKNOWN');
    expect(f.uses()).toBe(0); await port.stop(item, 2000, signal());
  });
  it('refuses UNKNOWN ownership without signalling an actual running child', async () => {
    const f = await fixture(); const port = createNativeCorePort(f.options); const item = await port.spawn(lab(), 'g1', signal());
    const raw = await f.spawned; const kill = vi.spyOn(raw, 'kill'); f.proof.current = async () => 'UNKNOWN';
    await expect(port.stop(item, 2000, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect(kill).not.toHaveBeenCalled(); expect(ended(raw)).toBe(false);
  });
  it('revalidates and escalates a SIGTERM-resistant child without treating killed as exited', async () => {
    const f = await fixture(true); const port = createNativeCorePort(f.options); const item = await port.spawn(lab(), 'g1', signal());
    const raw = await f.spawned; const kill = vi.spyOn(raw, 'kill'); let checksAfterTerm = 0;
    f.proof.current = async () => { if (raw.killed) checksAfterTerm++; return ended(raw) ? 'UNKNOWN' : 'OWNED'; };
    await port.stop(item, 1600, signal()); await item.exited;
    expect(kill.mock.calls.map(args => args[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(checksAfterTerm).toBeGreaterThan(0); expect(raw.signalCode).toBe('SIGKILL');
  }, 5000);
  it('will not escalate after ownership is lost', async () => {
    const f = await fixture(true); const port = createNativeCorePort(f.options); const item = await port.spawn(lab(), 'g1', signal());
    const raw = await f.spawned; const kill = vi.spyOn(raw, 'kill');
    f.proof.current = async () => raw.killed ? 'FOREIGN' : 'OWNED';
    await expect(port.stop(item, 1000, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect(kill.mock.calls.map(args => args[0])).toEqual(['SIGTERM']); expect(ended(raw)).toBe(false);
  });
  it('refuses a pre-cancelled start before launching anything', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(createNativeCorePort(f.options).spawn(lab(), 'g1', controller.signal)).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.commands).toHaveLength(0);
  });
  it('does not report a cancelled post-spawn as absent before cleanup is confirmed', async () => {
    const f = await fixture(); const capture = deferred<{ sec: string; usec: string }>();
    const entered = deferred<undefined>(); f.proof.capture = async () => { entered.resolve(undefined); return capture.promise; };
    const controller = new AbortController(); const port = createNativeCorePort(f.options);
    const result = port.spawn(lab(), 'g1', controller.signal).then(() => 'returned', () => 'rejected');
    await entered.promise; const raw = await f.spawned; controller.abort();
    capture.resolve({ sec: '1700000000', usec: '1' });
    expect(await result).toBe('rejected'); expect(ended(raw)).toBe(true);
  });
  it('quarantines an unprovable child instead of rejecting while it still runs', async () => {
    const f = await fixture(); const entered = deferred<undefined>();
    f.proof.capture = async () => { entered.resolve(undefined); return null; };
    const port = createNativeCorePort(f.options); let settled = false;
    const result = port.spawn(lab(), 'g1', signal()).then(() => { settled = true; }, () => { settled = true; });
    await entered.promise; const raw = await f.spawned;
    await new Promise<void>(done => setImmediate(done)); expect(settled).toBe(false); expect(raw.killed).toBe(false);
    await expect(port.spawn(lab(), 'g2', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    const exit = actualExit(raw); raw.kill('SIGKILL'); await exit; await result;
    expect(settled).toBe(true);
  });
  it('sanitizes actual spawn errors without leaking their file path', async () => {
    const f = await fixture(); f.options.launch = () => {
      const child = spawn('/nonexistent/synthetic-sensitive-start-path', [], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); return child;
    };
    await expect(createNativeCorePort(f.options).spawn(lab(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
  });
  it.each([0, -1, 20001, Number.NaN])('rejects invalid stop limit %s without signalling', async ms => {
    const f = await fixture(); const port = createNativeCorePort(f.options); const item: ManagedChild = await port.spawn(lab(), 'g1', signal());
    const raw = await f.spawned; const kill = vi.spyOn(raw, 'kill');
    await expect(port.stop(item, ms, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect(kill).not.toHaveBeenCalled();
  });
});
