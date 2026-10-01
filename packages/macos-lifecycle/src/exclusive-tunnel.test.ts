import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import { withExclusiveTunnelCustody } from './exclusive-tunnel.js';
import type { CoreEvidence } from './health-probe.js';
import type { ManagedChild, TunnelCompatibility } from './supervisor.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';
import { MemoryExecutionFiles, deferred, releaseDigest } from './test-support/execution-fixture.js';

const signal = () => new AbortController().signal;
const compatibility: TunnelCompatibility = Object.freeze({ digest: 'b'.repeat(64) });
const core: CoreEvidence = Object.freeze({ state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-g1',
  releaseDigest, observedAtMs: 1 });
function config() {
  return parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-001', releaseDigest,
    tunnel: { enabled: true, compatibilityDigest: compatibility.digest, credentialRef: 'test-tunnel-key' } });
}
function controlledTunnel() {
  const exit = deferred<void>(); let launches = 0; let stops = 0; let current: ManagedChild | null = null;
  const port: TunnelCustodyPort = {
    async spawn(_config, _compatibility, _core, generation) {
      launches++; current = { child: { role: 'tunnel', pid: 4343, uid: 501, startIdentity: '2.2', generation, releaseDigest },
        exited: exit.promise }; return current;
    },
    async stop() { stops++; exit.resolve(undefined); await exit.promise; },
  };
  return { port, exit, launches: () => launches, stops: () => stops, current: () => current };
}
async function setup() {
  const files = new MemoryExecutionFiles(); const leases = new ExecutionLeaseStore(files);
  await leases.initializeNew('tunnel'); const inner = controlledTunnel();
  return { files, leases, inner, port: withExclusiveTunnelCustody(inner.port, leases) };
}

describe('exclusive tunnel custody composition', () => {
  it('holds the shared tunnel slot before the native custody port is invoked', async () => {
    const f = await setup(); const spawn = f.inner.port.spawn;
    f.inner.port.spawn = async (...args) => {
      expect((await f.leases.read('tunnel')).state).toBe('HELD');
      return spawn(...args);
    };
    const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    expect(f.inner.launches()).toBe(1);
    await f.port.stop(child, 20000, signal());
    expect((await f.leases.read('tunnel')).state).toBe('FREE');
  });

  it('prevents another custody factory from spawning until actual exit', async () => {
    const f = await setup(); const other = controlledTunnel();
    const second = withExclusiveTunnelCustody(other.port, new ExecutionLeaseStore(f.files));
    const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    await expect(second.spawn(config(), compatibility, core, 'tg2', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(other.launches()).toBe(0);
    await f.port.stop(child, 20000, signal());
  });

  it('does not release merely because stop returned before the exit event', async () => {
    const f = await setup(); const entered = deferred<void>();
    f.inner.port.stop = async () => { entered.resolve(undefined); };
    const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    const stopping = f.port.stop(child, 20000, signal()); await entered.promise;
    expect((await f.leases.read('tunnel')).state).toBe('HELD');
    f.inner.exit.resolve(undefined); await stopping;
    expect((await f.leases.read('tunnel')).state).toBe('FREE');
  });

  it('releases after spontaneous exit without calling stop', async () => {
    const f = await setup(); const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    f.inner.exit.resolve(undefined); await child.exited;
    expect((await f.leases.read('tunnel')).state).toBe('FREE'); expect(f.inner.stops()).toBe(0);
  });

  it('releases a definite no-child inner rejection', async () => {
    const f = await setup(); f.inner.port.spawn = async () => { throw new Error('synthetic private error'); };
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect((await f.leases.read('tunnel')).state).toBe('FREE');
  });

  it('keeps the reservation when a returned child has foreign identity', async () => {
    const f = await setup(); const spawn = f.inner.port.spawn;
    f.inner.port.spawn = async (...args) => { const child = await spawn(...args); child.child.generation = 'foreign'; return child; };
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect((await f.leases.read('tunnel')).state).toBe('HELD'); expect(f.inner.stops()).toBe(0);
  });

  it('rejects copied managed handles and preserves the held reservation', async () => {
    const f = await setup(); const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    await expect(f.port.stop({ ...child }, 20000, signal())).rejects.toThrow(/^TUNNEL_STOP_UNKNOWN$/);
    expect(f.inner.stops()).toBe(0); expect((await f.leases.read('tunnel')).state).toBe('HELD');
    await f.port.stop(child, 20000, signal());
  });

  it('releases after cancellation during acquisition without launching a child', async () => {
    const f = await setup(); const abort = new AbortController(); const write = f.files.compareAndSwap.bind(f.files);
    f.files.compareAndSwap = async (...args) => { await write(...args); abort.abort(); };
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', abort.signal)).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.inner.launches()).toBe(0); expect((await f.leases.read('tunnel')).state).toBe('FREE');
  });

  it('never uses age or an old PID to reclaim an existing held tunnel generation', async () => {
    const f = await setup();
    await f.leases.acquire('tunnel', 'old', 'c'.repeat(64), releaseDigest);
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect((await f.leases.read('tunnel')).generation).toBe('old'); expect(f.inner.launches()).toBe(0);
  });

  it('does not launch when the tunnel execution record is absent', async () => {
    const files = new MemoryExecutionFiles(); const leases = new ExecutionLeaseStore(files); const inner = controlledTunnel();
    const port = withExclusiveTunnelCustody(inner.port, leases);
    await expect(port.spawn(config(), compatibility, core, 'tg1', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(inner.launches()).toBe(0);
  });

  it('does not launch after an uncertain reservation write and preserves the held slot', async () => {
    const f = await setup(); const write = f.files.compareAndSwap.bind(f.files);
    f.files.compareAndSwap = async (...args) => { await write(...args); throw new Error('uncertain'); };
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', signal())).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.inner.launches()).toBe(0);
    expect((await f.leases.read('tunnel')).state).toBe('HELD');
  });

  it('does not release a held tunnel slot when stop fails', async () => {
    const f = await setup(); f.inner.port.stop = async () => { throw new Error('private stop failure'); };
    const child = await f.port.spawn(config(), compatibility, core, 'tg1', signal());
    await expect(f.port.stop(child, 20000, signal())).rejects.toThrow(/^TUNNEL_STOP_UNKNOWN$/);
    expect((await f.leases.read('tunnel')).state).toBe('HELD');
    f.inner.exit.resolve(undefined); await child.exited;
  });

  it('writes no reservation when already cancelled', async () => {
    const f = await setup(); const abort = new AbortController(); abort.abort(); const writes = f.files.writes;
    await expect(f.port.spawn(config(), compatibility, core, 'tg1', abort.signal)).rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.inner.launches()).toBe(0); expect(f.files.writes).toBe(writes);
  });
});
