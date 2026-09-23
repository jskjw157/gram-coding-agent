import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCircuitFilesAt, type CircuitFileIo, type StateDirectoryPolicy } from './service-files.js';
import { encodeHistory, LifecycleStore } from '../lifecycle-store.js';
import { freshHistory } from '../circuit.js';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const unsafe = /^UNSAFE_PATH$/;
let anchor: string;
let directory: string;
let policy: StateDirectoryPolicy;
beforeEach(async () => {
  anchor = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'gram circuit ')));
  directory = join(anchor, 'run'); await fs.mkdir(directory, { mode: 0o700 });
  policy = { anchor, relative: 'run', ancestorUid: process.getuid?.() ?? -1,
    stateUid: process.getuid?.() ?? -1, acl: async () => true };
});
afterEach(async () => { await fs.rm(anchor, { recursive: true, force: true }); });
const target = () => join(directory, 'core.circuit.json');
const port = () => createCircuitFilesAt(policy);
const body = (now = 0) => encodeHistory(freshHistory(now));

describe('real private-directory circuit files', () => {
  it('reads absence without creating state or parents', async () => {
    expect(await port().read('core')).toBeNull(); expect(await fs.readdir(directory)).toEqual([]);
    await fs.rmdir(directory);
    await expect(port().read('core')).rejects.toThrow(unsafe);
    expect(await fs.readdir(anchor)).toEqual([]);
  });
  it('writes complete canonical 0600 files and replaces with no leftovers', async () => {
    const p = port(); await p.compareAndSwap('core', null, body());
    expect(await fs.readFile(target())).toEqual(body());
    expect((await fs.stat(target())).mode & 0o7777).toBe(0o600);
    await p.compareAndSwap('core', sha(body()), body(1));
    expect(await p.read('core')).toEqual(body(1));
    expect(await fs.readdir(directory)).toEqual(['core.circuit.json']);
  });
  it('persists an interrupted attempt across actual file-backed store instances', async () => {
    const first = new LifecycleStore(port()); const h = await first.initializeNew('core', 1);
    await first.write('core', h, { kind: 'begin', generation: 'g1', nowMs: 2 });
    const second = new LifecycleStore(port());
    const recovered = await second.write('core', await second.read('core'), { kind: 'recover', nowMs: 3 });
    expect(recovered.history.exitsMs).toEqual([3]);
    const third = new LifecycleStore(port());
    expect((await third.write('core', await third.read('core'), { kind: 'recover', nowMs: 4 })).history.exitsMs).toEqual([3]);
  });
  it('refuses stale or create-only replacement without changing old bytes', async () => {
    const p = port(); await p.compareAndSwap('core', null, body());
    await expect(p.compareAndSwap('core', null, body(1))).rejects.toThrow(/^STATE_CONFLICT$/);
    await expect(p.compareAndSwap('core', 'f'.repeat(64), body(1))).rejects.toThrow(/^STATE_CONFLICT$/);
    expect(await p.read('core')).toEqual(body());
  });
  it('allows at most one concurrent writer against one snapshot', async () => {
    const p = port(); await p.compareAndSwap('core', null, body());
    const results = await Promise.allSettled([p.compareAndSwap('core', sha(body()), body(1)),
      createCircuitFilesAt(policy).compareAndSwap('core', sha(body()), body(2))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const stored = await p.read('core'); expect(stored?.equals(body(1)) || stored?.equals(body(2))).toBe(true);
    expect(await fs.readdir(directory)).toEqual(['core.circuit.json']);
  });
  it('does not delete or steal an existing writer lock', async () => {
    const lock = join(directory, 'core.circuit.lock'); await fs.writeFile(lock, 'existing-owner', { mode: 0o600 });
    await expect(port().compareAndSwap('core', null, body())).rejects.toThrow(/^BUSY$/);
    expect(await fs.readFile(lock, 'utf8')).toBe('existing-owner');
    expect(await fs.readdir(directory)).toEqual(['core.circuit.lock']);
  });
  it('keeps tunnel and core histories in distinct fixed files', async () => {
    const p = port(); await p.compareAndSwap('core', null, body(1)); await p.compareAndSwap('tunnel', null, body(2));
    expect(await p.read('core')).toEqual(body(1)); expect(await p.read('tunnel')).toEqual(body(2));
  });
  it.each(['symlink', 'hardlink', 'directory', 'public', 'executable'])('refuses a %s state object without truncating it', async kind => {
    const original = join(anchor, 'original'); await fs.writeFile(original, body(), { mode: 0o600 });
    if (kind === 'symlink') await fs.symlink(original, target());
    if (kind === 'hardlink') await fs.link(original, target());
    if (kind === 'directory') await fs.mkdir(target(), { mode: 0o700 });
    if (kind === 'public' || kind === 'executable') await fs.writeFile(target(), body(), { mode: kind === 'public' ? 0o644 : 0o700 });
    await expect(port().read('core')).rejects.toThrow(unsafe);
    await expect(port().compareAndSwap('core', sha(body()), body(1))).rejects.toThrow(unsafe);
    expect(await fs.readFile(original)).toEqual(body());
  });
  it.each(['ancestor mode', 'leaf mode', 'ancestor link', 'owner', 'ACL'])('refuses %s trust failure', async kind => {
    if (kind === 'ancestor mode') await fs.chmod(anchor, 0o777);
    if (kind === 'leaf mode') await fs.chmod(directory, 0o755);
    if (kind === 'ancestor link') { await fs.rename(directory, join(anchor, 'real')); await fs.symlink('real', directory); }
    if (kind === 'owner') policy.stateUid++;
    if (kind === 'ACL') policy.acl = async () => false;
    await expect(port().read('core')).rejects.toThrow(unsafe);
    await expect(port().compareAndSwap('core', null, body())).rejects.toThrow(unsafe);
  });
  it('refuses oversized files and noncanonical write data', async () => {
    await fs.writeFile(target(), Buffer.alloc(65537), { mode: 0o600 });
    await expect(port().read('core')).rejects.toThrow(/^INVALID_HISTORY$/);
    for (const b of [Buffer.from('not-history'), Buffer.alloc(65537), Buffer.from('{}\n')]) {
      await expect(port().compareAndSwap('core', null, b)).rejects.toThrow(/^INVALID_HISTORY$/);
    }
    expect((await fs.stat(target())).size).toBe(65537);
  });
  it('rejects unsafe roles before filesystem I/O', async () => {
    let calls = 0; const io: CircuitFileIo = { ...fs, async lstat(...args) { calls++; return fs.lstat(...args); } } as CircuitFileIo;
    const p = createCircuitFilesAt(policy, io);
    await expect(p.read('../secret' as never)).rejects.toThrow(/^INVALID_HISTORY$/);
    await expect(p.compareAndSwap('constructor' as never, null, body())).rejects.toThrow(/^INVALID_HISTORY$/);
    expect(calls).toBe(0);
  });
  it('copies caller bytes before asynchronous I/O', async () => {
    const b = body(); const operation = port().compareAndSwap('core', null, b); b.fill(0);
    await operation; expect(await fs.readFile(target())).toEqual(body());
  });
  it('detects replacement while the descriptor ACL is inspected', async () => {
    await fs.writeFile(target(), body(), { mode: 0o600 }); let replaced = false;
    policy.acl = async file => {
      if ((await file.stat()).isFile() && !replaced) {
        replaced = true; await fs.rename(target(), join(directory, 'old')); await fs.writeFile(target(), body(1), { mode: 0o600 });
      }
      return true;
    };
    await expect(port().read('core')).rejects.toThrow(unsafe);
    expect(await fs.readFile(target())).toEqual(body(1));
  });
});

/** Fault injection changes only a real file handle's sync; all data operations
 * still use the actual temporary filesystem. No production fixture flag.
 */
function failingSync(which: 'file' | 'directory'): CircuitFileIo {
  return { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    const fail = which === 'file' ? String(path).endsWith('.tmp') : String(path) === directory;
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync' && fail) return async () => { throw new Error('synthetic sync failure'); };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
}
describe('real filesystem failure boundaries', () => {
  it('retains the old complete file on temporary-file sync failure', async () => {
    await port().compareAndSwap('core', null, body());
    const p = createCircuitFilesAt(policy, failingSync('file'));
    await expect(p.compareAndSwap('core', sha(body()), body(1))).rejects.toThrow(/^STATE_IO$/);
    expect(await fs.readFile(target())).toEqual(body()); expect(await fs.readdir(directory)).toEqual(['core.circuit.json']);
  });
  it('retains old bytes on rename failure and removes only its own temp', async () => {
    await port().compareAndSwap('core', null, body());
    const io: CircuitFileIo = { ...fs, async rename() { throw new Error('synthetic rename failure'); } };
    await expect(createCircuitFilesAt(policy, io).compareAndSwap('core', sha(body()), body(1))).rejects.toThrow(/^STATE_IO$/);
    expect(await fs.readFile(target())).toEqual(body()); expect(await fs.readdir(directory)).toEqual(['core.circuit.json']);
  });
  it('reports unknown durability after rename/directory-sync failure without rolling back new bytes', async () => {
    await port().compareAndSwap('core', null, body());
    const p = createCircuitFilesAt(policy, failingSync('directory'));
    await expect(p.compareAndSwap('core', sha(body()), body(1))).rejects.toThrow(/^STATE_IO$/);
    expect(await fs.readFile(target())).toEqual(body(1));
    await expect(port().compareAndSwap('core', sha(body()), body(2))).rejects.toThrow(/^STATE_CONFLICT$/);
  });
});
