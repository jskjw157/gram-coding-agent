import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTrustedFiles } from './trusted-files.js';

const uid = process.getuid?.() ?? -1;
let root: string;
const extra: string[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gram inventory scope ')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const p of extra.splice(0)) await rm(p, { recursive: true, force: true });
});
const fdCount = async () => (await readdir('/dev/fd')).length;
describe('inventory descriptor scope', () => {
  it('bounds open directory descriptors linearly while traversing a deep release', async () => {
    const depth = 12;
    let path = root;
    for (let n = 0; n < depth; n++) {
      path = join(path, 'd' + n);
      await mkdir(path, { mode: 0o700 });
    }
    await writeFile(join(path, 'payload'), 'fixture', { mode: 0o600 });
    const baseline = await fdCount();
    let peak = baseline;
    const files = createTrustedFiles(root, uid, async () => {
      peak = Math.max(peak, await fdCount());
      return true;
    });
    const inventory = await files.inventory();
    expect(inventory.filter((x) => x.kind === 'directory')).toHaveLength(depth);
    expect(inventory.at(-1)?.kind).toBe('file');
    // One held descriptor per ancestor, plus a small runner/read-dir allowance.
    expect(peak - baseline).toBeLessThanOrEqual(depth + 4);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('stops an aborted walk before dispatching another ACL check and closes held descriptors', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    let calls = 0;
    const baseline = await fdCount();
    const files = createTrustedFiles(root, uid, async () => {
      if (++calls === 2) controller.abort();
      return true;
    });
    await expect(files.inventory(controller.signal)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(calls).toBe(2);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('rejects an ancestor swapped for a symlink while a child directory is reviewed', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true, mode: 0o700 });
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'gram inventory outside ')));
    extra.push(outside);
    await mkdir(join(outside, 'b'), { mode: 0o700 });
    await writeFile(join(outside, 'b', 'unlisted'), 'DO_NOT_READ', { mode: 0o600 });
    const target = await lstat(join(root, 'a', 'b'));
    let changed = false;
    const baseline = await fdCount();
    const files = createTrustedFiles(root, uid, async (handle) => {
      const s = await handle.stat();
      if (s.dev === target.dev && s.ino === target.ino && !changed) {
        changed = true;
        await rename(join(root, 'a'), join(root, 'original'));
        await symlink(outside, join(root, 'a'));
      }
      return true;
    });
    await expect(files.inventory()).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(changed).toBe(true);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('fails closed on an unknown directory ACL without leaking its descriptor stack', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true, mode: 0o700 });
    let calls = 0;
    const baseline = await fdCount();
    const files = createTrustedFiles(root, uid, async () => ++calls !== 3);
    await expect(files.inventory()).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('rejects permission drift in a held prefix ancestor', async () => {
    await mkdir(join(root, 'prefix', 'release', 'child'), { recursive: true, mode: 0o700 });
    const target = await lstat(join(root, 'prefix', 'release', 'child'));
    let changed = false;
    const files = createTrustedFiles(
      root,
      uid,
      async (handle) => {
        const stat = await handle.stat();
        if (stat.ino === target.ino && stat.dev === target.dev) {
          changed = true;
          await chmod(join(root, 'prefix'), 0o777);
        }
        return true;
      },
      'prefix/release',
    );
    await expect(files.inventory()).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(changed).toBe(true);
  });
  it('keeps descriptor ownership independent across concurrent inventories', async () => {
    const depth = 12;
    let path = root;
    for (let n = 0; n < depth; n++) {
      path = join(path, 'd' + n);
      await mkdir(path, { mode: 0o700 });
    }
    const baseline = await fdCount();
    let peak = baseline;
    const files = createTrustedFiles(root, uid, async () => {
      peak = Math.max(peak, await fdCount());
      return true;
    });
    const [first, second] = await Promise.all([files.inventory(), files.inventory()]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(depth);
    expect(peak - baseline).toBeLessThanOrEqual(2 * (depth + 1) + 4);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
});
