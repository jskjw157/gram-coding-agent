import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root } from './contracts.js';
import type { CoreCredentials } from './health-probe.js';
import type { RuntimeReviewApproval, RuntimeReviewCandidate } from './reviewed-bootstrap.js';
import { checkMacAcl } from './adapters/macos-acl.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';

const REVIEW_FILE = 'runtime-review.json';
const REVIEW_DIGEST_FILE = 'runtime-review.sha256';
const SECRET_FILE = 'mcp-internal-secret';
const MAX_REVIEW_BYTES = 65_536;
const MAX_SECRET_BYTES = 65_536;

export const systemBootstrapPaths = Object.freeze({
  aclHelper: `${root}/bootstrap/bin/file-acl`,
  review: `${root}/config/${REVIEW_FILE}`,
  reviewDigest: `${root}/config/${REVIEW_DIGEST_FILE}`,
  secret: `${root}/secrets/${SECRET_FILE}`,
});

function safeDigest(bytes: Buffer): string | null {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length !== 65 || bytes.at(64) !== 10) return null;
    const text = bytes.subarray(0, 64).toString('ascii');
    return /^[a-f0-9]{64}$/u.test(text) ? text : null;
  } catch {
    return null;
  }
}

function safeRelative(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.startsWith('/') || value.includes('\\')) throw new Error('UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..'
    || [...part].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) {
    throw new Error('UNSAFE_PATH');
  }
  return parts;
}

async function sameStat(file: FileHandle, path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
  const [held, current] = await Promise.all([file.stat(), lstat(path)]);
  return held.dev === before.dev && held.ino === before.ino && held.mode === before.mode
    && held.uid === before.uid && held.gid === before.gid && held.nlink === before.nlink
    && held.size === before.size && current.dev === before.dev && current.ino === before.ino
    && current.mode === before.mode && current.uid === before.uid && current.gid === before.gid
    && current.nlink === before.nlink && current.size === before.size;
}

/**
 * Bootstrap trust anchor for the ACL verifier itself. This intentionally does
 * NOT use the candidate release's bin/file-acl. Every ancestor and the fixed
 * helper must be root-owned and non-writable by group/other; the helper must be
 * a single-link executable regular file. Root/admin remains the trust anchor.
 */
export function createSystemBootstrapAclProbe(
  helperPath = systemBootstrapPaths.aclHelper,
): AclProbe {
  const fixed = resolve(helperPath);
  return async (target: FileHandle): Promise<boolean> => {
    const held: FileHandle[] = [];
    try {
      if (process.platform !== 'darwin' || fixed !== helperPath || !fixed.startsWith('/')) return false;
      const parts = fixed.split('/').filter(Boolean);
      let path = '/';
      for (let index = 0; index < parts.length; index++) {
        path = join(path, parts[index] as string);
        const leaf = index === parts.length - 1;
        const before = await lstat(path);
        if (before.uid !== 0 || (before.mode & 0o022) !== 0
          || (leaf ? (!before.isFile() || before.nlink !== 1 || (before.mode & 0o111) === 0)
            : !before.isDirectory())) return false;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
          | (leaf ? 0 : constants.O_DIRECTORY) | constants.O_NONBLOCK);
        held.push(file);
        if (!await sameStat(file, path, before)) return false;
      }
      return await checkMacAcl(target, fixed) === true;
    } catch {
      return false;
    } finally {
      await Promise.all(held.map(async file => { await file.close().catch(() => undefined); }));
    }
  };
}

export interface BootstrapSourceLayout {
  readonly anchor: string;
  readonly relative: string;
  readonly ownerUid: number;
  readonly runtimeUid: number;
  readonly acl: AclProbe;
}

