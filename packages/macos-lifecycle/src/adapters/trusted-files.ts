import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type AclProbe = (file: FileHandle) => Promise<boolean>;
export type InventoryEntry = { path: string; kind: 'directory' } | { path: string; kind: 'file'; executable: boolean } | { path: string; kind: 'link'; target: string };
export interface ReleaseFiles {
  read(path: string, limit: number): Promise<Buffer>;
  hash(path: string, limit: number): Promise<string>;
  inventory(): Promise<InventoryEntry[]>;
}
const MAX_BYTES = 256 * 1024 * 1024;
function unsafe(): never { throw new Error('UNSAFE_PATH'); }
export function relativeParts(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || isAbsolute(path)
    || /[\\\u0000-\u001f\u007f]/u.test(path)) unsafe();
  const parts = path.split('/');
  if (parts.length > 64 || parts.some(part => part === '' || part === '.' || part === '..')) unsafe();
  return parts;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function modeSafe(s: BigIntStats, uid: number): boolean {
  return s.uid === BigInt(uid) && (s.mode & 0o6022n) === 0n;
}

/** Internal scoped read port. The caller must supply a genuinely trusted anchor
 * and ACL verifier. Deployment uses anchor '/', owner 0 and a fixed release
 * prefix, so every ancestor is checked. A temporary test anchor is not evidence
 * for a production installation. No keys, files or jobs are written here.
 * Root/admin is trusted: this does not promise atomic exclusion of root changes.
 */
export function createTrustedFiles(anchor: string, ownerUid: number, acl: AclProbe, prefix = ''): ReleaseFiles {
  if (!isAbsolute(anchor) || resolve(anchor) !== anchor || /[\u0000-\u001f\u007f]/u.test(anchor)
    || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || ownerUid >= 0xffff_ffff) unsafe();
  const prefixParts = prefix === '' ? [] : relativeParts(prefix);
  type Snapshot = { path: string; file: FileHandle; stat: BigIntStats };
  async function checked<T>(parts: readonly string[], directory: boolean, use: (file: FileHandle, stat: BigIntStats, path: string) => Promise<T>): Promise<T> {
    const held: Snapshot[] = [];
    try {
      let path = anchor;
      const all = [...prefixParts, ...parts];
      for (let i = -1; i < all.length; i++) {
        if (i >= 0) path = join(path, all[i]!);
        const isDir = i < all.length - 1 || directory;
        const before = await lstat(path, { bigint: true });
        if (!modeSafe(before, ownerUid) || (isDir ? !before.isDirectory() : !before.isFile())
          || (!isDir && before.nlink !== 1n)) unsafe();
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (isDir ? constants.O_DIRECTORY : 0));
        held.push({ path, file, stat: before });
        if (!same(before, await file.stat({ bigint: true })) || await acl(file) !== true
          || !same(before, await file.stat({ bigint: true }))
          || !same(before, await lstat(path, { bigint: true }))) unsafe();
      }
      const last = held.at(-1)!;
      const result = await use(last.file, last.stat, last.path);
      for (const snapshot of held) {
        if (!same(snapshot.stat, await snapshot.file.stat({ bigint: true }))
          || !same(snapshot.stat, await lstat(snapshot.path, { bigint: true }))) unsafe();
      }
      return result;
    } catch { return unsafe(); }
    finally { await Promise.all(held.map(async entry => { await entry.file.close().catch(() => undefined); })); }
  }
  async function consume(path: string, limit: number, retain: boolean): Promise<Buffer | string> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_BYTES) unsafe();
    return checked(relativeParts(path), false, async (file, s) => {
      if (s.size < 0n || s.size > BigInt(limit)) unsafe();
      const hash = createHash('sha256'); const chunks: Buffer[] = [];
      let position = 0;
      const buffer = Buffer.alloc(Math.min(65536, limit + 1));
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit - position + 1), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > limit || BigInt(position) > s.size) unsafe();
        const chunk = buffer.subarray(0, bytesRead);
        if (retain) chunks.push(Buffer.from(chunk)); else hash.update(chunk);
      }
      if (BigInt(position) !== s.size) unsafe();
      return retain ? Buffer.concat(chunks, position) : hash.digest('hex');
    });
  }
  return {
    async read(path, limit) { return await consume(path, limit, true) as Buffer; },
    async hash(path, limit) { return await consume(path, limit, false) as string; },
    async inventory() {
      const found: InventoryEntry[] = [];
      const walk = async (parts: string[]): Promise<void> => {
        if (parts.length > 64) unsafe();
        await checked(parts, true, async (_file, _stat, directory) => {
          const names = await readdir(directory);
          if (names.length > 20000) unsafe();
          for (const name of names.sort()) {
            if (relativeParts(name).length !== 1 || found.length >= 20000) unsafe();
            const childParts = [...parts, name]; const path = childParts.join('/');
            const absolute = join(directory, name); const stat = await lstat(absolute, { bigint: true });
            if (stat.uid !== BigInt(ownerUid)) unsafe();
            if (stat.isSymbolicLink()) {
              if (stat.nlink !== 1n) unsafe();
              const target = await readlink(absolute);
              if (!same(stat, await lstat(absolute, { bigint: true }))) unsafe();
              found.push({ path, kind: 'link', target });
            } else if (stat.isDirectory()) {
              if (!modeSafe(stat, ownerUid)) unsafe();
              found.push({ path, kind: 'directory' }); await walk(childParts);
            } else if (stat.isFile() && modeSafe(stat, ownerUid) && stat.nlink === 1n) {
              // Metadata only: unlisted files are rejected before any data open.
              found.push({ path, kind: 'file', executable: (stat.mode & 0o111n) !== 0n });
            } else unsafe();
          }
        });
      };
      await walk([]);
      return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    },
  };
}
