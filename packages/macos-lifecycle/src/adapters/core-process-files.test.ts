import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configDigest } from '../config.js';
import { CoreRegistrationStore, decodeCoreRegistration } from '../core-registration.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { child, config, digest } from '../test-support/runtime/discovery.js';
import { createExecutionFilesAt } from './execution-files.js';
import { createCoreProcessFilesAt } from './core-process-files.js';
import type { StateDirectoryPolicy } from './private-record-files.js';
const paths: string[] = [];
async function setup() {
  const anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram-core-discovery-'))); paths.push(anchor); await chmod(anchor, 0o700);
  const directory = join(anchor, 'run'); await mkdir(directory, { mode: 0o700 });
  const uid = process.getuid?.() ?? -1;
  const policy: StateDirectoryPolicy = { anchor, relative: 'run', ancestorUid: uid, stateUid: uid, acl: async () => true };
  const execution = new ExecutionLeaseStore(createExecutionFilesAt(policy)); await execution.initializeNew('core');
  const lease = await execution.acquire('core', 'g1', configDigest(config()), digest);
  const files = createCoreProcessFilesAt(policy); const store = new CoreRegistrationStore(files, execution);
  return { directory, policy, execution, lease, files, store, file: join(directory, 'core.process.json') };
}
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('fixed process records on real temporary files, synthetic ACL capability', () => {
  it('observes missing metadata without writing or resetting the execution lease', async () => {
    const f = await setup(); const before = await readFile(join(f.directory, 'core.execution.json'));
    expect(await f.store.read()).toBeNull(); expect(await readFile(join(f.directory, 'core.execution.json'))).toEqual(before);
  });
  it('persists a record for an independently constructed reader and preserves the existing lease', async () => {
    const f = await setup(); const before = await readFile(join(f.directory, 'core.execution.json'));
    await f.store.publish(config(), child());
    const other = new CoreRegistrationStore(createCoreProcessFilesAt(f.policy), f.execution);
    expect(await other.read()).toEqual(decodeCoreRegistration(await readFile(f.file)));
    expect(await readFile(join(f.directory, 'core.execution.json'))).toEqual(before);
  });
  it.each(['permissions', 'symlink', 'hardlink'])('refuses unsafe %s without changing the target', async kind => {
    const f = await setup(); await f.store.publish(config(), child()); const bytes = await readFile(f.file);
    if (kind === 'permissions') await chmod(f.file, 0o644);
    if (kind === 'hardlink') await link(f.file, join(f.directory, 'linked'));
    if (kind === 'symlink') { await rm(f.file); await writeFile(join(f.directory, 'target'), bytes, { mode: 0o600 }); await symlink('target', f.file); }
    await expect(f.store.read()).rejects.toThrow(); expect(await readFile(f.file)).toEqual(bytes);
  });
  it('keeps a pre-existing transaction lock and does not publish over it', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'core.process.lock'), 'owner-marker', { mode: 0o600 });
    await expect(f.store.publish(config(), child())).rejects.toThrow('BUSY');
    expect(await readFile(join(f.directory, 'core.process.lock'), 'utf8')).toBe('owner-marker'); expect(await f.store.read()).toBeNull();
  });
  it('allows only the fixed Core family, never a tunnel registration or arbitrary record', async () => {
    const f = await setup(); await expect(f.files.read('tunnel')).rejects.toThrow('INVALID_CORE_REGISTRATION');
    await expect(f.files.compareAndSwap('core', [null], 0, Buffer.from('{}'))).rejects.toThrow('INVALID_CORE_REGISTRATION'); expect(await f.store.read()).toBeNull();
  });
  it('retains the last registration after confirmed lease release without claiming liveness', async () => {
    const f = await setup(); const value = await f.store.publish(config(), child()); await f.execution.release(f.lease);
    expect(await f.store.read()).toEqual(value); expect(await f.execution.read('core')).toMatchObject({ state: 'FREE' });
  });
});
