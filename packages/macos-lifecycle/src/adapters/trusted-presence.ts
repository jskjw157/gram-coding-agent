import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { hasControls, relativeParts, type AclProbe } from './trusted-files.js';

export type PathPresence = 'absent' | 'file' | 'directory';
function unsafe(): never { throw new Error('UNSAFE_PATH'); }
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Metadata-only absence proof relative to a trusted anchor. Production callers
 * use '/', owner 0 and fixed paths; test anchors are not deployment evidence.
 * ENOENT means absent only after all existing ancestors pass descriptor/ACL
 * checks. ENOTDIR/permission/ACL failures never mean absent. Root is trusted;
 * this snapshot does not reserve a path or exclude concurrent root changes.
 */
export async function probeTrustedPath(anchor: string, ownerUid: number, acl: AclProbe, relative: string): Promise<PathPresence> {
  const held: Array<{ path: string; file: FileHandle; stat: BigIntStats }> = [];
  try {
    if (!isAbsolute(anchor) || resolve(anchor) !== anchor || hasControls(anchor)
      || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || ownerUid >= 0xffff_ffff) unsafe();
    const parts = relativeParts(relative);
    let path = anchor; let presence: PathPresence = 'absent';
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) { const part = parts[i]; if (part === undefined) unsafe(); path = join(path, part); }
      let before: BigIntStats;
      try { before = await lstat(path, { bigint: true }); }
      catch (error) {
        if (i >= 0 && error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') break;
        return unsafe();
      }
      const directory = before.isDirectory();
      if (before.uid !== BigInt(ownerUid) || (before.mode & 0o6022n) !== 0n
        || (!directory && (!before.isFile() || before.nlink !== 1n))
        || (i < parts.length - 1 && !directory)) unsafe();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (directory ? constants.O_DIRECTORY : 0));
      held.push({ path, file, stat: before });
      if (!same(before, await file.stat({ bigint: true })) || await acl(file) !== true
        || !same(before, await file.stat({ bigint: true }))
        || !same(before, await lstat(path, { bigint: true }))) unsafe();
      if (i === parts.length - 1) presence = directory ? 'directory' : 'file';
    }
    for (const entry of held) {
      if (!same(entry.stat, await entry.file.stat({ bigint: true }))
        || !same(entry.stat, await lstat(entry.path, { bigint: true }))) unsafe();
    }
    return presence;
  } catch { return unsafe(); }
  finally { await Promise.all(held.map(async e => { await e.file.close().catch(() => undefined); })); }
}
