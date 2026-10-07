import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { inspectRelease } from './release-inspection.js';
import { parseConfig } from './config.js';
import { createTrustedFiles, type ReleaseFiles } from './adapters/trusted-files.js';

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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixtureItem<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('MISSING_FIXTURE_ITEM');
  return value;
}
function gatedHashes(files: ReleaseFiles, failure?: 'error' | 'mismatch') {
  const gates = entries.map(() => deferred()); const ready = entries.map(() => deferred());
  const finished = entries.map(() => deferred()); const started: string[] = [];
  let active = 0; let maximum = 0;
  return { gates, ready, finished, started, maximum: () => maximum, active: () => active,
    releaseAll: () => { for (const gate of gates) gate.resolve(); },
    hash: async (path: string, limit: number) => {
      const index = entries.findIndex(entry => entry === path);
      if (index < 0) throw new Error('UNEXPECTED_FIXTURE_HASH');
      started.push(path); maximum = Math.max(maximum, ++active);
      try {
        const value = await files.hash(path, limit);
        fixtureItem(ready[index]).resolve(); await fixtureItem(gates[index]).promise;
        if (index === 0 && failure === 'error') throw new Error('FIXTURE_HASH_FAILURE');
        return index === 0 && failure === 'mismatch' ? '0'.repeat(64) : value;
      } finally { active--; fixtureItem(finished[index]).resolve(); }
    } };
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
  it('hashes at most two files concurrently after inventory and rechecks only after all hashes finish', async () => {
    const f = await fixture(); const hashes = gatedHashes(f.files); const inventoryGate = deferred();
    const inventoryReady = deferred(); let inventories = 0; let reads = 0;
    const files = { ...f.files, hash: hashes.hash,
      read: async (path: string, limit: number) => { reads++; return f.files.read(path, limit); },
      inventory: async () => {
        inventories++;
        if (inventories === 1) { inventoryReady.resolve(); await inventoryGate.promise; }
        else expect(hashes.active()).toBe(0);
        return f.files.inventory();
      } };
    const result = inspectRelease(f.config, f.digest, files);
    try {
      await inventoryReady.promise; expect([...hashes.started]).toEqual([]); inventoryGate.resolve();
      await fixtureItem(hashes.ready[0]).promise; await tick();
      expect([...hashes.started]).toEqual(entries.slice(0, 2));
      expect(inventories).toBe(1); expect(reads).toBe(1);
      fixtureItem(hashes.gates[0]).resolve(); await fixtureItem(hashes.ready[2]).promise;
      expect([...hashes.started]).toEqual(entries.slice(0, 3)); expect(hashes.maximum()).toBe(2);
      fixtureItem(hashes.gates[1]).resolve(); await fixtureItem(hashes.ready[3]).promise;
      expect(inventories).toBe(1); expect(reads).toBe(1);
      hashes.releaseAll(); expect((await result).verified).toBe(true);
      expect(hashes.maximum()).toBe(2); expect(inventories).toBe(2); expect(reads).toBe(2);
    } finally { inventoryGate.resolve(); hashes.releaseAll(); await result.catch(() => undefined); }
  });
  it.each(['error', 'mismatch', 'cancel'] as const)('stops hash dispatch and drains in-flight work on %s', async kind => {
    const f = await fixture(); const hashes = gatedHashes(f.files, kind === 'cancel' ? undefined : kind);
    const controller = new AbortController(); let settled = false; let inventories = 0; let reads = 0;
    const files = { ...f.files, hash: hashes.hash,
      read: async (path: string, limit: number) => { reads++; return f.files.read(path, limit); },
      inventory: async () => { inventories++; return f.files.inventory(); } };
    const outcome = inspectRelease(f.config, f.digest, files, controller.signal).then(
      () => { settled = true; return undefined; }, error => { settled = true; return error as Error; });
    try {
      await fixtureItem(hashes.ready[0]).promise; await tick(); expect([...hashes.started]).toEqual(entries.slice(0, 2));
      await fixtureItem(hashes.ready[1]).promise;
      if (kind === 'cancel') controller.abort();
      fixtureItem(hashes.gates[0]).resolve(); await fixtureItem(hashes.finished[0]).promise; await tick();
      expect(settled).toBe(false); expect(hashes.active()).toBe(1);
      expect([...hashes.started]).toEqual(entries.slice(0, 2)); expect(inventories).toBe(1); expect(reads).toBe(1);
      fixtureItem(hashes.gates[1]).resolve(); expect(await outcome).toEqual(new Error('UNTRUSTED_RELEASE'));
      expect(hashes.active()).toBe(0); expect([...hashes.started]).toEqual(entries.slice(0, 2));
      expect(inventories).toBe(1); expect(reads).toBe(1);
    } finally { hashes.releaseAll(); await outcome; }
  });
  it('refuses pre-cancelled review before opening files', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(); let reads = 0;
    const files = { ...f.files, read: async (path: string, limit: number) => { reads++; return f.files.read(path, limit); } };
    await expect(inspectRelease(f.config, f.digest, files, controller.signal)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
    expect(reads).toBe(0);
  });
  it.each(['initial read', 'initial inventory', 'final inventory', 'final read'])('refuses cancellation after %s before further I/O or evidence', async boundary => {
    const f = await fixture(); const controller = new AbortController(); let reads = 0; let inventories = 0; let hashes = 0;
    const files = { ...f.files,
      read: async (path: string, limit: number) => {
        const bytes = await f.files.read(path, limit); reads++;
        if (boundary === (reads === 1 ? 'initial read' : 'final read')) controller.abort();
        return bytes;
      },
      inventory: async () => {
        const found = await f.files.inventory(); inventories++;
        if (boundary === (inventories === 1 ? 'initial inventory' : 'final inventory')) controller.abort();
        return found;
      },
      hash: async (path: string, limit: number) => { hashes++; return f.files.hash(path, limit); } };
    await expect(inspectRelease(f.config, f.digest, files, controller.signal)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
    expect({ reads, inventories, hashes }).toEqual(boundary === 'initial read' ? { reads: 1, inventories: 0, hashes: 0 }
      : boundary === 'initial inventory' ? { reads: 1, inventories: 1, hashes: 0 }
        : { reads: boundary === 'final read' ? 2 : 1, inventories: 2, hashes: 4 });
  });
  it.each(['inventory', 'manifest'])('rejects %s drift at the final recheck', async kind => {
    const f = await fixture(); let inventories = 0; let hashes = 0;
    const files = { ...f.files,
      hash: async (path: string, limit: number) => { const value = await f.files.hash(path, limit); hashes++; return value; },
      inventory: async () => {
        if (++inventories === 2) {
          expect(hashes).toBe(entries.length);
          if (kind === 'inventory') await writeFile(join(root, 'extra'), 'unlisted', { mode: 0o600 });
          else await writeFile(join(root, 'release.json'), JSON.stringify(manifest) + ' ');
        }
        return f.files.inventory();
      } };
    await expect(inspectRelease(f.config, f.digest, files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
    expect(inventories).toBe(2);
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
    const f = await fixture(); let hashes = 0;
    const files = { ...f.files, hash: async (path: string, limit: number) => { hashes++; return f.files.hash(path, limit); } };
    await expect(inspectRelease(f.config, f.digest, files)).rejects.toThrow(/^UNTRUSTED_RELEASE$/); expect(hashes).toBe(0);
  });
});
