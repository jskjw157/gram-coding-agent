import { chmod, link, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configDigest } from '../config.js';
import { bindReviewedCoreRuntime, bindReviewedCoreRuntimeAt, type RuntimeReview } from './runtime-authority.js';
import { fixture, hash, snapshot } from '../test-support/runtime/fixture.js';
const roots: string[] = [];
async function setup() { const f = await fixture(); roots.push(f.anchor); return f; }
const signal = () => new AbortController().signal;
async function bind(f: Awaited<ReturnType<typeof setup>>) {
  return bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal());
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('reviewed runtime binding over actual files (synthetic host/account/bootstrap ACL)', () => {
  it('has no permissive default without independent review and bootstrap trust', async () => {
    expect(await bindReviewedCoreRuntime()).toBeNull();
    const f = await setup(); expect(await bindReviewedCoreRuntime(f.review)).toBeNull();
  });
  it('binds actual execution files without mutation, initialization or secret reads', async () => {
    const f = await setup(); const before = await snapshot(f.base); const value = await bind(f);
    expect(value).not.toBeNull(); expect(await snapshot(f.base)).toEqual(before);
    expect(await stat(join(f.base, 'secrets/do-not-read'))).toMatchObject({ mode: expect.any(Number) });
    expect(await value?.execution.read('core')).toMatchObject({ state: 'FREE', revision: 0 });
  });
  it('requires a matching HELD reservation before producing a native launch grant', async () => {
    const f = await setup(); const value = await bind(f); if (!value) throw new Error('binding');
    expect(await value.authority.acquire(f.review.config, signal())).toBeNull();
    const lease = await value.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest);
    const grant = await value.authority.acquire(f.review.config, signal());
    const node = await stat(join(f.release, 'bin/node'), { bigint: true });
    expect(grant).toMatchObject({ configDigest: f.review.configDigest, executable: { dev: node.dev, ino: node.ino } });
    expect(typeof grant?.proof.current).toBe('function'); await value.execution.release(lease);
  });
  it('independent bindings use the same run directory and cannot both reserve Core', async () => {
    const f = await setup(); const a = await bind(f); const b = await bind(f); if (!a || !b) throw new Error('binding');
    const lease = await a.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest);
    await expect(b.execution.acquire('core', 'g2', f.review.configDigest, f.review.config.releaseDigest)).rejects.toThrow('BUSY');
    await a.execution.release(lease);
  });
  it.each(['nodeDigest', 'fileAclDigest', 'peerOwnerDigest'] as const)('refuses an independently pinned %s mismatch', async key => {
    const f = await setup(); f.review[key] = 'a'.repeat(64); expect(await bind(f)).toBeNull();
  });
  it('does not let a rewritten candidate manifest supply its own new helper trust', async () => {
    const f = await setup(); const path = join(f.release, 'bin/peer-owner'); await writeFile(path, 'changed-helper');
    const manifestPath = join(f.release, 'release.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: { path: string; sha256: string }[] };
    const entry = manifest.files.find(item => item.path === 'bin/peer-owner'); if (!entry) throw new Error('entry');
    entry.sha256 = hash('changed-helper'); const bytes = JSON.stringify(manifest) + '\n'; await writeFile(manifestPath, bytes);
    f.review.config.releaseDigest = hash(bytes); f.review.configDigest = configDigest(f.review.config);
    await writeFile(join(f.base, 'config/service.json'), JSON.stringify(f.review.config) + '\n');
    expect(await bind(f)).toBeNull();
  });
  it.each(['run', 'state', 'secrets', 'logs'])('requires existing private %s without creating it', async name => {
    const f = await setup(); await rm(join(f.base, name), { recursive: true });
    expect(await bind(f)).toBeNull(); await expect(stat(join(f.base, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['run', 'state', 'secrets', 'logs'])('refuses group-readable %s', async name => {
    const f = await setup(); await chmod(join(f.base, name), 0o750); expect(await bind(f)).toBeNull();
  });
  it('refuses a symlinked runtime directory', async () => {
    const f = await setup(); await rename(join(f.base, 'logs'), join(f.base, 'logs-real'));
    await symlink(join(f.base, 'logs-real'), join(f.base, 'logs')); expect(await bind(f)).toBeNull();
  });
  it('refuses executable hardlinks and writable release ancestors', async () => {
    const f = await setup(); await link(join(f.release, 'bin/node'), join(f.anchor, 'extra-link')); expect(await bind(f)).toBeNull();
    await unlink(join(f.anchor, 'extra-link')); await chmod(join(f.release, 'bin'), 0o777); expect(await bind(f)).toBeNull();
  });
  it('does not reset missing or corrupt execution records', async () => {
    const f = await setup(); const path = join(f.base, 'run/core.execution.json'); await unlink(path);
    expect(await bind(f)).toBeNull(); await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, 'broken-record', { mode: 0o600 }); expect(await bind(f)).toBeNull();
    expect(await readFile(path, 'utf8')).toBe('broken-record');
  });
  it.each(['admin', 'uid', 'gid', 'groups'] as const)('refuses invalid account/process %s', async kind => {
    const f = await setup(); const a = await f.environment.account(); if (!a) throw new Error('account');
    if (kind === 'admin') f.environment.account = async () => ({ ...a, admin: true });
    if (kind === 'uid') f.environment.identity = () => ({ uid: f.uid + 1, gid: f.gid, groups: [f.gid] });
    if (kind === 'gid') f.environment.identity = () => ({ uid: f.uid, gid: f.gid + 1, groups: [f.gid + 1] });
    if (kind === 'groups') f.environment.identity = () => ({ uid: f.uid, gid: f.gid, groups: [f.gid, 80] });
    expect(await bind(f)).toBeNull();
  });
  it.each(['linux', 'x64', '22.0.0'])('refuses unsupported runtime %s', async kind => {
    const f = await setup(); const host = f.environment.host();
    f.environment.host = () => ({ ...host, ...(kind === 'linux' ? { platform: kind } : kind === 'x64' ? { arch: kind } : { nodeVersion: kind }) });
    expect(await bind(f)).toBeNull();
  });
  it('does not accept truthy ACL responses or expose thrown diagnostics', async () => {
    const f = await setup(); f.acl = async () => 'safe' as unknown as boolean; expect(await bind(f)).toBeNull();
    f.acl = async () => { throw new Error('SYNTHETIC_PRIVATE_PATH_TOKEN'); }; expect(await bind(f)).toBeNull();
  });
  it('rejects mutable/accessor review inputs before inspecting files', async () => {
    const f = await setup(); let called = 0; Object.defineProperty(f.review, 'nodeDigest', { enumerable: true, get() { called++; return 'a'.repeat(64); } });
    expect(await bind(f)).toBeNull(); expect(called).toBe(0);
  });
  it('copies the review and layout before the first asynchronous boundary', async () => {
    const f = await setup(); const original = structuredClone(f.review); const originalAccount = f.environment.account;
    f.environment.account = async () => { f.review.nodeDigest = 'b'.repeat(64); f.review.config.releaseDigest = 'b'.repeat(64);
      f.layout.relative = 'other'; return originalAccount(); };
    const value = await bind(f); expect(value).not.toBeNull();
    const lease = await value?.execution.acquire('core', 'g1', original.configDigest, original.config.releaseDigest);
    expect(await value?.authority.acquire(original.config, signal())).not.toBeNull();
    if (lease) await value?.execution.release(lease);
  });
  it('rechecks stored configuration and helper pins for each launch grant', async () => {
    const f = await setup(); const value = await bind(f); if (!value) throw new Error('binding');
    await value.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest);
    await writeFile(join(f.release, 'bin/file-acl'), 'changed');
    expect(await value.authority.acquire(f.review.config, signal())).toBeNull();
  });
  it('refuses a different requested config and an unrelated held configuration', async () => {
    const f = await setup(); const value = await bind(f); if (!value) throw new Error('binding');
    await value.execution.acquire('core', 'g1', 'b'.repeat(64), f.review.config.releaseDigest);
    expect(await value.authority.acquire(f.review.config, signal())).toBeNull();
    expect(await value.authority.acquire({ ...f.review.config, releaseId: 'other' }, signal())).toBeNull();
  });
  it('pins run-directory identity across later store operations', async () => {
    const f = await setup(); const value = await bind(f); if (!value) throw new Error('binding');
    await rename(join(f.base, 'run'), join(f.base, 'run-old'));
    const replacement = await setup(); await rename(join(replacement.base, 'run'), join(f.base, 'run'));
    await expect(value.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest)).rejects.toThrow();
    expect(await readFile(join(f.base, 'run/core.execution.json'), 'utf8')).toContain('"state":"FREE"');
  });
  it('leaves an existing HELD reservation unchanged during binding', async () => {
    const f = await setup(); await f.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest);
    const before = await snapshot(f.base); const value = await bind(f); expect(value).not.toBeNull();
    expect(await snapshot(f.base)).toEqual(before); expect(await value?.execution.read('core')).toMatchObject({ state: 'HELD', revision: 1 });
  });
  it('returns null for cancellation without creating records', async () => {
    const f = await setup(); const before = await snapshot(f.base); const controller = new AbortController(); controller.abort('private');
    expect(await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, controller.signal)).toBeNull();
    expect(await snapshot(f.base)).toEqual(before);
  });
  it('does not call candidate helper programs merely to bind or inspect the grant', async () => {
    const f = await setup(); const before = await snapshot(f.base); const value = await bind(f); expect(value).not.toBeNull();
    expect(await snapshot(f.base)).toEqual(before); // fixture helper bytes are not executable programs
  });
});
