import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import {
  TunnelRegistrationStore, decodeTunnelRegistration, encodeTunnelRegistration,
  matchesTunnelExecution,
} from './tunnel-registration.js';
import { MemoryExecutionFiles, MemoryExecutionFiles as MemoryRecordFiles, releaseDigest } from './test-support/execution-fixture.js';

const config = () => parseConfig({
  schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-tunnel',
  releaseDigest, tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' },
});
const child = (generation='tg1') => ({
  role: 'tunnel' as const, pid: 4343, uid: 501, startIdentity: '1700000000.9', generation, releaseDigest,
});

describe('durable tunnel process registration', () => {
  it('publishes the exact held tunnel execution identity and round-trips canonically', async () => {
    const execFiles = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(execFiles);
    await execution.initializeNew('tunnel');
    await execution.acquire('tunnel', 'tg1', configDigest(config()), releaseDigest);
    const files = new MemoryRecordFiles();
    const store = new TunnelRegistrationStore(files, execution);
    const record = await store.publish(config(), child());
    expect(record).toMatchObject({ role: 'tunnel', configDigest: configDigest(config()),
      executionRevision: 1, child: child() });
    expect(typeof record.executionToken).toBe('string');
    const saved = files.values.get('tunnel'); if (!saved) throw new Error('missing');
    expect(encodeTunnelRegistration(decodeTunnelRegistration(saved))).toEqual(saved);
    expect(matchesTunnelExecution(record, await execution.read('tunnel'))).toBe(true);
  });

  it('refuses publication without an exact held tunnel execution', async () => {
    const execFiles = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(execFiles);
    await execution.initializeNew('tunnel');
    const files = new MemoryRecordFiles(); const store = new TunnelRegistrationStore(files, execution);
    await expect(store.publish(config(), child())).rejects.toThrow(/^INVALID_TUNNEL_REGISTRATION$/);
    expect(files.writes).toBe(0);
  });

  it('refuses foreign role, generation and release identities', async () => {
    for (const changed of [
      { ...child(), role: 'core' as const },
      { ...child(), generation: 'other' },
      { ...child(), releaseDigest: 'c'.repeat(64) },
    ]) {
      const execFiles = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(execFiles);
      await execution.initializeNew('tunnel');
      await execution.acquire('tunnel', 'tg1', configDigest(config()), releaseDigest);
      const store = new TunnelRegistrationStore(new MemoryRecordFiles(), execution);
      await expect(store.publish(config(), changed as never)).rejects.toThrow(/^INVALID_TUNNEL_REGISTRATION$/);
    }
  });

  it('does not let an older registration overwrite a newer tunnel execution', async () => {
    const execFiles = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(execFiles);
    await execution.initializeNew('tunnel');
    const files = new MemoryRecordFiles(); const store = new TunnelRegistrationStore(files, execution);
    const first = await execution.acquire('tunnel', 'tg1', configDigest(config()), releaseDigest);
    await store.publish(config(), child('tg1'));
    await execution.release(first);
    await execution.acquire('tunnel', 'tg2', configDigest(config()), releaseDigest);
    await expect(store.publish(config(), child('tg1'))).rejects.toThrow(/^INVALID_TUNNEL_REGISTRATION$/);
    expect((await store.read())?.child.generation).toBe('tg1');
  });

  it('rejects unknown fields and a copied record that does not match execution', async () => {
    expect(() => encodeTunnelRegistration({
      schemaVersion: 1, role: 'tunnel', configDigest: 'a'.repeat(64), executionRevision: 1,
      executionToken: '11111111-1111-4111-8111-111111111111', child: child(), password: 'synthetic',
    })).toThrow(/^INVALID_TUNNEL_REGISTRATION$/);
    const execFiles = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(execFiles);
    await execution.initializeNew('tunnel'); await execution.acquire('tunnel', 'tg1', configDigest(config()), releaseDigest);
    const fake = {
      schemaVersion: 1 as const, role: 'tunnel' as const, configDigest: configDigest(config()),
      executionRevision: 1, executionToken: '11111111-1111-4111-8111-111111111111', child: child(),
    };
    expect(matchesTunnelExecution(fake, await execution.read('tunnel'))).toBe(false);
  });
});
