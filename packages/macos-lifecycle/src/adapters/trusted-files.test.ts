import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustedFiles, type AclProbe } from './trusted-files.js';

let root: string;
const uid = process.getuid?.() ?? -1;
const safe: AclProbe = async () => true;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gram sealed ')));
  await mkdir(join(root, 'sub'), { mode: 0o700 });
  await writeFile(join(root, 'sub/file.txt'), 'approved bytes', { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('descriptor-bound trusted files', () => {
  it('reads and hashes the actual file without changing its bytes, mode or mtime', async () => {
    const before = await lstat(join(root, 'sub/file.txt'));
    const files = createTrustedFiles(root, uid, safe);
    expect((await files.read('sub/file.txt', 64)).toString()).toBe('approved bytes');
    expect(await files.hash('sub/file.txt', 64)).toBe(createHash('sha256').update('approved bytes').digest('hex'));
    const after = await lstat(join(root, 'sub/file.txt'));
    expect([after.ino, after.mode, after.size, after.mtimeMs]).toEqual([before.ino, before.mode, before.size, before.mtimeMs]);
    expect(await readFile(join(root, 'sub/file.txt'), 'utf8')).toBe('approved bytes');
  });
  it.each(['../escape', '/etc/passwd', 'sub/../sub/file.txt', 'sub//file.txt', './sub/file.txt', 'sub\\file.txt', 'sub/file.txt\n', 'sub/\u0000'])('rejects unsafe relative path %j', async path => {
    await expect(createTrustedFiles(root, uid, safe).read(path, 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it.each([0, -1, 1.5, Number.NaN, 300_000_000])('rejects invalid byte limit %s', async limit => {
    await expect(createTrustedFiles(root, uid, safe).read('sub/file.txt', limit)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects oversized bytes and a directory masquerading as a file', async () => {
    const files = createTrustedFiles(root, uid, safe);
    await expect(files.read('sub/file.txt', 2)).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(files.read('sub', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects wrong owner before returning data', async () => {
    await expect(createTrustedFiles(root, uid + 1, safe).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it.each(['sub', 'sub/file.txt'])('rejects writable permissions at %s', async path => {
    await chmod(join(root, path), 0o777);
    await expect(createTrustedFiles(root, uid, safe).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects a hardlinked file', async () => {
    await link(join(root, 'sub/file.txt'), join(root, 'other'));
    await expect(createTrustedFiles(root, uid, safe).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('never follows a leaf or ancestor symlink', async () => {
    await symlink('sub/file.txt', join(root, 'alias'));
    await symlink('sub', join(root, 'dir-alias'));
    const files = createTrustedFiles(root, uid, safe);
    await expect(files.read('alias', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(files.read('dir-alias/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('refuses unknown ACL evidence and contains native errors', async () => {
    await expect(createTrustedFiles(root, uid, async () => false).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(createTrustedFiles(root, uid, async () => { throw new Error('PRIVATE_DETAIL'); }).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('checks ACLs on directories as well as the file', async () => {
    let directories = 0; let files = 0;
    const probe: AclProbe = async handle => { const s = await handle.stat(); if (s.isDirectory()) directories++; else files++; return true; };
    await createTrustedFiles(root, uid, probe).read('sub/file.txt', 64);
    expect(directories).toBeGreaterThanOrEqual(2); expect(files).toBeGreaterThanOrEqual(1);
  });
  it('rejects path replacement while the original file descriptor is open', async () => {
    let changed = false;
    const probe: AclProbe = async handle => {
      if ((await handle.stat()).isFile() && !changed) {
        changed = true; await rename(join(root, 'sub/file.txt'), join(root, 'sub/old.txt'));
        await writeFile(join(root, 'sub/file.txt'), 'other bytes', { mode: 0o600 });
      }
      return true;
    };
    await expect(createTrustedFiles(root, uid, probe).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(changed).toBe(true);
  });
  it('rejects truncation observed through the opened descriptor', async () => {
    const probe: AclProbe = async handle => { if ((await handle.stat()).isFile()) await writeFile(join(root, 'sub/file.txt'), 'x'); return true; };
    await expect(createTrustedFiles(root, uid, probe).read('sub/file.txt', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('enumerates links without opening or following their content', async () => {
    await symlink('/definitely/not/a/real/secret', join(root, 'external'));
    const inventory = await createTrustedFiles(root, uid, safe).inventory();
    expect(inventory).toEqual([
      { path: 'external', kind: 'link', target: '/definitely/not/a/real/secret' },
      { path: 'sub', kind: 'directory' },
      { path: 'sub/file.txt', kind: 'file', executable: false },
    ]);
  });
});
