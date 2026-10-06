import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { hasControls, relativeParts, type AclProbe } from './trusted-files.js';
import type { StateDirectoryPolicy } from './private-record-files.js';

/** Internal deployment scope. Production binds '/' and the fixed application root. */
export interface RuntimeLayout { anchor: string; relative: string; ownerUid: number }
export interface RuntimeDirectories {
  runPolicy: Readonly<StateDirectoryPolicy>;
  logsPolicy: Readonly<StateDirectoryPolicy>;
  verify(): Promise<void>;
}
function unsafe(): never { throw new Error('UNSAFE_PATH'); }
function uid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 0xffff_ffff;
}
export function copyRuntimeLayout(input: RuntimeLayout): Readonly<RuntimeLayout> {
  if (input === null || typeof input !== 'object') unsafe();
  const keys = ['anchor', 'relative', 'ownerUid']; const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) unsafe();
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !('value' in d)) unsafe(); values[key] = d.value;
  }
  const { anchor, relative, ownerUid } = values;
  if (typeof anchor !== 'string' || !isAbsolute(anchor) || resolve(anchor) !== anchor || hasControls(anchor)
    || typeof relative !== 'string' || !uid(ownerUid)) unsafe();
  relativeParts(relative);
  return Object.freeze({ anchor, relative, ownerUid });
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  // Directory contents legitimately change while records are written. Pin the
  // directory object and permissions, not its size/mtime or directory entries.
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
type Held = { path: string; file: FileHandle; stat: BigIntStats };
const privateNames = ['run', 'state', 'secrets', 'logs'] as const;

/** Metadata only: no readdir, secret reads, chmod, mkdir or implicit repair.
 * The bootstrap ACL capability must already be trusted independently of the
 * candidate release. Root/admin and hostile same-UID processes are not sandboxed.
 */
export async function inspectRuntimeDirectories(input: RuntimeLayout, runtimeUid: number,
  acl: AclProbe, signal: AbortSignal): Promise<RuntimeDirectories> {
  const layout = copyRuntimeLayout(input);
  if (!uid(runtimeUid) || runtimeUid === 0 || typeof acl !== 'function' || signal.aborted) unsafe();
  const prefix = relativeParts(layout.relative);
  async function scan(expected?: ReadonlyMap<string, BigIntStats>, abort?: AbortSignal): Promise<Map<string, BigIntStats>> {
    const found = new Map<string, BigIntStats>();
    for (const name of privateNames) {
      const held: Held[] = []; const parts = [...prefix, name]; let path = layout.anchor;
      try {
        for (let n = -1; n < parts.length; n++) {
          if (abort?.aborted) unsafe();
          if (n >= 0) { const part = parts[n]; if (!part) unsafe(); path = join(path, part); }
          const leaf = n === parts.length - 1;
          const s = await lstat(path, { bigint: true });
          if (!s.isDirectory() || s.uid !== BigInt(leaf ? runtimeUid : layout.ownerUid)
            || (s.mode & 0o6022n) !== 0n || (leaf && (s.mode & 0o7777n) !== 0o700n)) unsafe();
          const prior = expected?.get(path) ?? found.get(path);
          if ((expected && !prior) || (prior && !same(prior, s))) unsafe();
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
          held.push({ path, file, stat: s });
          if (!same(s, await file.stat({ bigint: true })) || await acl(file) !== true || abort?.aborted
            || !same(s, await file.stat({ bigint: true })) || !same(s, await lstat(path, { bigint: true }))) unsafe();
          found.set(path, s);
        }
        for (const item of held) {
          if (!same(item.stat, await item.file.stat({ bigint: true }))
            || !same(item.stat, await lstat(item.path, { bigint: true }))) unsafe();
        }
      } catch { unsafe(); }
      finally { await Promise.all(held.map(async item => { await item.file.close().catch(() => undefined); })); }
    }
    return found;
  }
  const initial = await scan(undefined, signal); await scan(initial, signal);
  const runPolicy = Object.freeze({ anchor: layout.anchor, relative: layout.relative + '/run',
    ancestorUid: layout.ownerUid, stateUid: runtimeUid, acl });
  const logsPolicy = Object.freeze({ ...runPolicy, relative: layout.relative + '/logs' });
  return Object.freeze({ runPolicy, logsPolicy, async verify() { await scan(initial); } });
}
