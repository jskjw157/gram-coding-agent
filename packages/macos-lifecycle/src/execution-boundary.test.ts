import { describe, expect, it } from 'vitest';
import { ExecutionLeaseStore } from './execution-lease.js';
import { withExclusiveCore } from './exclusive-core.js';
import { createNativeCorePort } from './adapters/native-core.js';
import { MemoryExecutionFiles, controlledCore, labConfig, configDigest, releaseDigest } from './test-support/execution-fixture.js';
const signal = () => new AbortController().signal;

describe('reservation boundary review', () => {
  it.each([null, false, 'UNKNOWN', {}])('refuses an invalid default reservation provider %s', async execution => {
    let called = 0;
    const port = createNativeCorePort({ execution: execution as unknown as ExecutionLeaseStore,
      authority: { async acquire() { called++; return null; } },
      credentials: { async withValue(use) { return use('synthetic'); } } });
    await expect(port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(called).toBe(0);
  });
  it('reserves before the actual native port consults its authority', async () => {
    const leases = new ExecutionLeaseStore(new MemoryExecutionFiles()); await leases.initializeNew('core');
    let called = 0;
    const port = createNativeCorePort({ execution: leases,
      authority: { async acquire() { called++; expect((await leases.read('core')).state).toBe('HELD'); return null; } },
      credentials: { async withValue(use) { return use('synthetic'); } } });
    await expect(port.spawn(labConfig(), 'g1', signal())).rejects.toThrow(/^CORE_START_FAILED$/);
    expect(called).toBe(1); expect((await leases.read('core')).state).toBe('FREE');
  });
  it('stops health forwarding after uncertain termination evidence without freeing the slot', async () => {
    const leases = new ExecutionLeaseStore(new MemoryExecutionFiles()); await leases.initializeNew('core');
    const inner = controlledCore(); let probes = 0;
    inner.port.probe = async () => { probes++; return { state: 'LOCAL_CORE_HEALTHY', code: 'OK',
      generation: 'g1', releaseDigest, observedAtMs: Date.now() }; };
    const port = withExclusiveCore(inner.port, leases); const child = await port.spawn(labConfig(), 'g1', signal());
    const rejected = expect(child.exited).rejects.toThrow(/^CORE_STOP_UNKNOWN$/);
    inner.exit.reject(new Error('synthetic uncertain exit')); await rejected;
    expect((await port.probe(child.child, signal())).state).toBe('UNKNOWN');
    expect(probes).toBe(0); expect((await leases.read('core')).state).toBe('HELD');
  });
  it('never retries an uncertain release against a newly acquired slot', async () => {
    const files = new MemoryExecutionFiles(); const leases = new ExecutionLeaseStore(files);
    await leases.initializeNew('core'); const held = await leases.acquire('core', 'g1', configDigest, releaseDigest);
    const write = files.compareAndSwap.bind(files);
    files.compareAndSwap = async (...args) => { await write(...args); throw new Error('uncertain after commit'); };
    await expect(leases.release(held)).rejects.toThrow(/^STATE_IO$/);
    files.compareAndSwap = write;
    const next = new ExecutionLeaseStore(files); await next.acquire('core', 'g2', configDigest, releaseDigest);
    await expect(leases.release(held)).rejects.toThrow(/^STATE_IO$/);
    expect((await next.read('core')).generation).toBe('g2');
  });
});
