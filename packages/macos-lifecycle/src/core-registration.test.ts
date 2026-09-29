import { describe, expect, it } from 'vitest';
import { configDigest } from './config.js';
import { CoreRegistrationStore, decodeCoreRegistration, encodeCoreRegistration } from './core-registration.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import { child, config, digest, discoveryFixture, memoryFiles } from './test-support/runtime/discovery.js';

describe('private Core registration bound to the existing execution reservation', () => {
  it('does not create anything while reading absent metadata', async () => {
    const bytes = memoryFiles(); const store = new CoreRegistrationStore(bytes.files, new ExecutionLeaseStore(memoryFiles().files));
    expect(await store.read()).toBeNull(); expect(bytes.writes()).toBe(0);
  });
  it('publishes canonical data using the actual HELD token/revision, not caller identity strings', async () => {
    const f = await discoveryFixture(); const held = await f.execution.read('core'); const record = await f.registration.read();
    expect(record).toEqual({ schemaVersion: 1, role: 'core', configDigest: configDigest(config()),
      executionRevision: held.revision, executionToken: held.token, child: child() });
    expect(encodeCoreRegistration(record)).toEqual(f.recordBytes.values.get('core'));
    expect(decodeCoreRegistration(encodeCoreRegistration(record))).toEqual(record);
  });
  it('refuses publication without a matching active reservation', async () => {
    const f = await discoveryFixture(); await f.execution.release(f.lease);
    await expect(f.registration.publish(config(), child())).rejects.toThrow();
    expect(f.recordBytes.writes()).toBe(1);
  });
  it.each(['generation', 'releaseDigest', 'startIdentity'] as const)('refuses mismatched/invalid %s without a write', async key => {
    const f = await discoveryFixture(); const c = child(); c[key] = key === 'releaseDigest' ? 'b'.repeat(64) : 'other';
    await expect(f.registration.publish(config(), c)).rejects.toThrow(); expect(f.recordBytes.writes()).toBe(1);
  });
  it('repeated same-child publication is idempotent and a second child in the same slot is refused', async () => {
    const f = await discoveryFixture(); const before = await f.registration.read();
    expect(await f.registration.publish(config(), child())).toEqual(before); expect(f.recordBytes.writes()).toBe(1);
    await expect(f.registration.publish(config(), { ...child(), pid: 4243 })).rejects.toThrow(); expect(f.recordBytes.writes()).toBe(1);
  });
  it('permits a later held generation without deleting earlier execution history', async () => {
    const f = await discoveryFixture(); await f.execution.release(f.lease);
    await f.execution.acquire('core', 'g2', configDigest(config()), digest);
    expect(await f.registration.publish(config(), child('g2'))).toMatchObject({ executionRevision: 3, child: { generation: 'g2' } });
    expect(await f.execution.read('core')).toMatchObject({ state: 'HELD', revision: 3 });
  });
  it('refuses malformed existing data rather than repairing or replacing it', async () => {
    const f = await discoveryFixture(); const broken = Buffer.from('corrupt'); f.recordBytes.values.set('core', broken);
    await expect(f.registration.publish(config(), child())).rejects.toThrow();
    expect(f.recordBytes.values.get('core')).toEqual(broken);
  });
  it.each(['duplicate', 'extra', 'bom', 'newline'])('rejects noncanonical registration %s', async mode => {
    const f = await discoveryFixture(); const b = f.recordBytes.values.get('core'); if (!b) throw new Error('record');
    const s = b.toString(); const altered = mode === 'duplicate' ? s.replace('{', '{"schemaVersion":1,')
      : mode === 'extra' ? s.replace('{', '{"secret":"SYNTHETIC",') : mode === 'bom' ? '\uFEFF' + s : s + '\n';
    expect(() => decodeCoreRegistration(Buffer.from(altered))).toThrow('INVALID_CORE_REGISTRATION');
  });
  it('refuses a lease change during CAS, leaving only an unusable hint', async () => {
    const f = await discoveryFixture(); await f.execution.release(f.lease);
    const second = await f.execution.acquire('core', 'g2', configDigest(config()), digest);
    const original = f.recordBytes.files.compareAndSwap;
    f.recordBytes.files.compareAndSwap = async (...args) => { await original(...args); await f.execution.release(second); };
    await expect(f.registration.publish(config(), child('g2'))).rejects.toThrow();
    expect(await f.execution.read('core')).toMatchObject({ state: 'FREE', revision: 4 });
  });
});
