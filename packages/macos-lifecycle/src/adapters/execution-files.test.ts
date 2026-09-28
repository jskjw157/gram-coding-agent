import { mkdtemp, mkdir, readFile, chmod, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionFilesAt } from './execution-files.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { configDigest, releaseDigest } from '../test-support/execution-fixture.js';
const dirs: string[] = [];
async function setup() {
  const anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram-execution-'))); dirs.push(anchor);
  await chmod(anchor, 0o700); await mkdir(join(anchor, 'run'), { mode: 0o700 });
  const uid = process.getuid?.() ?? 0;
  const policy = { anchor, relative: 'run', ancestorUid: uid, stateUid: uid, acl: async () => true };
  const store = new ExecutionLeaseStore(createExecutionFilesAt(policy));
  await store.initializeNew('core'); return { anchor, policy, store };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('execution reservation over actual private record files (synthetic ACL)', () => {
  it('serializes independent contenders and persists the winning owner', async () => {
    const f = await setup(); const other = new ExecutionLeaseStore(createExecutionFilesAt(f.policy));
    const results = await Promise.allSettled([f.store.acquire('core', 'g1', configDigest, releaseDigest),
      other.acquire('core', 'g2', configDigest, releaseDigest)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await new ExecutionLeaseStore(createExecutionFilesAt(f.policy)).read('core')).state).toBe('HELD');
  });
  it('retains a crash-abandoned slot after constructing a fresh store', async () => {
    const f = await setup(); await f.store.acquire('core', 'g1', configDigest, releaseDigest);
    const file = join(f.anchor, 'run/core.execution.json'); const before = await readFile(file);
    await expect(new ExecutionLeaseStore(createExecutionFilesAt(f.policy)).acquire('core', 'g2', configDigest, releaseDigest))
      .rejects.toThrow('BUSY');
    expect(await readFile(file)).toEqual(before);
  });
  it('does not overwrite a crash-abandoned transaction lock', async () => {
    const f = await setup(); const lock = join(f.anchor, 'run/core.execution.lock');
    await writeFile(lock, 'synthetic-abandoned', { mode: 0o600 });
    await expect(f.store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('BUSY');
    expect(await readFile(lock, 'utf8')).toBe('synthetic-abandoned');
  });
  it('refuses unsafe permissions rather than creating or fixing paths', async () => {
    const f = await setup(); await chmod(join(f.anchor, 'run'), 0o777);
    await expect(f.store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('UNSAFE_PATH');
  });
  it('preserves corrupt reservation bytes without repair', async () => {
    const f = await setup(); const file = join(f.anchor, 'run/core.execution.json');
    await writeFile(file, 'not-json', { mode: 0o600 });
    await expect(f.store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('INVALID_EXECUTION');
    expect(await readFile(file, 'utf8')).toBe('not-json');
  });
  it('releases to a durable tombstone rather than deleting the ownership record', async () => {
    const f = await setup(); const lease = await f.store.acquire('core', 'g1', configDigest, releaseDigest);
    await f.store.release(lease);
    const saved = JSON.parse(await readFile(join(f.anchor, 'run/core.execution.json'), 'utf8'));
    expect(saved).toMatchObject({ state: 'FREE', generation: 'g1', revision: 2 });
  });
});
