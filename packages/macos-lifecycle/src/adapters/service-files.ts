import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { Role } from '../contracts.js';
import { decodeHistory, type CircuitFiles } from '../lifecycle-store.js';
import { hasControls, relativeParts, type AclProbe } from './trusted-files.js';

/** INTERNAL capability construction, never serialized CLI/MCP input. The anchor
 * and ACL verifier must be independently trusted. Temporary test anchors do not
 * prove production trust. This module provisions no account or directory.
 */
export interface StateDirectoryPolicy {
  anchor: string; relative: string; ancestorUid: number; stateUid: number; acl: AclProbe;
}
export type CircuitFileIo = Pick<typeof fs, 'open' | 'lstat' | 'rename' | 'unlink'>;
const MAX_BYTES = 65536;
const codes = new Set(['UNSAFE_PATH', 'INVALID_HISTORY', 'STATE_IO', 'STATE_CONFLICT', 'BUSY']);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never { throw new Error(code); }
function nativeCode(e: unknown): unknown {
  return e !== null && typeof e === 'object' ? Object.getOwnPropertyDescriptor(e, 'code')?.value : undefined;
}
function safe(e: unknown): never {
  const m = e instanceof Error ? Object.getOwnPropertyDescriptor(e, 'message')?.value : undefined;
  return fail(typeof m === 'string' && codes.has(m) ? m : 'STATE_IO');
}
function roleOnly(role: unknown): asserts role is Role {
  if (role !== 'core' && role !== 'tunnel') fail('INVALID_HISTORY');
}
function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function uid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 0xffff_ffff;
}
type Held = { path: string; file: fs.FileHandle; stat: BigIntStats };
type Directory = { path: string; file: fs.FileHandle; verify(): Promise<void> };

/** Writers cooperate through O_EXCL per-role locks. A crash leaves BUSY: this
 * adapter never steals a lock by age/PID or performs journal replay. Root and
 * same-uid code are trusted; repeated path checks are not an OS sandbox or an
 * atomic exclusion guarantee against their concurrent path/ACL replacement.
 */
