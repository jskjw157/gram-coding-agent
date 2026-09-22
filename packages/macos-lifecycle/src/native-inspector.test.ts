import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { renderPlist } from './launchd-plist.js';
import { preview } from './preflight.js';
import { createTrustedFiles } from './adapters/trusted-files.js';
import { probeTrustedPath } from './adapters/trusted-presence.js';
import { composeInspector, createMacInspector, installPaths, type NativeInspectionPorts } from './adapters/native-inspector.js';
import type { LocalAccount } from './adapters/macos-inspection.js';
import type { InstallFile } from './installation-inspection.js';
import type { RegistryObservation } from './adapters/macos-service-probes.js';

const roots: string[] = [];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const entries = ['bin/node', 'apps/agent/dist/main.js', 'packages/macos-lifecycle/dist/supervisor-cli.js', 'pnpm-lock.yaml'];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Snapshot every fixture path, byte hash and mutation-sensitive metadata, never
// atime. Inaccessible canary content is intentionally not read by the snapshot.
async function treeSnapshot(root: string): Promise<string> {
  const rows: unknown[] = [];
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative); const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('UNEXPECTED_FIXTURE_TYPE');
    const metadata = [relative, stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink,
      stat.isFile() ? stat.size : 0n, stat.mtimeNs, stat.ctimeNs].map(String);
    const content = stat.isFile() ? ((stat.mode & 0o444n) === 0n ? 'UNREADABLE_CANARY' : sha(await readFile(path))) : null;
    rows.push([metadata, content]);
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
  }
  await visit(''); return sha(JSON.stringify(rows));
}
async function fixture(installed = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mac02-composed-preview-'))); roots.push(root);
  const releaseRoot = join(root, 'release'); const systemRoot = join(root, 'system');
  await mkdir(systemRoot); const uid = process.getuid?.() ?? 0;
  await mkdir(join(systemRoot, 'secrets'), { mode: 0o700 });
  await writeFile(join(systemRoot, 'secrets/DO_NOT_READ'), 'inert fixture canary', { mode: 0o000 });
  for (const path of entries) {
    await mkdir(dirname(join(releaseRoot, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(releaseRoot, path), `inert:${path}`, { mode: path.startsWith('bin/') ? 0o700 : 0o600 });
  }
  const release = { schemaVersion: 1, releaseId: 'lab-001', sourceCommit: 'a'.repeat(40),
    lockDigest: sha('inert:pnpm-lock.yaml'), files: entries.map(path => ({ path, sha256: sha(`inert:${path}`), executable: path.startsWith('bin/') })),
    coreTools: ['agent_health'], schemaCompatibility: { minimum: 1, maximum: 1 } };
  const digest = sha(JSON.stringify(release)); await writeFile(join(releaseRoot, 'release.json'), JSON.stringify(release), { mode: 0o600 });
  const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-001', releaseDigest: digest, tunnel: { enabled: false } });
  const account: LocalAccount = { name: 'gram-agent', uid: 501, gid: 20, admin: false, groupsComplete: true };
  let registry: RegistryObservation = { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: null, tunnel: null } };
  const reads: string[] = [];
  const releaseFiles = createTrustedFiles(releaseRoot, uid, async () => true);
  const systemFiles = createTrustedFiles(systemRoot, uid, async () => true);
  const put = async (key: InstallFile, value: string) => {
    const path = join(systemRoot, installPaths[key]); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode: 0o600 });
  };
  const configuration = JSON.stringify(config); const plist = renderPlist(config, 'core');
  if (installed) {
    await put('configuration', configuration); await put('core', plist);
    await put('manifest', JSON.stringify({ schemaVersion: 1, state: 'COMMITTED', runtime: { name: 'gram-agent', uid: 501, gid: 20 },
      configSha256: sha(configuration), releaseId: config.releaseId, releaseDigest: digest, plistSha256: { core: sha(plist), tunnel: null }, desiredEnabled: { core: false, tunnel: false } }));
    registry = { jobs: { core: 'absent', tunnel: 'absent' }, overrides: { core: true, tunnel: null } };
  }
  const ports: NativeInspectionPorts = {
    async host() { return { platform: 'darwin', arch: 'arm64', nodeVersion: '24.0.0' }; },
    async account() { reads.push('account'); return structuredClone(account); },
    releaseFiles(candidate) { expect(candidate).toEqual(config); return {
      ...releaseFiles, async read(path, limit) { reads.push(`release:${path}`); return releaseFiles.read(path, limit); },
      async hash(path, limit) { reads.push(`hash:${path}`); return releaseFiles.hash(path, limit); },
    }; },
    async presence(key) { reads.push(`presence:${key}`); return probeTrustedPath(systemRoot, uid, async () => true, installPaths[key]); },
    async read(key, limit) { reads.push(`install:${key}`); return systemFiles.read(installPaths[key], limit); },
    async registry() { reads.push('registry'); return structuredClone(registry); },
    async ports() { return { core: 'free', tunnel: 'free' }; },
    async plistValidity(xml) { return xml.length === 1 && xml[0] === renderPlist(config, 'core'); },
  };
  return { root, releaseRoot, systemRoot, config, digest, account, ports, reads, put };
}
it.each([false, true])('runs the full six-port preview over actual bytes with installed=%s', async installed => {
  const f = await fixture(installed);
  const before = await treeSnapshot(f.root);
  if (process.getuid?.() !== 0) await expect(readFile(join(f.systemRoot, 'secrets/DO_NOT_READ'))).rejects.toMatchObject({ code: 'EACCES' });
  const result = await preview(f.config, f.digest, composeInspector(f.ports));
  expect(result).toMatchObject({ ok: true, code: 'OK', roles: ['core'], releaseDigest: f.digest });
  expect(result.configDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(installed ? typeof result.previousInstallDigest === 'string' : result.previousInstallDigest === null).toBe(true);
  expect(f.reads).toContain('hash:bin/node'); expect(f.reads).toContain('presence:manifest');
  expect(f.reads.some(path => /secret|credential|browser/u.test(path))).toBe(false);
  expect(await treeSnapshot(f.root)).toBe(before);
});
it('does not manufacture trusted release evidence for tampered real bytes', async () => {
  const f = await fixture(); await writeFile(join(f.releaseRoot, 'apps/agent/dist/main.js'), 'tampered');
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false, code: 'UNTRUSTED_RELEASE' });
  expect(f.reads).not.toContain('presence:manifest');
});
it('rejects an orphaned real plist and never approves the requested new release over it', async () => {
  const f = await fixture(); await f.put('core', 'foreign');
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false, code: 'FOREIGN_SERVICE' });
});
it('leaves occupied ports unowned and refuses without a connection', async () => {
  const f = await fixture(true); f.ports.ports = async () => ({ core: 'occupied', tunnel: 'free' });
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false, code: 'PORT_IN_USE' });
});
it('rechecks installation after final XML validation instead of accepting changed bytes', async () => {
  const f = await fixture(true);
  f.ports.plistValidity = async () => { await f.put('core', 'changed-during-preview'); return true; };
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false });
});
it('rechecks account identity before completing a preview', async () => {
  const f = await fixture(); let calls = 0;
  f.ports.account = async () => ({ ...f.account, uid: ++calls === 1 ? 501 : 502 });
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false });
  expect(calls).toBeGreaterThan(1);
});
it('keeps one-shot inspection contexts from being reused as authorization', async () => {
  const f = await fixture(); const inspector = composeInspector(f.ports);
  expect((await preview(f.config, f.digest, inspector)).ok).toBe(true);
  expect((await preview(f.config, f.digest, inspector)).ok).toBe(false);
});
it('has fixed immutable paths without a runtime state or secret path input', () => {
  expect(Object.isFrozen(installPaths)).toBe(true);
  expect(Object.keys(installPaths).sort()).toEqual(['configuration', 'core', 'journal', 'manifest', 'tunnel']);
  expect(installPaths.core).toBe('Library/LaunchDaemons/com.haar.gram-agent.core.plist');
  expect(installPaths.configuration).toBe('Library/Application Support/HAAR/GramAgent/config/service.json');
});
it('constructs only read-only production ports; missing ACL trust is never replaced by approval', async () => {
  const inspector = createMacInspector();
  expect(Object.keys(inspector).sort()).toEqual(['account', 'host', 'installation', 'plistValidity', 'ports', 'release']);
  expect(await inspector.host()).toEqual({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node });
  // Without the required sequence/trust, never start inspecting a release.
  await expect(inspector.release({} as never, 'a'.repeat(64))).rejects.toThrow();
});

it('rechecks actual requested release bytes after the final validation step', async () => {
  const f = await fixture();
  f.ports.plistValidity = async () => { await writeFile(join(f.releaseRoot, 'apps/agent/dist/main.js'), 'late-change'); return true; };
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false });
});
it('refuses a port that becomes occupied during final revalidation', async () => {
  const f = await fixture(); let observations = 0;
  f.ports.ports = async () => ({ core: ++observations === 1 ? 'free' : 'occupied', tunnel: 'free' });
  expect(await preview(f.config, f.digest, composeInspector(f.ports))).toMatchObject({ ok: false });
  expect(observations).toBe(2);
});
