import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TaskId } from '@gram/domain';
import type { VerificationSnapshot } from '@gram/persistence';
import type { CommandRunner } from '@gram/shell';
import { PolicyGitAdapter } from './command-adapters.js';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'] as const;
type Entry = VerificationSnapshot['entries'][number];

export interface TaskVerificationSnapshotsOptions {
  runner: CommandRunner;
  workspaces: {
    getByTaskId(taskId: TaskId): { taskId: TaskId; linuxPath: string } | undefined;
  };
}

function failure(reason: string): Error {
  // Do not include file bytes or arbitrary Git output in errors or evidence.
  return new Error(`Verification snapshot rejected: ${reason}`);
}

function assertPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.trim() !== path ||
      isAbsolute(path) || path.startsWith('-') || /[\\:*?[\]\ufffd]/u.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw failure('unsafe repository-relative path');
  }
}

function statusPaths(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw failure('malformed Git status');
  const records = output.slice(0, -1).split('\0');
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) throw failure('malformed Git status');
    const status = record.slice(0, 2);
    if (record[2] !== ' ' || !/^[ MADRCU?!]{2}$/.test(status) ||
        status === '  ' || status === '!!' || status.includes('U') || status === 'AA' || status === 'DD') {
      throw failure('unsupported Git status');
    }
    const path = record.slice(3);
    assertPath(path);
    paths.add(path);
    // Porcelain -z emits destination first, then the unprefixed source.
    if (/[RC]/.test(status)) {
      const source = records[++index];
      if (source === undefined) throw failure('malformed Git rename status');
      assertPath(source);
      paths.add(source);
    }
  }
  return [...paths].sort();
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function fileStamp(stat: BigIntStats): string {
  return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;
}

interface CapturedEntry {
  entry: Entry;
  stamp: string;
}

function readEntry(root: string, path: string): CapturedEntry {
  assertPath(path);
  const parts = path.split('/');
  const ancestorStamps: string[] = [];
  let absolute = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) throw failure('unsafe candidate path');
    absolute = join(absolute, part);
    let stat: BigIntStats;
    try {
      stat = lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (!missing(error)) throw failure('cannot inspect candidate path');
      return { entry: { path, mode: '000000', oid: null }, stamp: `${ancestorStamps.join('/')}/absent` };
    }
    if (stat.isSymbolicLink()) throw failure('symlink path is not verifiable');
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw failure('candidate path ancestor is not a directory');
      ancestorStamps.push(identity(stat));
      continue;
    }
    if (!stat.isFile()) throw failure('candidate path is not a regular file');
    let descriptor: number;
    try {
      // NOFOLLOW protects the final component; NONBLOCK avoids a raced FIFO.
      descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw failure('candidate path changed before opening');
    }
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || fileStamp(stat) !== fileStamp(before)) throw failure('candidate file changed before reading');
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (fileStamp(before) !== fileStamp(after) || BigInt(bytes.length) !== after.size) {
        throw failure('candidate file changed during reading');
      }
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      return {
        entry: { path, mode: (after.mode & 0o100n) === 0n ? '100644' : '100755', oid },
        stamp: `${ancestorStamps.join('/')}/${fileStamp(after)}`,
      };
    } finally {
      closeSync(descriptor);
    }
  }
  throw failure('unsafe candidate path');
}

