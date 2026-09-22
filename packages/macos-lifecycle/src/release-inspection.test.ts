import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectRelease } from './release-inspection.js';
import { parseConfig } from './config.js';
import { createTrustedFiles } from './adapters/trusted-files.js';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
let root: string;
const entries = ['bin/node', 'apps/agent/dist/main.js', 'packages/macos-lifecycle/dist/supervisor-cli.js', 'pnpm-lock.yaml'] as const;
let manifest: { schemaVersion: number; releaseId: string; sourceCommit: string; lockDigest: string;
  files: Array<{ path: string; sha256?: string; executable?: boolean; target?: string }>;
  coreTools: string[]; schemaCompatibility: { minimum: number; maximum: number } };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gram release ')));
  for (const path of entries) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), `fixture:${path}`, { mode: path === 'bin/node' ? 0o700 : 0o600 });
  }
  manifest = { schemaVersion: 1, releaseId: 'lab-001', sourceCommit: 'a'.repeat(40), lockDigest: sha('fixture:pnpm-lock.yaml'),
    files: entries.map(path => ({ path, sha256: sha(`fixture:${path}`), executable: path === 'bin/node' })),
    coreTools: ['agent_health'], schemaCompatibility: { minimum: 1, maximum: 1 } };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const bytes = JSON.stringify(manifest); await writeFile(join(root, 'release.json'), bytes, { mode: 0o600 });
  const digest = sha(bytes);
  const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-001', releaseDigest: digest, tunnel: { enabled: false } });
  return { config, digest, files: createTrustedFiles(root, process.getuid?.() ?? -1, async () => true) };
}
describe('independently anchored sealed release', () => {
  it('verifies exact manifest and actual inventory hashes without running binaries', async () => {
    const f = await fixture(); const before = await readFile(join(root, 'release.json'));
    expect(await inspectRelease(f.config, f.digest, f.files)).toEqual({ verified: true, safePaths: true, digest: f.digest,
      sourceCommit: 'a'.repeat(40), lockDigest: manifest.lockDigest, entries: [...entries].sort() });
    expect(await readFile(join(root, 'release.json'))).toEqual(before);
  });
  it('refuses an unreviewed digest before any file read', async () => {
    const f = await fixture(); let reads = 0;
    const files = { ...f.files, read: async (p: string, n: number) => { reads++; return f.files.read(p, n); } };
    await expect(inspectRelease(f.config, '0'.repeat(64), files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/); expect(reads).toBe(0);
  });
  it('rejects changed manifest bytes', async () => {
    const f = await fixture(); await writeFile(join(root, 'release.json'), JSON.stringify(manifest) + ' ');
    await expect(inspectRelease(f.config, f.digest, f.files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('rejects tampered file data', async () => {
    const f = await fixture(); await writeFile(join(root, entries[1]), 'altered');
    await expect(inspectRelease(f.config, f.digest, f.files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('rejects unlisted sensitive files before opening their data', async () => {
    const f = await fixture(); await writeFile(join(root, 'private.key'), 'synthetic-private', { mode: 0 });
    const reads: string[] = [];
    const files = { ...f.files, hash: async (p: string, n: number) => { reads.push(p); return f.files.hash(p, n); } };
    await expect(inspectRelease(f.config, f.digest, files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/); expect(reads).toEqual([]);
  });
  it.each(['broader tools', 'duplicate path', 'escaping path', 'missing required file', 'wrong lock', 'bad schema range'])('rejects %s in a reviewed but invalid manifest', async kind => {
    const first = manifest.files[0]; if (first === undefined) throw new Error('MISSING_FIXTURE');
    if (kind === 'broader tools') manifest.coreTools.push('shell_exec');
    if (kind === 'duplicate path') manifest.files.push({ ...first });
    if (kind === 'escaping path') first.path = '../outside';
    if (kind === 'missing required file') manifest.files.shift();
    if (kind === 'wrong lock') manifest.lockDigest = '0'.repeat(64);
    if (kind === 'bad schema range') manifest.schemaCompatibility.maximum = 0;
    const f = await fixture(); await expect(inspectRelease(f.config, f.digest, f.files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('rejects executable mode drift', async () => {
    const f = await fixture(); await chmod(join(root, entries[1]), 0o700);
    await expect(inspectRelease(f.config, f.digest, f.files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('accepts an inventoried internal directory link without following it', async () => {
    await mkdir(join(root, 'node_modules'), { mode: 0o700 });
    await symlink('../packages/macos-lifecycle', join(root, 'node_modules/local'));
    manifest.files.push({ path: 'node_modules/local', target: '../packages/macos-lifecycle' });
    const f = await fixture(); expect((await inspectRelease(f.config, f.digest, f.files)).verified).toBe(true);
  });
  it.each(['/etc/passwd', '../../escape', 'loop-b'])('rejects escaping or cyclic link %s', async target => {
    await symlink(target, join(root, 'loop-a')); manifest.files.push({ path: 'loop-a', target });
    if (target === 'loop-b') { await symlink('loop-a', join(root, 'loop-b')); manifest.files.push({ path: 'loop-b', target: 'loop-a' }); }
    const f = await fixture(); await expect(inspectRelease(f.config, f.digest, f.files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
});
