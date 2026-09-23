import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { probeTrustedPath } from './trusted-presence.js';
import type { AclProbe } from './trusted-files.js';
const roots: string[] = [];
const uid = process.getuid?.() ?? 0;
const acl: AclProbe = async () => true; // POSIX tests; native ACL has a separate real helper suite.
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gram presence ')); roots.push(root);
  await chmod(root, 0o700); await mkdir(join(root, 'config'), { mode: 0o700 });
  await writeFile(join(root, 'config', 'existing.json'), 'inert fixture data', { mode: 0o600 });
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('descriptor-bound existence versus unsafe absence', () => {
  it('reports missing targets without creating parents or altering existing data', async () => {
    const root = await fixture();
    const before = await readdir(root); const content = await readFile(join(root, 'config/existing.json'));
    expect(await probeTrustedPath(root, uid, acl, 'config/new.json')).toBe('absent');
    expect(await probeTrustedPath(root, uid, acl, 'missing/child.json')).toBe('absent');
    expect(await readdir(root)).toEqual(before);
    expect(await readdir(join(root, 'config'))).toEqual(['existing.json']);
    expect(await readFile(join(root, 'config/existing.json'))).toEqual(content);
  });
  it('distinguishes existing regular files and directories', async () => {
    const root = await fixture();
    expect(await probeTrustedPath(root, uid, acl, 'config')).toBe('directory');
    expect(await probeTrustedPath(root, uid, acl, 'config/existing.json')).toBe('file');
  });
  it('validates every existing ancestor before reporting absence', async () => {
    const root = await fixture(); const seen: boolean[] = [];
    expect(await probeTrustedPath(root, uid, async file => { seen.push((await file.stat()).isDirectory()); return true; }, 'config/missing')).toBe('absent');
    expect(seen).toEqual([true, true]);
    await chmod(join(root, 'config'), 0o777);
    await expect(probeTrustedPath(root, uid, acl, 'config/missing')).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it.each(['', '..', '../outside', '/etc/passwd', 'config//missing', 'config/../missing', 'config\\missing', 'config/\u0000'])('rejects unsafe relative syntax %j', async path => {
    const root = await fixture(); await expect(probeTrustedPath(root, uid, acl, path)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('does not equate a non-directory parent or missing anchor with absence', async () => {
    const root = await fixture();
    await expect(probeTrustedPath(root, uid, acl, 'config/existing.json/child')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(probeTrustedPath(join(root, 'untrusted-anchor'), uid, acl, 'child')).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects ancestor, leaf and dangling symlinks without following them', async () => {
    const root = await fixture();
    await symlink(join(root, 'config'), join(root, 'alias'));
    await symlink(join(root, 'config/existing.json'), join(root, 'file-link'));
    await symlink(join(root, 'missing'), join(root, 'dangling'));
    for (const path of ['alias/child', 'file-link', 'dangling', 'dangling/child']) {
      await expect(probeTrustedPath(root, uid, acl, path)).rejects.toThrow(/^UNSAFE_PATH$/);
    }
  });
  it('rejects hardlinks, incorrect owners and unavailable ACL evidence', async () => {
    const root = await fixture(); await link(join(root, 'config/existing.json'), join(root, 'alias'));
    await expect(probeTrustedPath(root, uid, acl, 'alias')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(probeTrustedPath(root, uid + 1, acl, 'missing')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(probeTrustedPath(root, uid, async () => false, 'missing')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(probeTrustedPath(root, uid, async () => { throw new Error('synthetic private value'); }, 'missing'))
      .rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects replacement during descriptor validation', async () => {
    const root = await fixture(); let replaced = false;
    await expect(probeTrustedPath(root, uid, async file => {
      if ((await file.stat()).isFile() && !replaced) {
        replaced = true; await rename(join(root, 'config/existing.json'), join(root, 'old'));
        await writeFile(join(root, 'config/existing.json'), 'different', { mode: 0o600 });
      }
      return true;
    }, 'config/existing.json')).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(replaced).toBe(true);
  });
});