function approvedEntries(taskId: TaskId, snapshot: VerificationSnapshot, paths: readonly string[]): Entry[] {
  if (snapshot.version !== 1 || snapshot.taskId !== taskId || !SHA.test(snapshot.headSha)) {
    throw failure('snapshot task or HEAD identity is invalid');
  }
  const entries = new Map<string, Entry>();
  let previous: string | undefined;
  for (const entry of snapshot.entries) {
    assertPath(entry.path);
    if (previous !== undefined && previous >= entry.path) throw failure('snapshot paths are not sorted and unique');
    previous = entry.path;
    if (entry.mode === '000000' ? entry.oid !== null :
      !['100644', '100755'].includes(entry.mode) || typeof entry.oid !== 'string' || !SHA.test(entry.oid)) {
      throw failure('snapshot file mode or blob identity is invalid');
    }
    entries.set(entry.path, { path: entry.path, mode: entry.mode, oid: entry.oid });
  }
  if (paths.length === 0 || new Set(paths).size !== paths.length) throw failure('approved paths must be nonempty and unique');
  return paths.map((path) => {
    assertPath(path);
    const entry = entries.get(path);
    if (entry === undefined) throw failure('approved path is absent from the snapshot');
    return entry;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function committedEntries(output: string): Entry[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw failure('malformed committed diff');
  const fields = output.slice(0, -1).split('\0');
  if (fields.length % 2 !== 0) throw failure('malformed committed diff');
  const entries: Entry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const raw = fields[index];
    const path = fields[index + 1];
    if (raw === undefined || path === undefined) throw failure('malformed committed diff');
    const metadata = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/.exec(raw);
    if (metadata === null) throw failure('unsupported committed diff entry');
    assertPath(path);
    const mode = metadata[2];
    const oid = metadata[4];
    const status = metadata[5];
    if (oid === undefined) throw failure('malformed committed blob identity');
    if (mode === '000000') {
      if (status !== 'D' || oid !== ZERO_SHA) throw failure('invalid committed deletion');
      entries.push({ path, mode, oid: null });
    } else {
      if ((mode !== '100644' && mode !== '100755') || oid === ZERO_SHA || status === 'D') {
        throw failure('unsupported committed file mode or blob');
      }
      entries.push({ path, mode, oid });
    }
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Stable task-bound observations, not OS isolation against a malicious process
 * running as the same user. No file contents enter Git command logs or evidence.
 */
export class TaskVerificationSnapshots {
  constructor(private readonly options: TaskVerificationSnapshotsOptions) {}

  private workspace(taskId: TaskId): { root: string; identity: string } {
    const record = this.options.workspaces.getByTaskId(taskId);
    if (record === undefined || record.taskId !== taskId || !isAbsolute(record.linuxPath)) {
      throw failure('workspace is not registered for this task');
    }
    try {
      const root = resolve(record.linuxPath);
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || realpathSync(root) !== root) throw failure('workspace path is not canonical');
      return { root, identity: identity(stat) };
    } catch {
      throw failure('workspace path is unavailable or unsafe');
    }
  }

  private async git(taskId: TaskId, root: string, args: readonly string[]): Promise<string> {
    const result = await this.options.runner.run({ taskId, cwd: root, category: 'GIT', executable: 'git', args });
    if (result.exitCode !== 0) throw failure('Git inspection failed');
    return result.stdout;
  }

  private async assertRepositoryRoot(taskId: TaskId, root: string): Promise<void> {
    const top = await this.git(taskId, root, ['rev-parse', '--show-toplevel']);
    if (top.trim() !== root) throw failure('recorded workspace is not the repository root');
  }

  async capture(taskId: TaskId, expectedCwd?: string): Promise<VerificationSnapshot> {
    const workspace = this.workspace(taskId);
    const { root } = workspace;
    if (expectedCwd !== undefined && (!isAbsolute(expectedCwd) || resolve(expectedCwd) !== root)) {
      throw failure('verification cwd is not the registered workspace');
    }
    await this.assertRepositoryRoot(taskId, root);
    const git = new PolicyGitAdapter({ runner: this.options.runner });
    const headSha = await git.headSha(root, taskId);
    const status = await this.git(taskId, root, STATUS_ARGS);
    const paths = statusPaths(status);
    const before = paths.map((path) => readEntry(root, path));
    const afterStatus = await this.git(taskId, root, STATUS_ARGS);
    const afterHead = await git.headSha(root, taskId);
    const after = paths.map((path) => readEntry(root, path));
    if (headSha !== afterHead || status !== afterStatus || JSON.stringify(before) !== JSON.stringify(after) ||
        JSON.stringify(workspace) !== JSON.stringify(this.workspace(taskId))) {
      throw failure('workspace changed during capture');
    }
    const entries = before.map(({ entry }) => Object.freeze(entry));
    Object.freeze(entries);
    return Object.freeze({ version: 1, taskId, headSha, entries });
  }

  async assertCommitted(taskId: TaskId, snapshot: VerificationSnapshot, approvedPaths: readonly string[], sha: string): Promise<void> {
    // Copy approved proof before the first await; callers cannot race mutable input.
    const expected = approvedEntries(taskId, snapshot, approvedPaths);
    const headSha = snapshot.headSha;
    if (!SHA.test(sha)) throw failure('commit SHA is invalid');
    const workspace = this.workspace(taskId);
    const { root } = workspace;
    await this.assertRepositoryRoot(taskId, root);
    const parents = await this.git(taskId, root, ['show', '--format=%P', '--no-patch', '--no-show-signature', sha, '--']);
    if (parents.trim() !== headSha) throw failure('commit must have exactly the verified HEAD as its single parent');
    const raw = await this.git(taskId, root, [
      'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', headSha, sha, '--',
    ]);
    if (JSON.stringify(committedEntries(raw)) !== JSON.stringify(expected)) throw failure('commit differs from the approved snapshot');
    if (JSON.stringify(workspace) !== JSON.stringify(this.workspace(taskId))) throw failure('workspace changed during commit inspection');
  }
}
