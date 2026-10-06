import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { root } from './contracts.js';
import type {
  InstallStage,
  JournalPort,
  LockSession,
  PublishKind,
  PublishPort,
} from './installation-transaction/contracts.js';
import { INSTALL_LIMIT } from './adapters/install-files.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { probeTrustedPath } from './adapters/trusted-presence.js';

export interface NativeInstallStorageLayout {
  readonly anchor: string;
  readonly ownerUid: number;
  readonly appRelative: string;
  readonly launchdRelative: string;
  readonly acl: AclProbe;
}

export interface NativeInstallStorage {
  readonly journal: JournalPort;
  readonly publish: PublishPort;
  lock(): Promise<LockSession>;
  readLive(kind: PublishKind): Promise<Buffer | null>;
  presence(kind: PublishKind): Promise<'absent' | 'file'>;
  removeLiveIfMatches(kind: 'core' | 'tunnel', expected: Buffer): Promise<boolean>;
}

const productionLayout = (acl: AclProbe): NativeInstallStorageLayout => ({
  anchor: '/',
  ownerUid: 0,
  appRelative: root.slice(1),
  launchdRelative: 'Library/LaunchDaemons',
  acl,
});

const names: Readonly<Record<PublishKind, string>> = Object.freeze({
  configuration: 'service.json',
  manifest: 'installation.json',
  journal: 'install-journal.json',
  core: 'com.haar.gram-agent.core.plist',
  tunnel: 'com.haar.gram-agent.tunnel.plist',
});

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.uid === b.uid && a.gid === b.gid;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.nlink === b.nlink;
}

function nativeCode(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value
    : undefined;
}

function pathFor(layout: NativeInstallStorageLayout, kind: PublishKind): string {
  const prefix = kind === 'core' || kind === 'tunnel'
    ? layout.launchdRelative
    : `${layout.appRelative}/config`;
  return `${prefix}/${names[kind]}`;
}

async function trustedDirectory(
  layout: NativeInstallStorageLayout,
  relative: string,
): Promise<{ path: string; file: FileHandle; stat: BigIntStats }> {
  const absolute = join(layout.anchor, relative);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory() || before.uid !== BigInt(layout.ownerUid)
    || (before.mode & 0o6022n) !== 0n) throw new Error('UNSAFE_PATH');
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK,
  );
  try {
    if (!sameIdentity(before, await file.stat({ bigint: true }))
      || await layout.acl(file) !== true
      || !sameIdentity(before, await lstat(absolute, { bigint: true }))) {
      throw new Error('UNSAFE_PATH');
    }
    return { path: absolute, file, stat: before };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function readRelative(
  layout: NativeInstallStorageLayout,
  relative: string,
): Promise<Buffer | null> {
  const presence = await probeTrustedPath(layout.anchor, layout.ownerUid, layout.acl, relative);
  if (presence === 'absent') return null;
  if (presence !== 'file') throw new Error('UNSAFE_PATH');
  return createTrustedFiles(layout.anchor, layout.ownerUid, layout.acl)
    .read(relative, INSTALL_LIMIT);
}

async function createExact(
  directory: { path: string; file: FileHandle; stat: BigIntStats },
  path: string,
  bytes: Buffer,
): Promise<FileHandle> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > INSTALL_LIMIT) {
    throw new Error('INVALID_CONFIG');
  }
  const file = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== directory.stat.uid || stat.nlink !== 1n
      || (stat.mode & 0o7777n) !== 0o644n) throw new Error('UNSAFE_PATH');
    await file.writeFile(bytes);
    await file.sync();
    const ready = await file.stat({ bigint: true });
    if (ready.size !== BigInt(bytes.length) || !sameFile(stat, ready)) {
      throw new Error('STATE_CONFLICT');
    }
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function atomicReplace(
  layout: NativeInstallStorageLayout,
  kind: PublishKind,
  bytes: Buffer,
  suffix: 'write' | 'stage',
): Promise<void> {
  const liveRelative = pathFor(layout, kind);
  const parentRelative = dirname(liveRelative);
  const directory = await trustedDirectory(layout, parentRelative);
  const livePath = join(layout.anchor, liveRelative);
  const temporary = join(directory.path, `.${basename(liveRelative)}.${suffix}`);
  let file: FileHandle | null = null;
  try {
    file = await createExact(directory, temporary, bytes);
    if (!sameIdentity(directory.stat, await directory.file.stat({ bigint: true }))
      || !sameIdentity(directory.stat, await lstat(directory.path, { bigint: true }))) {
      throw new Error('UNSAFE_PATH');
    }
    if (suffix === 'write') {
      await rename(temporary, livePath);
      await directory.file.sync();
    }
  } finally {
    await file?.close().catch(() => undefined);
    await directory.file.close().catch(() => undefined);
  }
}

