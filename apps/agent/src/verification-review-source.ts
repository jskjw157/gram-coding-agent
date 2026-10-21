import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { VerificationSnapshot, WorkspaceRepository } from '@gram/persistence';
import type { SecretRedactor } from '@gram/secrets';
import type { CommandRunner } from '@gram/shell';
import { assertReviewSourcePath, REVIEW_MAX_BYTES, REVIEW_TREE_ARGS } from './verification-review-command.js';

const SHA = /^[0-9a-f]{40}$/;
type Entry = VerificationSnapshot['entries'][number];
export type ReviewFileSide =
  | { present: false; mode: '000000'; oid: null; content: null }
  | { present: true; mode: '100644' | '100755'; oid: string; content: string };
export interface ReviewFileView {
  path: string;
  before: ReviewFileSide;
  after: ReviewFileSide;
  digest: string;
}
export interface VerificationReviewSourceOptions {
  runner: CommandRunner;
  workspaces: WorkspaceRepository;
  redactor: SecretRedactor;
}

function failure(reason: string): Error { return new Error(`Review source rejected: ${reason}`); }
function absent(): ReviewFileSide { return { present: false, mode: '000000', oid: null, content: null }; }
function blob(bytes: Buffer): string { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.mode}`; }
function stamp(stat: BigIntStats): string { return `${identity(stat)}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

function copySnapshot(taskId: string, snapshot: VerificationSnapshot, path: string): { snapshot: VerificationSnapshot; entry: Entry } {
  assertReviewSourcePath(path);
  if (snapshot.version !== 1 || snapshot.taskId !== taskId || !SHA.test(snapshot.headSha) || !Array.isArray(snapshot.entries)) {
    throw failure('snapshot identity is invalid');
  }
  const entries: Entry[] = [];
  let previous: string | undefined;
  for (const entry of snapshot.entries) {
    assertReviewSourcePath(entry.path);
    if (previous !== undefined && previous >= entry.path) throw failure('snapshot paths must be sorted and unique');
    previous = entry.path;
    if (entry.mode === '000000' ? entry.oid !== null :
      !['100644', '100755'].includes(entry.mode) || typeof entry.oid !== 'string' || !SHA.test(entry.oid)) {
      throw failure('snapshot mode or blob identity is invalid');
    }
    entries.push({ path: entry.path, mode: entry.mode, oid: entry.oid });
  }
  const entry = entries.find((entry) => entry.path === path);
  if (entry === undefined) throw failure('path is not a snapshot candidate');
  return { snapshot: { version: 1, taskId, headSha: snapshot.headSha, entries }, entry };
}

interface Observation { absolute: string; file: BigIntStats | null; stamp: string }
function observe(root: string, path: string): Observation {
  let absolute = root;
  const stamps: string[] = [];
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) throw failure('source path is invalid');
    absolute = join(absolute, part);
    let stat: BigIntStats;
    try { stat = lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if (missing(error)) return { absolute, file: null, stamp: `${stamps.join('/')}/absent:${index}` };
      throw failure('cannot inspect source path');
    }
    if (stat.isSymbolicLink()) throw failure('symlink source paths are forbidden');
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw failure('source path ancestor is not a directory');
      stamps.push(identity(stat));
    } else {
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(REVIEW_MAX_BYTES)) {
        throw failure('source must be a bounded regular file without hardlinks');
      }
      return { absolute, file: stat, stamp: `${stamps.join('/')}/${stamp(stat)}` };
    }
  }
  throw failure('source path is invalid');
}

/** Exact review views only; the coordinator must still validate its whole snapshot before and after each operation. */
export class VerificationReviewSource {
  constructor(private readonly options: VerificationReviewSourceOptions) {}

