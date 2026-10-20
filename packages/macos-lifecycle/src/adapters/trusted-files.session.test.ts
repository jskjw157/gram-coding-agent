import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustedFiles, type AclProbe, type ReleaseFiles } from './trusted-files.js';
const io = vi.hoisted(() => ({ opened: [] as string[], reads: [] as string[],
  afterRead: undefined as undefined | ((path: string) => void) }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, open: async (...args: Parameters<typeof real.open>) => {
    const file = await real.open(...args); const path = String(args[0]); io.opened.push(path);
    const read = file.read.bind(file);
    file.read = (async (...values: Parameters<typeof read>) => {
      const result = await read(...values); io.reads.push(path); io.afterRead?.(path); return result;
    }) as typeof file.read;
    return file;
  } };
});
let root: string;
const uid = process.getuid?.() ?? -1;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fdCount = async () => (await readdir('/dev/fd')).length;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gram prefix session ')));
  await mkdir(join(root, 'prefix/release/sub'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'prefix/release/sub/one'), 'first', { mode: 0o600 });
  await writeFile(join(root, 'prefix/release/sub/two'), 'second', { mode: 0o600 });
  io.opened.length = 0; io.reads.length = 0; io.afterRead = undefined;
});
afterEach(async () => { io.afterRead = undefined; await rm(root, { recursive: true, force: true }); });
function files(acl: AclProbe = async () => true) {
  const port = createTrustedFiles(root, uid, acl, 'prefix/release');
  if (typeof port.withReadSession !== 'function') throw new Error('MISSING_READ_SESSION');
  // Preserve the native receiver identity after checking its optional capability.
  return port as ReleaseFiles & Required<Pick<ReleaseFiles, 'withReadSession'>>;
}

describe('bounded trusted-file prefix read session', () => {
  it('opens the fixed prefix once for a complete hash batch and retains exact hashes', async () => {
    const baseline = await fdCount(); const port = files();
    const result = await port.withReadSession(async scoped => Promise.all([
      scoped.hash('sub/one', 64), scoped.hash('sub/two', 64),
    ]));
    expect(result).toEqual([digest('first'), digest('second')]);
    for (const path of [root, join(root, 'prefix'), join(root, 'prefix/release')]) {
      expect(io.opened.filter(opened => opened === path)).toHaveLength(1);
    }
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
    io.opened.length = 0;
    await port.hash('sub/one', 64); await port.hash('sub/two', 64);
    expect(io.opened.filter(path => path === root)).toHaveLength(2);
  });
  it('checks pinned prefix metadata before every scoped operation', async () => {
    const baseline = await fdCount();
    await expect(files().withReadSession(async scoped => {
      expect(await scoped.hash('sub/one', 64)).toBe(digest('first'));
      await chmod(join(root, 'prefix'), 0o777);
      return scoped.hash('sub/two', 64);
    })).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('checks the prefix after callback completion even if no leaf operation follows drift', async () => {
    await expect(files().withReadSession(async () => {
      await chmod(join(root, 'prefix'), 0o777); return 37;
    })).rejects.toThrow(/^UNSAFE_PATH$/);
  });
  it('rejects unknown leaf ACL evidence and closes the prefix and opened leaf', async () => {
    const baseline = await fdCount();
    await expect(files(async file => !(await file.stat()).isFile()).withReadSession(
      scoped => scoped.read('sub/one', 64),
    )).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it.each(['throw', 'abort'] as const)('closes a partially opened prefix after initial %s', async kind => {
    const baseline = await fdCount(); const controller = new AbortController(); let checks = 0; let callbacks = 0;
    const port = files(async () => {
      if (++checks === 2) { if (kind === 'throw') throw new Error('PRIVATE_DETAIL'); controller.abort(); }
      return true;
    });
    await expect(port.withReadSession(async () => { callbacks++; return 0; }, controller.signal)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(callbacks).toBe(0); expect(checks).toBe(2);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('invalidates an escaped scoped port before new IO after callback return', async () => {
    const port = await files().withReadSession(async scoped => scoped);
    const opened = io.opened.length;
    await expect(port.read('sub/one', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(port.hash('sub/two', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(port.inventory()).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(io.opened).toHaveLength(opened);
  });
  it('aborts a never-settling callback, closes its prefix, and refuses late IO', async () => {
    const baseline = await fdCount(); const controller = new AbortController(); const entered = deferred<ReleaseFiles>();
    const late = deferred<number>();
    const work = files().withReadSession(async scoped => { entered.resolve(scoped); return late.promise; }, controller.signal);
    const scoped = await entered.promise; controller.abort();
    await expect(work).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
    const opened = io.opened.length; late.resolve(37);
    await expect(scoped.hash('sub/one', 64)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(io.opened).toHaveLength(opened);
  });
  it('stops hash chunk dispatch on parent cancellation and closes every held descriptor', async () => {
    await writeFile(join(root, 'prefix/release/sub/payload'), Buffer.alloc(512 * 1024), { mode: 0o600 });
    const baseline = await fdCount(); const controller = new AbortController();
    io.afterRead = path => { if (path.endsWith('/payload')) controller.abort(); };
    await expect(files().withReadSession(scoped => scoped.hash('sub/payload', 1024 * 1024), controller.signal)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(io.reads.filter(path => path.endsWith('/payload'))).toHaveLength(1);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it.each(['success', 'throw'] as const)('refuses callback %s that leaves a started read and waits for its cleanup', async outcome => {
    const baseline = await fdCount(); const entered = deferred<undefined>(); const gate = deferred<boolean>();
    const port = files(async file => { if ((await file.stat()).isFile()) { entered.resolve(undefined); return gate.promise; } return true; });
    let pending!: Promise<string>;
    const work = port.withReadSession(async scoped => {
      pending = scoped.hash('sub/one', 64); void pending.catch(() => undefined);
      await entered.promise; if (outcome === 'throw') throw new Error('PRIVATE_DETAIL'); return 37;
    });
    void work.catch(() => undefined);
    await entered.promise; await new Promise<void>(done => setImmediate(done));
    let returned = false; void work.then(() => { returned = true; }, () => { returned = true; });
    expect(returned).toBe(false); gate.resolve(true);
    await expect(work).rejects.toThrow(/^UNSAFE_PATH$/); await pending.catch(() => undefined);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
  it('owns distinct prefix descriptors across concurrent scopes', async () => {
    const baseline = await fdCount(); const port = files();
    const [first, second] = await Promise.all([
      port.withReadSession(scoped => scoped.hash('sub/one', 64)),
      port.withReadSession(scoped => scoped.hash('sub/two', 64)),
    ]);
    expect([first, second]).toEqual([digest('first'), digest('second')]);
    expect(io.opened.filter(path => path === root)).toHaveLength(2);
    expect(await fdCount()).toBeLessThanOrEqual(baseline + 2);
  });
});
