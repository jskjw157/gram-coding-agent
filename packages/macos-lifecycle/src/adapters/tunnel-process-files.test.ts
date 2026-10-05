import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from '../config.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { TunnelRegistrationStore, decodeTunnelRegistration } from '../tunnel-registration.js';
import { createExecutionFilesAt } from './execution-files.js';
import { createTunnelProcessFilesAt } from './tunnel-process-files.js';
import type { StateDirectoryPolicy } from './private-record-files.js';

const paths: string[] = [];
const releaseDigest = 'a'.repeat(64);
const config = () => parseConfig({
  schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-tunnel',
  releaseDigest, tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' },
});
const child = () => ({ role: 'tunnel' as const, pid: 4343, uid: 501, startIdentity: '1700000000.9',
  generation: 'tg1', releaseDigest });

async function setup() {
  const anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram-tunnel-discovery-')));
  paths.push(anchor); await chmod(anchor, 0o700);
  const directory = join(anchor, 'run'); await mkdir(directory, { mode: 0o700 });
  const uid = process.getuid?.() ?? -1;
  const policy: StateDirectoryPolicy = { anchor, relative: 'run', ancestorUid: uid, stateUid: uid, acl: async () => true };
  const execution = new ExecutionLeaseStore(createExecutionFilesAt(policy));
  await execution.initializeNew('tunnel');
  const lease = await execution.acquire('tunnel', 'tg1', configDigest(config()), releaseDigest);
  const files = createTunnelProcessFilesAt(policy);
  const store = new TunnelRegistrationStore(files, execution);
  return { directory, policy, execution, lease, files, store, file: join(directory, 'tunnel.process.json') };
}
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('fixed tunnel process records on real temporary files', () => {
  it('observes missing tunnel metadata without mutating the execution lease', async () => {
    const f = await setup(); const before = await readFile(join(f.directory, 'tunnel.execution.json'));
    expect(await f.store.read()).toBeNull();
    expect(await readFile(join(f.directory, 'tunnel.execution.json'))).toEqual(before);
  });

  it('persists tunnel.process.json for an independent reader', async () => {
    const f = await setup(); const before = await readFile(join(f.directory, 'tunnel.execution.json'));
    await f.store.publish(config(), child());
    const other = new TunnelRegistrationStore(createTunnelProcessFilesAt(f.policy), f.execution);
    expect(await other.read()).toEqual(decodeTunnelRegistration(await readFile(f.file)));
    expect(await readFile(join(f.directory, 'tunnel.execution.json'))).toEqual(before);
  });

  it.each(['permissions', 'symlink', 'hardlink'])('refuses unsafe %s without rewriting it', async kind => {
    const f = await setup(); await f.store.publish(config(), child()); const bytes = await readFile(f.file);
    if (kind === 'permissions') await chmod(f.file, 0o644);
    if (kind === 'hardlink') await link(f.file, join(f.directory, 'linked'));
    if (kind === 'symlink') {
      await rm(f.file); await writeFile(join(f.directory, 'target'), bytes, { mode: 0o600 }); await symlink('target', f.file);
    }
    await expect(f.store.read()).rejects.toThrow();
    expect(await readFile(f.file)).toEqual(bytes);
  });

  it('keeps an abandoned tunnel process lock and refuses publication', async () => {
    const f = await setup();
    await writeFile(join(f.directory, 'tunnel.process.lock'), 'owner-marker', { mode: 0o600 });
    await expect(f.store.publish(config(), child())).rejects.toThrow('BUSY');
    expect(await readFile(join(f.directory, 'tunnel.process.lock'), 'utf8')).toBe('owner-marker');
    expect(await f.store.read()).toBeNull();
  });

  it('allows only the fixed tunnel family and rejects core/arbitrary bytes', async () => {
    const f = await setup();
    await expect(f.files.read('core')).rejects.toThrow('INVALID_TUNNEL_REGISTRATION');
    await expect(f.files.compareAndSwap('tunnel', [null], 0, Buffer.from('{}')))
      .rejects.toThrow('INVALID_TUNNEL_REGISTRATION');
  });

  it('retains the last registration after lease release without claiming liveness', async () => {
    const f = await setup(); const value = await f.store.publish(config(), child());
    await f.execution.release(f.lease);
    expect(await f.store.read()).toEqual(value);
    expect(await f.execution.read('tunnel')).toMatchObject({ state: 'FREE' });
  });
});
