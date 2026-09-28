import { describe, expect, it } from 'vitest';
import { ExecutionLeaseStore } from './execution-lease.js';
import { withExclusiveCore } from './exclusive-core.js';
import { createNativeCorePort } from './adapters/native-core.js';
import { MemoryExecutionFiles, controlledCore, deferred, labConfig, configDigest, releaseDigest } from './test-support/execution-fixture.js';

const signal = () => new AbortController().signal;
async function setup() {
  const files = new MemoryExecutionFiles(); const leases = new ExecutionLeaseStore(files);
  await leases.initializeNew('core'); const inner = controlledCore();
  return { files, leases, inner, port: withExclusiveCore(inner.port, leases) };
}
describe('exclusive Core composition', () => {
  it('holds the shared slot before the native launch port is invoked', async () => {
    const f = await setup(); const launch = f.inner.port.spawn;
    f.inner.port.spawn = async (...args) => {
      expect((await f.leases.read('core')).state).toBe('HELD'); return launch(...args);
    };
    const child = await f.port.spawn(labConfig(), 'g1', signal());
    expect(f.inner.launches()).toBe(1); await f.port.stop(child, 20000, signal());
    expect((await f.leases.read('core')).state).toBe('FREE');
  });
  it('prevents another factory from spawning until actual exit', async () => {
    const f = await setup(); const other = controlledCore();
    const second = withExclusiveCore(other.port, new ExecutionLeaseStore(f.files));
    const child = await f.port.spawn(labConfig(), 'g1', signal());
    await expect(second.spawn(labConfig(), 'g2', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(other.launches()).toBe(0); await f.port.stop(child, 20000, signal());
  });
  it('does not release merely because stop returned before the exit event', async () => {
    const f = await setup(); const entered = deferred<undefined>();
    f.inner.port.stop = async () => { entered.resolve(undefined); };
    const child = await f.port.spawn(labConfig(), 'g1', signal());
    const stopping = f.port.stop(child, 20000, signal()); await entered.promise;
    expect((await f.leases.read('core')).state).toBe('HELD');
    f.inner.exit.resolve(undefined); await stopping;
    expect((await f.leases.read('core')).state).toBe('FREE');
  });
  it('releases after spontaneous exit without calling stop', async () => {
    const f = await setup(); const child = await f.port.spawn(labConfig(), 'g1', signal());
    f.inner.exit.resolve(undefined); await child.exited;
    expect((await f.leases.read('core')).state).toBe('FREE');
    expect(f.inner.stops()).toBe(0);
  });
  it('releases on definite no-child start rejection but keeps an unresolved start reserved', async () => {
    const f = await setup(); f.inner.port.spawn = async () => { throw new Error('synthetic private error'); };
    await expect(f.port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect((await f.leases.read('core')).state).toBe('FREE');
    const never = controlledCore(); const entered = deferred<undefined>();
    never.port.spawn = async () => { entered.resolve(undefined); return new Promise(() => {}); };
    const port = withExclusiveCore(never.port, f.leases); const abort = new AbortController();
    void port.spawn(labConfig(), 'g2', abort.signal);
    await entered.promise; abort.abort();
    expect((await f.leases.read('core')).state).toBe('HELD');
  });
  it('does not launch if the reservation write has an uncertain outcome', async () => {
    const f = await setup(); const write = f.files.compareAndSwap.bind(f.files);
    f.files.compareAndSwap = async (...args) => { await write(...args); throw new Error('uncertain'); };
    await expect(f.port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.inner.launches()).toBe(0); expect((await f.leases.read('core')).state).toBe('HELD');
  });
  it('rejects copied managed handles and preserves the held reservation', async () => {
    const f = await setup(); const child = await f.port.spawn(labConfig(), 'g1', signal());
    await expect(f.port.stop({ ...child }, 20000, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect(f.inner.stops()).toBe(0); expect((await f.leases.read('core')).state).toBe('HELD');
    await f.port.stop(child, 20000, signal());
  });
  it('does not reset a held record after failed stop', async () => {
    const f = await setup(); f.inner.port.stop = async () => { throw new Error('private error'); };
    const child = await f.port.spawn(labConfig(), 'g1', signal());
    await expect(f.port.stop(child, 20000, signal())).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    expect((await f.leases.read('core')).state).toBe('HELD');
    f.inner.exit.resolve(undefined); await child.exited;
  });
  it('does not clear a foreign or ambiguous returned child', async () => {
    const f = await setup(); const spawn = f.inner.port.spawn;
    f.inner.port.spawn = async (...args) => { const c = await spawn(...args); c.child.generation = 'foreign'; return c; };
    await expect(f.port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect((await f.leases.read('core')).state).toBe('HELD'); expect(f.inner.stops()).toBe(0);
  });
  it('stops no child and writes no reservation when already cancelled', async () => {
    const f = await setup(); const abort = new AbortController(); abort.abort();
    await expect(f.port.spawn(labConfig(), 'g1', abort.signal)).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.inner.launches()).toBe(0); expect(f.files.writes).toBe(1);
  });
  it('refuses default native launch without a shared reservation store before authority use', async () => {
    let calls = 0;
    const core = createNativeCorePort({ authority: { async acquire() { calls++; return null; } },
      credentials: { async withValue(use) { return use('synthetic'); } } });
    await expect(core.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(calls).toBe(0);
  });
  it('does not allow absent history to become a launch permission', async () => {
    const inner = controlledCore(); const port = withExclusiveCore(inner.port, new ExecutionLeaseStore(new MemoryExecutionFiles()));
    await expect(port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(inner.launches()).toBe(0);
  });
  it('releases after cancellation during acquisition without starting a child', async () => {
    const f = await setup(); const abort = new AbortController(); const write = f.files.compareAndSwap.bind(f.files);
    f.files.compareAndSwap = async (...args) => { await write(...args); abort.abort(); };
    await expect(f.port.spawn(labConfig(), 'g1', abort.signal)).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(f.inner.launches()).toBe(0); expect((await f.leases.read('core')).state).toBe('FREE');
  });
  it('never uses clock expiry or an old PID to reclaim a held generation', async () => {
    const f = await setup(); await f.leases.acquire('core', 'old', configDigest, releaseDigest);
    await expect(f.port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect((await f.leases.read('core')).generation).toBe('old'); expect(f.inner.launches()).toBe(0);
  });
});