export function createCircuitFilesAt(policy: StateDirectoryPolicy, io: CircuitFileIo = fs): CircuitFiles {
  const p = Object.freeze({ ...policy });
  if (typeof p.anchor !== 'string' || !isAbsolute(p.anchor) || resolve(p.anchor) !== p.anchor
    || hasControls(p.anchor) || !uid(p.ancestorUid) || !uid(p.stateUid) || typeof p.acl !== 'function') fail('UNSAFE_PATH');
  const parts = relativeParts(p.relative);
  const disk = Object.freeze({ open: io.open, lstat: io.lstat, rename: io.rename, unlink: io.unlink });
  async function directory<T>(use: (dir: Directory) => Promise<T>): Promise<T> {
    const held: Held[] = [];
    try {
      let path = p.anchor;
      try {
        for (let n = -1; n < parts.length; n++) {
          if (n >= 0) { const component = parts[n]; if (!component) fail('UNSAFE_PATH'); path = join(path, component); }
          const leaf = n === parts.length - 1;
          const before = await disk.lstat(path, { bigint: true });
          if (!before.isDirectory() || before.uid !== BigInt(leaf ? p.stateUid : p.ancestorUid)
            || (before.mode & 0o6022n) !== 0n || (leaf && (before.mode & 0o7777n) !== 0o700n)) fail('UNSAFE_PATH');
          const file = await disk.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
          held.push({ path, file, stat: before });
          if (!identity(before, await file.stat({ bigint: true })) || await p.acl(file) !== true
            || !identity(before, await disk.lstat(path, { bigint: true }))) fail('UNSAFE_PATH');
        }
      } catch { return fail('UNSAFE_PATH'); }
      const last = held.at(-1); if (!last) fail('UNSAFE_PATH');
      const verify = async (): Promise<void> => {
        try {
          for (const item of held) {
            if (!identity(item.stat, await item.file.stat({ bigint: true })) || await p.acl(item.file) !== true
              || !identity(item.stat, await disk.lstat(item.path, { bigint: true }))) fail('UNSAFE_PATH');
          }
        } catch { fail('UNSAFE_PATH'); }
      };
      const result = await use({ path: last.path, file: last.file, verify });
      await verify(); return result;
    } catch (error) { return safe(error); }
    finally { await Promise.all(held.map(async item => { await item.file.close().catch(() => undefined); })); }
  }
  function privateFile(stat: BigIntStats): void {
    if (!stat.isFile() || stat.uid !== BigInt(p.stateUid) || stat.nlink !== 1n
      || (stat.mode & 0o7777n) !== 0o600n) fail('UNSAFE_PATH');
  }
  async function readAt(path: string): Promise<{ bytes: Buffer; stat: BigIntStats } | null> {
    let before: BigIntStats;
    try { before = await disk.lstat(path, { bigint: true }); }
    catch (error) { if (nativeCode(error) === 'ENOENT') return null; return fail('UNSAFE_PATH'); }
    privateFile(before);
    if (before.size < 0n || before.size > BigInt(MAX_BYTES)) fail('INVALID_HISTORY');
    const file = await disk.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!unchanged(before, await file.stat({ bigint: true })) || await p.acl(file) !== true
        || !unchanged(before, await disk.lstat(path, { bigint: true }))) fail('UNSAFE_PATH');
      const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break; offset += bytesRead;
      }
      if (BigInt(offset) !== before.size || !unchanged(before, await file.stat({ bigint: true }))
        || !unchanged(before, await disk.lstat(path, { bigint: true }))) fail('UNSAFE_PATH');
      return { bytes: Buffer.from(buffer.subarray(0, offset)), stat: before };
    } finally { await file.close(); }
  }
  async function removeOwn(path: string, file: fs.FileHandle): Promise<void> {
    const actual = await disk.lstat(path, { bigint: true });
    const owned = await file.stat({ bigint: true });
    if (actual.dev !== owned.dev || actual.ino !== owned.ino) fail('UNSAFE_PATH');
    await disk.unlink(path);
  }
  return Object.freeze({
    async read(role: Role) {
      roleOnly(role);
      return directory(async dir => (await readAt(join(dir.path, `${role}.circuit.json`)))?.bytes ?? null);
    },
    async compareAndSwap(role: Role, expectedDigest: string | null, input: Buffer) {
      try {
        roleOnly(role);
        if (!(expectedDigest === null || (typeof expectedDigest === 'string' && expectedDigest.length === 64
          && !/[^a-f0-9]/u.test(expectedDigest))) || !Buffer.isBuffer(input) || input.length > MAX_BYTES) fail('INVALID_HISTORY');
        const bytes = Buffer.from(input); decodeHistory(bytes);
        await directory(async dir => {
          const destination = join(dir.path, `${role}.circuit.json`);
          const lockPath = join(dir.path, `${role}.circuit.lock`);
          let lock: fs.FileHandle;
          try { lock = await disk.open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
          catch (error) { if (nativeCode(error) === 'EEXIST') fail('BUSY'); throw error; }
          let temporary: fs.FileHandle | null = null; let temporaryPath: string | null = null;
          try {
            const lockStat = await lock.stat({ bigint: true }); privateFile(lockStat);
            if (await p.acl(lock) !== true || !unchanged(lockStat, await disk.lstat(lockPath, { bigint: true }))) fail('UNSAFE_PATH');
            const current = await readAt(destination);
            if ((current === null ? null : sha(current.bytes)) !== expectedDigest) fail('STATE_CONFLICT');
            await dir.verify();
            temporaryPath = join(dir.path, `.${role}.${randomUUID()}.tmp`);
            temporary = await disk.open(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            privateFile(await temporary.stat({ bigint: true }));
            if (await p.acl(temporary) !== true) fail('UNSAFE_PATH');
            await temporary.writeFile(bytes); await temporary.sync();
            const ready = await temporary.stat({ bigint: true }); privateFile(ready);
            if (ready.size !== BigInt(bytes.length) || await p.acl(temporary) !== true
              || !unchanged(ready, await disk.lstat(temporaryPath, { bigint: true }))) fail('UNSAFE_PATH');
            const latest = await readAt(destination);
            if ((latest === null ? null : sha(latest.bytes)) !== expectedDigest
              || (latest !== null && current !== null && !unchanged(current.stat, latest.stat))) fail('STATE_CONFLICT');
            await dir.verify();
            if (!unchanged(lockStat, await lock.stat({ bigint: true }))
              || !unchanged(lockStat, await disk.lstat(lockPath, { bigint: true }))) fail('UNSAFE_PATH');
            await disk.rename(temporaryPath, destination); temporaryPath = null;
            // Failure after rename means unknown durability, NOT a rollback.
            await dir.file.sync();
          } finally {
            try {
              await dir.verify();
              if (temporaryPath !== null && temporary !== null) await removeOwn(temporaryPath, temporary);
              await removeOwn(lockPath, lock);
              await dir.file.sync();
            } finally {
              await temporary?.close().catch(() => undefined);
              await lock.close().catch(() => undefined);
            }
          }
        });
      } catch (error) { safe(error); }
    },
  });
}