  private workspace(taskId: string): { root: string; identity: string } {
    const workspace = this.options.workspaces.getByTaskId(taskId);
    if (workspace === undefined || workspace.taskId !== taskId || !isAbsolute(workspace.linuxPath)) {
      throw failure('task workspace is missing or invalid');
    }
    try {
      const root = resolve(workspace.linuxPath);
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || realpathSync(root) !== root) throw failure('workspace is not canonical');
      return { root, identity: identity(stat) };
    } catch { throw failure('workspace path is unavailable or unsafe'); }
  }

  private safeText(bytes: Buffer): string {
    if (bytes.length > REVIEW_MAX_BYTES) throw failure('source exceeds the byte bound');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw failure('source is not valid UTF-8'); }
    if ([...content].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    }) || this.options.redactor.redact(content) !== content) {
      throw failure('source is binary or contains sensitive data');
    }
    return content;
  }

  private after(root: string, expected: Entry): { side: ReviewFileSide; stamp: string } {
    const observed = observe(root, expected.path);
    if (observed.file === null) {
      if (expected.mode !== '000000' || expected.oid !== null) throw failure('source absence differs from snapshot');
      return { side: absent(), stamp: observed.stamp };
    }
    if (expected.mode === '000000') throw failure('source presence differs from snapshot');
    let descriptor: number;
    try { descriptor = openSync(observed.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw failure('source changed before opening'); }
    try {
      const initial = fstatSync(descriptor, { bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n || stamp(initial) !== stamp(observed.file)) {
        throw failure('source changed before reading');
      }
      const buffer = Buffer.alloc(REVIEW_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const final = fstatSync(descriptor, { bigint: true });
      if (length > REVIEW_MAX_BYTES || BigInt(length) !== final.size || stamp(initial) !== stamp(final) ||
          observed.stamp !== observe(root, expected.path).stamp) throw failure('source changed during bounded read');
      const bytes = buffer.subarray(0, length);
      const mode = (final.mode & 0o100n) === 0n ? '100644' : '100755';
      const oid = blob(bytes);
      if (expected.mode !== mode || expected.oid !== oid) throw failure('source mode or blob differs from snapshot');
      return { side: { present: true, mode, oid, content: this.safeText(bytes) }, stamp: observed.stamp };
    } finally { closeSync(descriptor); }
  }

  private async git(taskId: string, root: string, args: readonly string[]): Promise<string> {
    const result = await this.options.runner.run({ taskId, cwd: root, category: 'GIT', executable: 'git', args });
    if (result.exitCode !== 0) throw failure('Git object inspection failed');
    return result.stdout;
  }

  private async before(taskId: string, root: string, headSha: string, path: string): Promise<ReviewFileSide> {
    // The empty-tree comparison inspects the complete historical tree, not merely HEAD's latest change.
    // A successful empty result proves absence. No failed rev-parse/show is interpreted as absence.
    const raw = await this.git(taskId, root, [...REVIEW_TREE_ARGS, headSha, '--', path]);
    if (raw === '') return absent();
    const fields = raw.split('\0');
    if (fields.length !== 3 || fields[1] !== path || fields[2] !== '') throw failure('historical tree metadata is not one exact file');
    const match = /^:000000 (100644|100755) 0{40} ([a-f0-9]{40}) A$/.exec(fields[0] ?? '');
    if (match === null) throw failure('historical file mode or tree metadata is unsafe');
    const mode = match[1] as '100644' | '100755';
    const oid = match[2];
    if (oid === undefined) throw failure('historical blob metadata is missing');
    const resolved = await this.git(taskId, root, ['rev-parse', '--verify', `${headSha}:${path}`]);
    if (resolved !== `${oid}\n`) throw failure('historical blob identity differs from metadata');
    const content = await this.git(taskId, root, ['show', oid]);
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.toString('utf8') !== content || blob(bytes) !== oid) throw failure('historical blob identity does not match returned text');
    return { present: true, mode, oid, content: this.safeText(bytes) };
  }

  async read(taskId: string, input: VerificationSnapshot, path: string): Promise<ReviewFileView> {
    // Copy mutable proof before the first await. Returned digests cannot bind a later caller mutation.
    const { snapshot, entry } = copySnapshot(taskId, input, path);
    const workspace = this.workspace(taskId);
    const after = this.after(workspace.root, entry);
    const top = await this.git(taskId, workspace.root, ['rev-parse', '--show-toplevel']);
    if (top !== `${workspace.root}\n`) throw failure('workspace is not the repository root');
    const before = await this.before(taskId, workspace.root, snapshot.headSha, path);
    const final = this.after(workspace.root, entry);
    if (after.stamp !== final.stamp || JSON.stringify(workspace) !== JSON.stringify(this.workspace(taskId))) {
      throw failure('workspace/source changed during review');
    }
    const view = { path, before: Object.freeze(before), after: Object.freeze(after.side) };
    const digest = createHash('sha256').update(JSON.stringify({ version: 1, snapshot, view })).digest('hex');
    return Object.freeze({ ...view, digest });
  }
}
