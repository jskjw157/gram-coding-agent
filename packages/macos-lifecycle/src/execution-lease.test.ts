import { describe, expect, it } from 'vitest';
import { ExecutionLeaseStore, encodeExecution, decodeExecution } from './execution-lease.js';
import { MemoryExecutionFiles, configDigest, releaseDigest } from './test-support/execution-fixture.js';

async function setup() {
  const files = new MemoryExecutionFiles(); const store = new ExecutionLeaseStore(files);
  await store.initializeNew('core'); return { files, store };
}
describe('durable execution reservation', () => {
  it('never initializes a missing record during acquire', async () => {
    const files = new MemoryExecutionFiles();
    await expect(new ExecutionLeaseStore(files).acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('MISSING_EXECUTION');
    expect(files.writes).toBe(0);
  });
  it('initializes only an absent record and stores canonical nonsecret data', async () => {
    const { files, store } = await setup();
    expect(await store.read('core')).toMatchObject({ state: 'FREE', revision: 0, token: null });
    await expect(store.initializeNew('core')).rejects.toThrow('STATE_CONFLICT');
    const saved = files.values.get('core'); if (!saved) throw new Error('fixture');
    expect(encodeExecution(decodeExecution(saved))).toEqual(saved);
  });
  it('allows only one of two independent stores to acquire the same slot', async () => {
    const { files, store } = await setup(); const other = new ExecutionLeaseStore(files);
    const results = await Promise.allSettled([store.acquire('core', 'g1', configDigest, releaseDigest),
      other.acquire('core', 'g2', configDigest, releaseDigest)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await store.read('core')).state).toBe('HELD');
  });
  it('keeps a held reservation across a new store instance with no time-based stealing', async () => {
    const { files, store } = await setup(); await store.acquire('core', 'g1', configDigest, releaseDigest);
    await expect(new ExecutionLeaseStore(files).acquire('core', 'g2', configDigest, releaseDigest)).rejects.toThrow('BUSY');
    expect((await store.read('core')).generation).toBe('g1');
  });
  it('requires the original local lease capability, not copied fields', async () => {
    const { files, store } = await setup(); const lease = await store.acquire('core', 'g1', configDigest, releaseDigest);
    await expect(store.release({ ...lease })).rejects.toThrow('INVALID_EXECUTION');
    await expect(new ExecutionLeaseStore(files).release(lease)).rejects.toThrow('INVALID_EXECUTION');
    expect((await store.read('core')).state).toBe('HELD');
  });
  it('releases once and never lets an old release overwrite a later owner', async () => {
    const { store } = await setup(); const old = await store.acquire('core', 'g1', configDigest, releaseDigest);
    await Promise.all([store.release(old), store.release(old)]);
    const next = await store.acquire('core', 'g2', configDigest, releaseDigest);
    await store.release(old);
    expect(await store.read('core')).toMatchObject({ state: 'HELD', generation: 'g2', revision: 3 });
    await store.release(next); expect((await store.read('core')).revision).toBe(4);
  });
  it('does not reuse the previous generation after release', async () => {
    const { store } = await setup(); const lease = await store.acquire('core', 'g1', configDigest, releaseDigest);
    await store.release(lease);
    await expect(store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('INVALID_EXECUTION');
  });
  it.each(['', '../bad', 'a\nb', 'x'.repeat(129)])('rejects invalid generation without writing %s', async generation => {
    const { files, store } = await setup(); const before = files.writes;
    await expect(store.acquire('core', generation, configDigest, releaseDigest)).rejects.toThrow('INVALID_EXECUTION');
    expect(files.writes).toBe(before);
  });
  it('keeps damaged data instead of replacing it with a free record', async () => {
    const { files, store } = await setup(); files.values.set('core', Buffer.from('damaged'));
    await expect(store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('INVALID_EXECUTION');
    expect(files.values.get('core')?.toString()).toBe('damaged');
  });
  it('preserves a possibly committed reservation when durability confirmation fails', async () => {
    const { files, store } = await setup(); const write = files.compareAndSwap.bind(files);
    files.compareAndSwap = async (...args) => { await write(...args); throw new Error('private error path'); };
    await expect(store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow(/^STATE_IO$/);
    expect((await store.read('core')).state).toBe('HELD');
  });
  it('rejects duplicate JSON keys and unrecognized fields', async () => {
    const { files } = await setup(); const bytes = files.values.get('core'); if (!bytes) throw new Error('fixture');
    expect(() => decodeExecution(Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))))
      .toThrow('INVALID_EXECUTION');
    expect(() => encodeExecution({ ...decodeExecution(bytes), password: 'synthetic' })).toThrow('INVALID_EXECUTION');
  });
  it('keeps role reservations independent', async () => {
    const { store } = await setup(); await store.initializeNew('tunnel');
    await store.acquire('core', 'g1', configDigest, releaseDigest);
    await store.acquire('tunnel', 'g2', configDigest, releaseDigest);
    expect((await store.read('core')).generation).toBe('g1');
    expect((await store.read('tunnel')).generation).toBe('g2');
  });
});