export function createNativeInstallStorageAt(
  input: NativeInstallStorageLayout,
): NativeInstallStorage {
  const layout: NativeInstallStorageLayout = {
    anchor: resolve(input.anchor),
    ownerUid: input.ownerUid,
    appRelative: input.appRelative,
    launchdRelative: input.launchdRelative,
    acl: input.acl,
  };
  if (layout.anchor !== input.anchor || !Number.isSafeInteger(layout.ownerUid)
    || layout.ownerUid < 0 || typeof layout.acl !== 'function') {
    throw new Error('UNSAFE_PATH');
  }

  const readLive = async (kind: PublishKind): Promise<Buffer | null> =>
    readRelative(layout, pathFor(layout, kind));

  const publish: PublishPort = Object.freeze({
    async stageFile(kind: PublishKind, bytes: Buffer) {
      await atomicReplace(layout, kind, Buffer.from(bytes), 'stage');
    },
    async publishFile(kind: PublishKind, inputBytes: Buffer) {
      const bytes = Buffer.from(inputBytes);
      const liveRelative = pathFor(layout, kind);
      const parentRelative = dirname(liveRelative);
      const directory = await trustedDirectory(layout, parentRelative);
      const stagePath = join(directory.path, `.${basename(liveRelative)}.stage`);
      const livePath = join(layout.anchor, liveRelative);
      try {
        const staged = await readRelative(
          layout,
          `${parentRelative}/.${basename(liveRelative)}.stage`,
        );
        if (staged === null || !staged.equals(bytes)) throw new Error('STATE_CONFLICT');
        await rename(stagePath, livePath);
        await directory.file.sync();
      } finally {
        await directory.file.close().catch(() => undefined);
      }
    },
    async readStaged(kind: PublishKind) {
      const liveRelative = pathFor(layout, kind);
      return readRelative(
        layout,
        `${dirname(liveRelative)}/.${basename(liveRelative)}.stage`,
      );
    },
    readLive,
  });

  const journal: JournalPort = Object.freeze({
    async read() {
      return readLive('journal');
    },
    async writeStage(_stage: InstallStage, body: Buffer) {
      await atomicReplace(layout, 'journal', Buffer.from(body), 'write');
    },
  });

  return Object.freeze({
    journal,
    publish,
    readLive,
    async presence(kind: PublishKind) {
      const value = await probeTrustedPath(
        layout.anchor,
        layout.ownerUid,
        layout.acl,
        pathFor(layout, kind),
      );
      if (value === 'directory') throw new Error('UNSAFE_PATH');
      return value;
    },
    async removeLiveIfMatches(kind: 'core' | 'tunnel', expected: Buffer) {
      const liveRelative = pathFor(layout, kind);
      const current = await readRelative(layout, liveRelative);
      if (current === null) return true;
      if (!current.equals(expected)) return false;
      const directory = await trustedDirectory(layout, dirname(liveRelative));
      const livePath = join(layout.anchor, liveRelative);
      try {
        const before = await lstat(livePath, { bigint: true });
        if (!before.isFile() || before.uid !== BigInt(layout.ownerUid) || before.nlink !== 1n) {
          return false;
        }
        await unlink(livePath);
        await directory.file.sync();
        return true;
      } catch {
        return false;
      } finally {
        await directory.file.close().catch(() => undefined);
      }
    },
    async lock() {
      const relative = `${layout.appRelative}/config/install.lock`;
      const parentRelative = dirname(relative);
      const directory = await trustedDirectory(layout, parentRelative);
      const lockPath = join(layout.anchor, relative);
      let file: FileHandle;
      try {
        file = await open(
          lockPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        await directory.file.close().catch(() => undefined);
        if (nativeCode(error) === 'EEXIST') {
          return { acquired: false, release: async () => undefined };
        }
        throw error;
      }
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.uid !== BigInt(layout.ownerUid)
        || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n) {
        await file.close().catch(() => undefined);
        await directory.file.close().catch(() => undefined);
        throw new Error('UNSAFE_PATH');
      }
      let released = false;
      return {
        acquired: true,
        async release() {
          if (released) throw new Error('STATE_CONFLICT');
          released = true;
          try {
            const current = await lstat(lockPath, { bigint: true });
            const held = await file.stat({ bigint: true });
            if (!sameFile(before, current) || !sameFile(before, held)) throw new Error('STATE_CONFLICT');
            await unlink(lockPath);
            await directory.file.sync();
          } finally {
            await file.close().catch(() => undefined);
            await directory.file.close().catch(() => undefined);
          }
        },
      };
    },
  });
}

export function createSystemNativeInstallStorage(acl: AclProbe): NativeInstallStorage {
  return createNativeInstallStorageAt(productionLayout(acl));
}