async function readRuntimeSecret(
  layout: BootstrapSourceLayout,
  use: (secret: string) => Promise<unknown>,
): Promise<unknown> {
  const anchor = resolve(layout.anchor);
  if (anchor !== layout.anchor || !Number.isSafeInteger(layout.runtimeUid) || layout.runtimeUid < 1) {
    throw new Error('AUTH_BLOCKED');
  }
  const parts = [...safeRelative(layout.relative), 'secrets', SECRET_FILE];
  const held: FileHandle[] = [];
  try {
    let path = anchor;
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index] as string);
      const leaf = index === parts.length - 1;
      const secretDir = index === parts.length - 2;
      const before = await lstat(path);
      const expectedUid = secretDir || leaf ? layout.runtimeUid : layout.ownerUid;
      if (before.uid !== expectedUid
        || (before.mode & (leaf ? 0o177 : secretDir ? 0o077 : 0o022)) !== 0
        || (leaf ? (!before.isFile() || before.nlink !== 1)
          : !before.isDirectory())) throw new Error('AUTH_BLOCKED');
      if (leaf && (before.size <= 0 || before.size > MAX_SECRET_BYTES)) throw new Error('AUTH_BLOCKED');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
        | (leaf ? 0 : constants.O_DIRECTORY) | constants.O_NONBLOCK);
      held.push(file);
      if (!await sameStat(file, path, before) || await layout.acl(file) !== true
        || !await sameStat(file, path, before)) throw new Error('AUTH_BLOCKED');
      if (leaf) {
        const bytes = Buffer.alloc(before.size);
        try {
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== bytes.length || !await sameStat(file, path, before)) throw new Error('AUTH_BLOCKED');
          let value = bytes.toString('utf8');
          if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('AUTH_BLOCKED');
          value = value.replace(/\r?\n$/u, '');
          if (value.length === 0) throw new Error('AUTH_BLOCKED');
          return await use(value);
        } finally {
          bytes.fill(0);
        }
      }
    }
    throw new Error('AUTH_BLOCKED');
  } catch {
    throw new Error('AUTH_BLOCKED');
  } finally {
    await Promise.all(held.map(async file => { await file.close().catch(() => undefined); }));
  }
}

/**
 * Fixed-file source contract used by the direct launchd supervisor. Review
 * candidate and its independently provisioned approved digest are separate
 * root-owned files. Core credential access stays use-only and is read only at
 * the health call boundary.
 */
export function createBootstrapFileSources(layout: BootstrapSourceLayout): {
  approval: RuntimeReviewApproval;
  candidate: RuntimeReviewCandidate;
  credentials: CoreCredentials;
} {
  const configFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.relative}/config`,
  );
  return Object.freeze({
    approval: Object.freeze({
      async expectedDigest(signal: AbortSignal): Promise<string | null> {
        try {
          if (signal.aborted) return null;
          const bytes = await configFiles.read(REVIEW_DIGEST_FILE, 128);
          if (signal.aborted) return null;
          return safeDigest(bytes);
        } catch {
          return null;
        }
      },
    }),
    candidate: Object.freeze({
      async read(signal: AbortSignal): Promise<Buffer | null> {
        try {
          if (signal.aborted) return null;
          const bytes = await configFiles.read(REVIEW_FILE, MAX_REVIEW_BYTES);
          if (signal.aborted) return null;
          return Buffer.from(bytes);
        } catch {
          return null;
        }
      },
    }),
    credentials: Object.freeze({
      async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
        return await readRuntimeSecret(layout, use) as T;
      },
    }),
  });
}

/** Production fixed paths. Construction performs no IO. */
export function createSystemBootstrapSources(): {
  acl: AclProbe;
  approval: RuntimeReviewApproval;
  candidate: RuntimeReviewCandidate;
  credentials: CoreCredentials;
} {
  const uid = process.getuid?.() ?? 0;
  const acl = createSystemBootstrapAclProbe();
  const sources = createBootstrapFileSources({
    anchor: '/',
    relative: root.slice(1),
    ownerUid: 0,
    runtimeUid: uid,
    acl,
  });
  return Object.freeze({ acl, ...sources });
}
