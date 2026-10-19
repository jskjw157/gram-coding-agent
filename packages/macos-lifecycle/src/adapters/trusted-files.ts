import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type AclProbe = (file: FileHandle) => Promise<boolean>;
export type InventoryEntry = { path: string; kind: 'directory' } | { path: string; kind: 'file'; executable: boolean } | { path: string; kind: 'link'; target: string };
export interface ReleaseFiles {
  read(path: string, limit: number): Promise<Buffer>;
  hash(path: string, limit: number): Promise<string>;
  inventory(signal?: AbortSignal): Promise<InventoryEntry[]>;
  /** Optional native optimization. Decorated receivers retain their own ports. */
  withReadSession?<T>(use: (files: ReleaseFiles) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
const MAX_BYTES = 256 * 1024 * 1024;
function unsafe(): never { throw new Error('UNSAFE_PATH'); }
export function hasControls(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
export function relativeParts(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || isAbsolute(path)
    || path.includes('\\') || hasControls(path)) unsafe();
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
  if (!isAbsolute(anchor) || resolve(anchor) !== anchor || hasControls(anchor)
    || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || ownerUid >= 0xffff_ffff) unsafe();
  const prefixParts = prefix === '' ? [] : relativeParts(prefix);
  type Snapshot = { path: string; file: FileHandle; stat: BigIntStats };
  type Scope = { prefix: readonly Snapshot[]; signal: AbortSignal;
    closed: boolean; pending: Set<Promise<unknown>> };
  const active = (signal?: AbortSignal, scope?: Scope) => {
    if (signal?.aborted || scope?.closed || scope?.signal.aborted) unsafe();
  };
  // A createTrustedFiles() instance is one bounded review session. Reuse an
  // ACL verdict only while the exact descriptor/path stat identity remains
  // byte-for-byte equivalent. Any owner/mode/link/size/mtime/ctime/inode drift
  // invalidates the cache and invokes the trusted ACL helper again.
  const aclCache = new Map<string, BigIntStats>();
  const trustedAcl = async (path: string, file: FileHandle, stat: BigIntStats): Promise<boolean> => {
    const cached = aclCache.get(path);
    if (cached !== undefined && same(cached, stat)) return true;
    if (await acl(file) !== true) return false;
    aclCache.set(path, stat);
    return true;
  };
  const verifyHeld = async (held: readonly Snapshot[], check: () => void = () => {}) => {
    for (const snapshot of held) {
      check();
      if (!same(snapshot.stat, await snapshot.file.stat({ bigint: true }))) unsafe();
      check();
      if (!same(snapshot.stat, await lstat(snapshot.path, { bigint: true }))) unsafe();
    }
  };
  async function checked<T>(parts: readonly string[], directory: boolean,
    use: (file: FileHandle, stat: BigIntStats, path: string, held: readonly Snapshot[]) => Promise<T>,
    signal?: AbortSignal, scope?: Scope): Promise<T> {
    const owned: Snapshot[] = []; const held: Snapshot[] = [...(scope?.prefix ?? [])];
    const check = () => active(signal, scope);
    try {
      check();
      if (scope) await verifyHeld(scope.prefix, check);
      let path = scope ? scope.prefix.at(-1)?.path : anchor;
      if (path === undefined) unsafe();
      const all = scope ? parts : [...prefixParts, ...parts];
      for (let i = scope ? 0 : -1; i < all.length; i++) {
        check();
        if (i >= 0) { const part = all[i]; if (part === undefined) unsafe(); path = join(path, part); }
        const isDir = i < all.length - 1 || directory;
        const before = await lstat(path, { bigint: true });
        check();
        if (!modeSafe(before, ownerUid) || (isDir ? !before.isDirectory() : !before.isFile())
          || (!isDir && before.nlink !== 1n)) unsafe();
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (isDir ? constants.O_DIRECTORY : 0));
        const snapshot = { path, file, stat: before }; owned.push(snapshot); held.push(snapshot);
        check();
        if (!same(before, await file.stat({ bigint: true }))) unsafe();
        check();
        if (await trustedAcl(path, file, before) !== true) unsafe();
        check();
        if (!same(before, await file.stat({ bigint: true }))
          || !same(before, await lstat(path, { bigint: true }))) unsafe();
      }
      const last = held.at(-1);
      if (last === undefined) unsafe();
      check();
      const result = await use(last.file, last.stat, last.path, held);
      await verifyHeld(held, check); check();
      return result;
    } catch { return unsafe(); }
    finally { await Promise.all(owned.map(async entry => { await entry.file.close().catch(() => undefined); })); }
  }
  async function consume(path: string, limit: number, retain: boolean, scope?: Scope): Promise<Buffer | string> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_BYTES) unsafe();
    return checked(relativeParts(path), false, async (file, s) => {
      if (s.size < 0n || s.size > BigInt(limit)) unsafe();
      const hash = createHash('sha256'); const chunks: Buffer[] = [];
      let position = 0;
      const buffer = Buffer.alloc(Math.min(65536, limit + 1));
      for (;;) {
        active(undefined, scope);
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit - position + 1), position);
        active(undefined, scope);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > limit || BigInt(position) > s.size) unsafe();
        const chunk = buffer.subarray(0, bytesRead);
        if (retain) chunks.push(Buffer.from(chunk)); else hash.update(chunk);
      }
      if (BigInt(position) !== s.size) unsafe();
      return retain ? Buffer.concat(chunks, position) : hash.digest('hex');
    }, undefined, scope);
  }
  async function collectInventory(signal?: AbortSignal, scope?: Scope): Promise<InventoryEntry[]> {
    const found: InventoryEntry[] = [];
    const walk = async (parts: string[], directory: string, held: readonly Snapshot[]): Promise<void> => {
      active(signal, scope);
      if (parts.length > 64) unsafe();
      // Reuse only descriptors held by this active recursive walk. Verify
      // the complete ancestry at directory boundaries, as checked() does,
      // without reopening every ancestor at every depth. Nothing survives
      // this inventory except the enclosing read session's fixed prefix.
      // No descriptor authorizes a later independent read outside that scope.
      await verifyHeld(held, () => active(signal, scope));
      active(signal, scope);
      const names = await readdir(directory);
      if (names.length > 20000) unsafe();
      for (const name of names.sort()) {
        active(signal, scope);
        if (relativeParts(name).length !== 1 || found.length >= 20000) unsafe();
        const childParts = [...parts, name]; const path = childParts.join('/');
        const absolute = join(directory, name); const stat = await lstat(absolute, { bigint: true });
        active(signal, scope);
        if (stat.uid !== BigInt(ownerUid)) unsafe();
        if (stat.isSymbolicLink()) {
          if (stat.nlink !== 1n) unsafe();
          const target = await readlink(absolute);
          if (!same(stat, await lstat(absolute, { bigint: true }))) unsafe();
          found.push({ path, kind: 'link', target });
        } else if (stat.isDirectory()) {
          if (!modeSafe(stat, ownerUid)) unsafe();
          found.push({ path, kind: 'directory' });
          const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
          try {
            active(signal, scope);
            if (!same(stat, await file.stat({ bigint: true })) || await trustedAcl(absolute, file, stat) !== true
              || !same(stat, await file.stat({ bigint: true }))
              || !same(stat, await lstat(absolute, { bigint: true }))) unsafe();
            await walk(childParts, absolute, [...held, { path: absolute, file, stat }]);
          } finally { await file.close().catch(() => undefined); }
        } else if (stat.isFile() && modeSafe(stat, ownerUid) && stat.nlink === 1n) {
          // Metadata only: unlisted files are rejected before any data open.
          found.push({ path, kind: 'file', executable: (stat.mode & 0o111n) !== 0n });
        } else unsafe();
      }
      active(signal, scope);
      await verifyHeld(held, () => active(signal, scope));
    };
    await checked([], true, async (_file, _stat, directory, held) => walk([], directory, held), signal, scope);
    return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  function port(scope?: Scope): ReleaseFiles {
    // Register before the first asynchronous IO. Closing a scope prevents new
    // operations, then waits for already-dispatched reads to close their leaves.
    function run<T>(use: () => Promise<T>): Promise<T> {
      active(undefined, scope);
      const result = Promise.resolve().then(() => { active(undefined, scope); return use(); });
      if (scope) {
        scope.pending.add(result);
        void result.then(() => { scope.pending.delete(result); }, () => { scope.pending.delete(result); });
      }
      return result;
    }
    const result: ReleaseFiles = {
      async read(path, limit) { return run(async () => await consume(path, limit, true, scope) as Buffer); },
      async hash(path, limit) { return run(async () => await consume(path, limit, false, scope) as string); },
      async inventory(signal) { return run(() => collectInventory(signal, scope)); },
    };
    if (!scope) {
      result.withReadSession = async function<T>(this: ReleaseFiles, use: (files: ReleaseFiles) => Promise<T>, signal?: AbortSignal): Promise<T> {
        active(signal);
        // A spread/decorated port can impose extra hash/read guards. Never
        // replace those guards with the original native port's implementation.
        if (this !== result) return use(this);
        return checked([], true, async (_file, _stat, _path, prefix) => {
          const controller = new AbortController();
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const current: Scope = { prefix, signal: combined, closed: false, pending: new Set() };
          let onAbort = () => {};
          const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error('UNSAFE_PATH'));
            combined.addEventListener('abort', onAbort, { once: true });
            if (combined.aborted) onAbort();
          });
          try {
            const value = await Promise.race([Promise.resolve().then(() => { active(undefined, current); return use(port(current)); }), cancelled]);
            active(undefined, current);
            if (current.pending.size !== 0) unsafe();
            return value;
          } finally {
            current.closed = true; combined.removeEventListener('abort', onAbort); controller.abort();
            // This waits for real IO cleanup. A never-returning filesystem call
            // cannot be made quiescent by cancellation or a return-time timer.
            await Promise.allSettled([...current.pending]);
          }
        }, signal);
      };
    }
    return Object.freeze(result);
  }
  return port();
}
