import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCircuitFilesAt, type CircuitFileIo, type StateDirectoryPolicy } from './service-files.js';
import { encodeHistory } from '../lifecycle-store.js';
import { freshHistory } from '../circuit.js';
let anchor: string; let directory: string; let policy: StateDirectoryPolicy;
const old = () => encodeHistory(freshHistory(0));
const next = () => encodeHistory(freshHistory(1));
const digest = () => createHash('sha256').update(old()).digest('hex');
beforeEach(async () => {
  anchor = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'gram circuit faults ')));
  directory = join(anchor, 'run'); await fs.mkdir(directory, { mode: 0o700 });
  policy = { anchor, relative: 'run', ancestorUid: process.getuid?.() ?? -1,
    stateUid: process.getuid?.() ?? -1, acl: async () => true };
  await createCircuitFilesAt(policy).compareAndSwap('core', null, old());
});
afterEach(async () => { await fs.rm(anchor, { recursive: true, force: true }); });
it('cleans its incomplete temporary write without truncating the current record', async () => {
  const io: CircuitFileIo = { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile' && String(path).endsWith('.tmp')) return async () => {
        await target.write(Buffer.from('{')); throw new Error('synthetic partial write failure');
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await expect(createCircuitFilesAt(policy, io).compareAndSwap('core', digest(), next())).rejects.toThrow(/^STATE_IO$/);
  expect(await fs.readFile(join(directory, 'core.circuit.json'))).toEqual(old());
  expect(await fs.readdir(directory)).toEqual(['core.circuit.json']);
});
it('does not rename state or remove a replaced foreign lock', async () => {
  const lock = join(directory, 'core.circuit.lock');
  const io: CircuitFileIo = { ...fs, async open(path, flags, mode) {
    const handle = await fs.open(path, flags, mode);
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync' && String(path).endsWith('.tmp')) return async () => {
        await target.sync(); await fs.rename(lock, join(directory, 'detached-own-lock'));
        await fs.writeFile(lock, 'foreign-owner', { mode: 0o600 });
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await expect(createCircuitFilesAt(policy, io).compareAndSwap('core', digest(), next())).rejects.toThrow(/^UNSAFE_PATH$/);
  expect(await fs.readFile(join(directory, 'core.circuit.json'))).toEqual(old());
  expect(await fs.readFile(lock, 'utf8')).toBe('foreign-owner');
  expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
});
