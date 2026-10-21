import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { RUNTIME_LINKS, RUNTIME_NODE_SHA256, RUNTIME_RECEIPT } from './sandbox-runtime-contract.js';

type ManifestEntry = [string, string, number, number, string];
const validated = new Set<string>();
const fail = (): never => { throw new Error('Isolation requires a root-owned runtime with pinned provenance and contents'); };
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

export function runtimeManifestDigest(entries: ManifestEntry[]): string {
  return sha(JSON.stringify([...entries].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

export function validateRuntimeReceipt(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = value as Record<string, unknown>;
  if (Object.keys(actual).length !== Object.keys(RUNTIME_RECEIPT).length ||
      Object.entries(RUNTIME_RECEIPT).some(([key, expected]) => actual[key] !== expected)) fail();
}

function readTrustedFile(file: string, limit: number): Buffer {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o644 && (before.mode & 0o777) !== 0o755 ||
        (before.mode & 0o7000) !== 0 || before.size > limit || realpathSync(`/proc/self/fd/${descriptor}`) !== file) fail();
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink) fail();
    return bytes;
  } finally { closeSync(descriptor); }
}

/** The installer and this independent reader share only pinned constants and
 * canonical encoding. No user-owned toolchain or self-attested tree is trusted. */
export function assertTrustedRuntime(root: string): void {
  if (!isAbsolute(root) || realpathSync(root) !== root) fail();
  for (let directory = root; ; directory = dirname(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail();
    if (directory === '/') break;
  }
  const receiptPath = join(root, 'installation.json');
  validateRuntimeReceipt(JSON.parse(readTrustedFile(receiptPath, 4096).toString('utf8')));
  const receipt = lstatSync(receiptPath), directory = lstatSync(root), node = lstatSync(join(root, 'bin/node'));
  if ((receipt.mode & 0o7777) !== 0o644 || (directory.mode & 0o7777) !== 0o755) fail();
  const identity = JSON.stringify([root, directory.dev, directory.ino, directory.ctimeMs, receipt.ino, receipt.ctimeMs, node.ino, node.ctimeMs]);
  if (validated.has(identity)) return;
  const entries: ManifestEntry[] = [];
  let total = 0;
  const visit = (relative: string): void => {
    if (!relative || relative.length > 1024 || /[^\x21-\x7e]|[\\"]/u.test(relative) ||
        relative.split('/').some((part) => part === '' || part === '.' || part === '..')) fail();
    if (entries.length >= 20_000) fail();
    const file = join(root, relative), stat = lstatSync(file), mode = stat.mode & 0o7777;
    if (stat.uid !== 0 || stat.nlink !== 1 && !stat.isDirectory()) fail();
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      if (RUNTIME_LINKS[relative as keyof typeof RUNTIME_LINKS] !== target || mode !== 0o777 ||
          !realpathSync(file).startsWith(root + '/')) fail();
      entries.push([relative, 'symlink', mode, Buffer.byteLength(target), target]);
    } else if (stat.isDirectory()) {
      if (mode !== 0o755) fail();
      entries.push([relative, 'directory', mode, 0, '']);
      for (const name of readdirSync(file)) visit(relative + '/' + name);
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > 512 * 1024 * 1024) fail();
      const bytes = readTrustedFile(file, 160 * 1024 * 1024);
      const native = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      if (relative !== 'bin/node' && (native || bytes.subarray(0, 2).toString() === 'MZ')) fail();
      const executable = relative === 'bin/node' || bytes.subarray(0, 20).toString() === '#!/usr/bin/env node\n' ||
        bytes.subarray(0, 21).toString() === '#!/usr/bin/env node\r\n';
      if (mode !== (executable ? 0o755 : 0o644)) fail();
      const digest = sha(bytes);
      if (relative === 'bin/node' && (!native || digest !== RUNTIME_NODE_SHA256 || sha(readFileSync(process.execPath)) !== digest)) fail();
      entries.push([relative, 'file', mode, bytes.length, digest]);
    } else fail();
  };
  for (const name of readdirSync(root)) if (name !== 'installation.json') visit(name);
  if (entries.length !== RUNTIME_RECEIPT.fileCount || runtimeManifestDigest(entries) !== RUNTIME_RECEIPT.treeSha256) fail();
  // Every admitted inode and ancestor is root-owned and non-writable by the
  // controller/workers. Runtime upgrades use a new tree and service restart.
  validated.add(identity);
}
