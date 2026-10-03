import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { renderPlist } from './launchd-plist.js';
import { createTrustedFiles } from './adapters/trusted-files.js';
import { probeTrustedPath } from './adapters/trusted-presence.js';
import type { LocalAccount } from './adapters/macos-inspection.js';
import type { RegistryObservation } from './adapters/macos-service-probes.js';
import { inspectInstallation, type InstallFile, type InstallationIO } from './installation-inspection.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const names = { configuration: 'config/service.json', manifest: 'config/installation.json',
  journal: 'config/install-journal.json', core: 'plists/core.plist', tunnel: 'plists/tunnel.plist' } as const;
const keys = Object.keys(names) as InstallFile[];
const roots: string[] = [];
const account: LocalAccount = { name: 'gram-agent', uid: 501, gid: 20, admin: false, groupsComplete: true };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(installed = false, tunnel = false) {
  const root = await mkdtemp(join(tmpdir(), 'mac02-install-identity-')); roots.push(root);
  await mkdir(join(root, 'config')); await mkdir(join(root, 'plists')); await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'secrets/DO_NOT_READ'), 'inert fixture; not a credential', { mode: 0o000 });
  const uid = process.getuid?.() ?? 0;
  const trusted = createTrustedFiles(root, uid, async () => true);
  const calls: string[] = [];
  let registry: RegistryObservation = { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: null, tunnel: null } };
  const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-old',
    releaseDigest: 'a'.repeat(64), tunnel: tunnel ? { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' } : { enabled: false } });
  const configuration = Buffer.from(JSON.stringify(config));
  const core = Buffer.from(renderPlist(config, 'core'));
  const tunnelBytes = tunnel ? Buffer.from(renderPlist(config, 'tunnel')) : null;
  const manifest = { schemaVersion: 1, state: 'COMMITTED', runtime: { name: 'gram-agent', uid: 501, gid: 20 },
    configSha256: sha(configuration), releaseId: config.releaseId, releaseDigest: config.releaseDigest,
    plistSha256: { core: sha(core), tunnel: tunnelBytes ? sha(tunnelBytes) : null },
    desiredEnabled: { core: false, tunnel: false } };
  const put = async (key: InstallFile, bytes: Buffer | string) => writeFile(join(root, names[key]), bytes, { mode: 0o600 });
  const putManifest = () => put('manifest', JSON.stringify(manifest));
  if (installed) {
    await put('configuration', configuration); await put('core', core); await putManifest();
    if (tunnelBytes) await put('tunnel', tunnelBytes);
    registry = { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: true, tunnel: tunnel ? true : null } };
  }
  const io: InstallationIO = {
    async presence(key) { calls.push(`presence:${key}`); return probeTrustedPath(root, uid, async () => true, names[key]); },
    async read(key, limit) { calls.push(`read:${key}`); return trusted.read(names[key], limit); },
    async registry() { calls.push('registry'); return structuredClone(registry); },
    async verifyRelease(candidate) { calls.push('verifyRelease'); return JSON.stringify(candidate) === JSON.stringify(config); },
  };
  async function snapshot(): Promise<string> {
    const values: unknown[] = [];
    for (const key of keys) {
      try { const s = await lstat(join(root, names[key])); values.push([key, s.mode, sha(await readFile(join(root, names[key])))]); }
      catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; values.push([key, null]); }
    }
    values.push(await readdir(join(root, 'secrets')));
    return JSON.stringify(values);
  }
  return { root, io, calls, config, manifest, put, putManifest, snapshot, setRegistry: (value: RegistryObservation) => { registry = value; } };
}
const rejected = /^FOREIGN_SERVICE$/;
describe('installation identity from bounded trusted bytes', () => {
  it('recognizes an empty installation only after both registry and all fixed paths are checked', async () => {
    const f = await fixture(); const before = await f.snapshot();
    expect(await inspectInstallation(account, f.io)).toEqual({ owned: true, safePaths: true, digest: null,
      present: { core: false, tunnel: false }, enabled: { core: false, tunnel: false } });
    expect(f.calls.filter(c => c.startsWith('read:'))).toEqual([]);
    expect(keys.every(k => f.calls.includes(`presence:${k}`))).toBe(true);
    expect(f.calls.filter(c => c === 'registry')).toHaveLength(2);
    expect(await f.snapshot()).toBe(before);
  });
  it.each(keys)('refuses an orphaned %s without treating it as a new installation', async key => {
    const f = await fixture(); await f.put(key, '{}');
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('refuses a registered job or enabled override even with no disk files', async () => {
    for (const registry of [
      { jobs: { core: 'present', tunnel: 'absent' }, overrides: { core: null, tunnel: null } },
      { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: false, tunnel: null } },
    ] as RegistryObservation[]) {
      const f = await fixture(); f.setRegistry(registry);
      await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
    }
  });
  it.each([false, true])('verifies stopped installation with tunnel=%s without mutating bytes or reading secrets', async tunnel => {
    const f = await fixture(true, tunnel); const before = await f.snapshot();
    const evidence = await inspectInstallation(account, f.io);
    expect(evidence).toMatchObject({ owned: true, safePaths: true, present: { core: true, tunnel }, enabled: { core: false, tunnel: false } });
    expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await inspectInstallation(account, f.io)).digest).toBe(evidence.digest);
    expect(f.calls).toContain('verifyRelease');
    expect(f.calls.filter(c => c.includes('secret'))).toEqual([]);
    expect(await f.snapshot()).toBe(before);
  });
  it.each([{ uid: 0 }, { uid: 502 }, { gid: 21 }, { admin: true }, { groupsComplete: false }])('refuses changed runtime identity %j', async change => {
    const f = await fixture(true);
    await expect(inspectInstallation({ ...account, ...change } as LocalAccount, f.io)).rejects.toThrow(rejected);
  });
  it('rejects a self-consistent foreign plist instead of trusting a manifest hash alone', async () => {
    const f = await fixture(true); const foreign = renderPlist(f.config, 'core').replace('/bin/node', '/bin/foreign');
    await f.put('core', foreign); f.manifest.plistSha256.core = sha(foreign); await f.putManifest();
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('rejects changed configuration and refuses to use it as a release identity', async () => {
    const f = await fixture(true); await f.put('configuration', JSON.stringify({ ...f.config, releaseId: 'other' }));
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
    expect(f.calls).not.toContain('verifyRelease');
  });
  it('rejects an extra tunnel plist for a core-only installation', async () => {
    const f = await fixture(true); await f.put('tunnel', 'foreign');
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it.each(['PREPARED', 'STOPPED', 'PUBLISHED', 'STARTED'])('refuses an incomplete %s journal', async stage => {
    const f = await fixture(true); await f.put('journal', JSON.stringify({ schemaVersion: 1, stage, installationDigest: 'a'.repeat(64) }));
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('binds a COMMITTED journal to the exact manifest and to the review snapshot', async () => {
    const f = await fixture(true); const without = await inspectInstallation(account, f.io);
    await f.put('journal', JSON.stringify({ schemaVersion: 1, stage: 'COMMITTED', installationDigest: sha(JSON.stringify(f.manifest)) }));
    const withJournal = await inspectInstallation(account, f.io);
    expect(withJournal.digest).not.toBe(without.digest);
    await f.put('journal', JSON.stringify({ schemaVersion: 1, stage: 'COMMITTED', installationDigest: 'd'.repeat(64) }));
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it.each([
    { schemaVersion: 2 }, { state: 'PREPARED' }, { releaseDigest: 'd'.repeat(64) }, { secret: 'not-allowed' },
    { desiredEnabled: { core: true, tunnel: false } }, { runtime: { name: 'root', uid: 0, gid: 0 } },
    { plistSha256: { core: 'a'.repeat(64), tunnel: null, other: 'a'.repeat(64) } },
  ])('rejects altered closed manifest fields %j', async change => {
    const f = await fixture(true); await f.put('manifest', JSON.stringify({ ...f.manifest, ...change }));
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('requires independently revalidated installed release bytes', async () => {
    const f = await fixture(true); f.io.verifyRelease = async () => false;
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it.each([null, { jobs: { core: 'unknown', tunnel: 'absent' }, overrides: { core: true, tunnel: null } }])('refuses unavailable registry evidence %j', async registry => {
    const f = await fixture(true); f.io.registry = async () => registry as RegistryObservation | null;
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('requires explicit stopped overrides and does not accept a live label as OWNED', async () => {
    for (const registry of [
      { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: null, tunnel: null } },
      { jobs: { core: 'present', tunnel: 'absent' }, overrides: { core: true, tunnel: null } },
    ] as RegistryObservation[]) {
      const f = await fixture(true); f.setRegistry(registry);
      await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
    }
  });
  it('rejects changed registry during inspection', async () => {
    const f = await fixture(); let calls = 0;
    f.io.registry = async () => ({ jobs: { core: ++calls === 1 ? 'absent' : 'present', tunnel: 'absent' }, overrides: { core: null, tunnel: null } });
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
    expect(calls).toBe(2);
  });
  it('rejects bytes replaced between inspection and final recheck', async () => {
    const f = await fixture(true); const read = f.io.read; let count = 0;
    f.io.read = async (key, limit) => {
      if (key === 'manifest' && ++count === 2) await f.put('manifest', '{}');
      return read(key, limit);
    };
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
    expect(count).toBe(2);
  });
  it('preserves a fixed safe error instead of raw provider exception text', async () => {
    const f = await fixture(true); f.io.read = async () => { throw new Error('private/path-and-value'); };
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('rejects a directory masquerading as a managed file', async () => {
    const f = await fixture(); await mkdir(join(f.root, names.manifest));
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
  it('bounds managed metadata bytes independently of the reader', async () => {
    const f = await fixture(true); f.io.read = async () => Buffer.alloc(262145, 32);
    await expect(inspectInstallation(account, f.io)).rejects.toThrow(rejected);
  });
});
