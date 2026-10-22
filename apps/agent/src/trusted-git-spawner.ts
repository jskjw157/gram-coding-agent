import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretProvider } from '@gram/secrets';
import type { ProcessSpawner, SpawnRequest, SpawnResult } from '@gram/shell';
import { assertTrustedRuntime, RUNTIME_ROOT } from '@gram/shell';
import { createLocalGitSnapshot, type LocalGitSnapshotSource } from './local-git-read-snapshot.js';

export interface TrustedGitContext {
  basePath: string;
  worktreePath?: string;
  owner: string;
  name: string;
  defaultBranch?: string;
}
export interface TrustedGitSpawnerOptions {
  contextForTask(taskId: string): TrustedGitContext | Promise<TrustedGitContext>;
  secrets: SecretProvider;
  execution?: TrustedGitExecutionOptions;
}
export interface TrustedGitExecutionOptions {
  timeoutMs?: number; maxOutputBytes?: number; strictUtf8?: boolean;
  onQuarantine?: () => void;
}
const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_/-]*$/;
const environment = (): Record<string, string> => ({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C.UTF-8',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_ALLOW_PROTOCOL: 'https',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_OPTIONAL_LOCKS: '0',
});
const fixedConfig = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'http.followRedirects=false',
  '-c',
  'credential.helper=',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
];
function reject(): never {
  throw new Error('Trusted Git request rejected');
}
const controls = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith('-') &&
    !/[\\:*?[\]]/u.test(value) &&
    !controls(value) &&
    value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git')
  );
}
function branch(value: string): boolean {
  return REF.test(value) && !value.endsWith('/') && !value.includes('//');
}
const equal = (args: readonly string[], expected: readonly string[]): boolean =>
  args.length === expected.length && args.every((arg, i) => arg === expected[i]);
function validateArgs(args: readonly string[], context: TrustedGitContext, cwd: string, url: string): boolean {
  if (args.some((arg) => arg.includes('\0'))) reject();
  if (
    equal(args, ['rev-parse', 'HEAD']) ||
    equal(args, ['rev-parse', '--show-toplevel']) ||
    equal(args, ['rev-parse', '--abbrev-ref', 'HEAD']) ||
    equal(args, ['branch', '--format=%(refname:short)'])
  )
    return false;
  if (
    equal(args, ['status', '--porcelain=v1', '-z']) ||
    equal(args, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  )
    return false;
  if (args.length === 2 && args[0] === 'show' && SHA.test(args[1] ?? '')) return false;
  if (
    args.length === 3 &&
    args[0] === 'rev-parse' &&
    args[1] === '--verify' &&
    SHA.test((args[2] ?? '').slice(0, 40)) &&
    (args[2] ?? '')[40] === ':' &&
    safePath((args[2] ?? '').slice(41))
  )
    return false;
  if (args[0] === 'add' && args[1] === '--' && args.length > 2 && args.slice(2).every(safePath)) return false;
  if (
    args[0] === 'commit' &&
    args[1] === '--only' &&
    args[2] === '-m' &&
    args[4] === '--' &&
    args.length > 5 &&
    (args[3] ?? '').length <= 4096 &&
    args.slice(5).every(safePath)
  )
    return false;
  if (
    args.length === 6 &&
    equal(args.slice(0, 4), ['show', '--format=%P', '--no-patch', '--no-show-signature']) &&
    SHA.test(args[4] ?? '') &&
    args[5] === '--'
  )
    return false;
  const committed = [
    'diff',
    '--raw',
    '-z',
    '--no-renames',
    '--no-abbrev',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
  ];
  if (
    args.length === committed.length + 3 &&
    committed.every((arg, i) => args[i] === arg) &&
    SHA.test(args[committed.length] ?? '') &&
    SHA.test(args[committed.length + 1] ?? '') &&
    args[committed.length + 2] === '--'
  )
    return false;
  const deleted = [
    'diff',
    '--name-only',
    '--diff-filter=D',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
  ];
  if (
    args.length > deleted.length &&
    deleted.every((arg, i) => args[i] === arg) &&
    args.slice(deleted.length).every(safePath)
  )
    return false;
  const tree = [
    'diff',
    '--raw',
    '-z',
    '--no-renames',
    '--no-abbrev',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--no-relative',
    '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  ];
  if (
    args.length === tree.length + 3 &&
    tree.every((arg, i) => args[i] === arg) &&
    SHA.test(args[tree.length] ?? '') &&
    args[tree.length + 1] === '--' &&
    safePath(args[tree.length + 2] ?? '')
  )
    return false;
  if (
    equal(args, ['diff', '--']) ||
    (args.length === 3 && args[0] === 'diff' && SHA.test(args[1] ?? '') && args[2] === '--')
  )
    return false;
  if (
    args.length === 6 &&
    args[0] === 'worktree' &&
    args[1] === 'add' &&
    args[2] === '-b' &&
    branch(args[3] ?? '') &&
    args[4] === context.worktreePath &&
    (SHA.test(args[5] ?? '') ||
      (context.defaultBranch !== undefined &&
        branch(context.defaultBranch) &&
        args[5] === `origin/${context.defaultBranch}`)) &&
    cwd === context.basePath
  )
    return false;
  if (
    context.worktreePath &&
    cwd === context.basePath &&
    (equal(args, ['worktree', 'remove', '--force', context.worktreePath]) || equal(args, ['worktree', 'prune']))
  )
    return false;
  if (equal(args, ['fetch', 'origin']) || equal(args, ['fetch', '--prune', 'origin'])) return true;
  if (
    args.length === 3 &&
    args[0] === 'push' &&
    args[1] === 'origin' &&
    SHA.test((args[2] ?? '').slice(0, 40)) &&
    (args[2] ?? '').slice(40, 52) === ':refs/heads/' &&
    branch((args[2] ?? '').slice(52))
  )
    return true;
  if (
    args.length === 3 &&
    args[0] === 'ls-remote' &&
    (args[1] === 'origin' || args[1] === url || args[1] === url.slice(0, -4)) &&
    (args[2] ?? '').startsWith('refs/heads/') &&
    branch((args[2] ?? '').slice(11))
  )
    return true;
  return reject();
}
async function regular(file: string): Promise<void> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) reject();
}
async function metadata(context: TrustedGitContext, cwd: string): Promise<void> {
  if ((await realpath(context.basePath)) !== context.basePath || (await realpath(cwd)) !== cwd) reject();
  const common = path.join(context.basePath, '.git');
  if (!(await lstat(common)).isDirectory() || (await realpath(common)) !== common) reject();
  if (cwd !== context.basePath) {
    const pointer = path.join(cwd, '.git');
    await regular(pointer);
    const value = (await readFile(pointer, 'utf8')).trim();
    if (!value.startsWith('gitdir: ')) reject();
    const target = value.slice(8);
    if (
      !target.startsWith(common + '/worktrees/') ||
      (await realpath(target)) !== target ||
      path.dirname(target) !== common + '/worktrees'
    )
      reject();
    await regular(path.join(target, 'commondir'));
    if (path.resolve(target, (await readFile(path.join(target, 'commondir'), 'utf8')).trim()) !== common) reject();
    await regular(path.join(target, 'gitdir'));
    if ((await readFile(path.join(target, 'gitdir'), 'utf8')).trim() !== pointer) reject();
  }
  await regular(path.join(common, 'config'));
  for (const relative of ['objects/info/alternates', 'objects/info/http-alternates', 'config.worktree']) {
    try {
      await lstat(path.join(common, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    reject();
  }
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function liveGroup(group: number): Promise<boolean> {
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry}/stat`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
        continue;
      throw error;
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Zombies cannot execute or retain descriptors; their reaping belongs to init.
    if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') return true;
  }
  return false;
}
async function observedLiveGroup(group: number, quarantine: () => void): Promise<boolean> {
  for (;;) {
    try {
      return await liveGroup(group);
    } catch {
      // Unreadable process evidence is not proof of quiescence.
      quarantine();
      await delay(50);
    }
  }
}
async function signalGroup(group: number, signal: NodeJS.Signals, quarantine: () => void): Promise<void> {
  for (;;) {
    try {
      process.kill(-group, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      // Retain the operation and credential lease if termination is not proven.
      quarantine();
      if (!(await observedLiveGroup(group, quarantine))) return;
      await delay(50);
    }
  }
}
/** Fixed executable supervisor. Public command admission lives in the spawner;
 * exported separately for real subprocess lifetime tests, not an MCP port. */
export async function superviseTrustedGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  options: TrustedGitExecutionOptions = {},
): Promise<SpawnResult> {
  return superviseFixedGit('git', cwd, args, env, options);
}
async function superviseFixedGit(
  kind: 'git' | 'read-only-namespace' | 'dependencies', cwd: string, args: readonly string[], env: Record<string, string>,
  options: TrustedGitExecutionOptions,
): Promise<SpawnResult> {
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) reject();
  let reported = false;
  const quarantine = (): void => {
    if (reported) return;
    reported = true;
    try {
      if (options.onQuarantine) options.onQuarantine();
      else writeSync(2, 'Trusted Git cleanup quarantined: retaining operation and credential lease until process quiescence is proven.\n');
    } catch { /* A diagnostic failure cannot release credentials or settle the operation. */ }
  };
  const executable = kind === 'git' ? '/usr/bin/git' : kind === 'dependencies' ? '/usr/bin/ldd' : '/usr/bin/bwrap';
  const child = spawn(executable, [...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  let exitCode = 1;
  let finish: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closed: () => void = () => {};
  const close = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const capture = (chunk: Buffer, output: boolean): void => {
    bytes += chunk.length;
    if (bytes > limit) {
      failed = true;
      finish();
      return;
    }
    if (failed) return;
    if (output) stdout.push(chunk);
    else stderr.push(chunk);
  };
  child.stdout.on('error', () => {
    failed = true;
    finish();
  });
  child.stderr.on('error', () => {
    failed = true;
    finish();
  });
  child.stdout.on('data', (chunk: Buffer) => capture(chunk, true));
  child.stderr.on('data', (chunk: Buffer) => capture(chunk, false));
  child.on('error', () => {
    failed = true;
    finish();
  });
  child.on('close', (code) => {
    exitCode = code ?? 1;
    closed();
    finish();
  });
  const timer = setTimeout(() => {
    failed = true;
    finish();
  }, timeoutMs);
  await stop;
  clearTimeout(timer);
  const group = child.pid;
  if (group !== undefined) {
    if (await observedLiveGroup(group, quarantine)) {
      await signalGroup(group, 'SIGTERM', quarantine);
      const deadline = Date.now() + 200;
      while ((await observedLiveGroup(group, quarantine)) && Date.now() < deadline) await delay(20);
      if (await observedLiveGroup(group, quarantine)) await signalGroup(group, 'SIGKILL', quarantine);
      // No result or credential disposal while executable descendants remain.
      // A kernel-stuck task intentionally leaves this operation pending.
      const quarantineAfter = Date.now() + 1000;
      while (await observedLiveGroup(group, quarantine)) {
        if (Date.now() >= quarantineAfter) quarantine();
        await delay(50);
      }
    }
  }
  await close;
  if (failed) throw new Error('Trusted Git execution failed');
  const decode = (chunks: Buffer[]): string => {
    const buffer = Buffer.concat(chunks);
    if (!options.strictUtf8) return buffer.toString('utf8');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw new Error('Trusted Git output is not valid UTF-8'); }
  };
  return { exitCode, stdout: decode(stdout), stderr: decode(stderr) };
}
function validateConfig(output: string, url: string): void {
  let originCount = 0;
  for (const record of output.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n');
    if (separator < 1) reject();
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1);
    if (key === 'remote.origin.url') {
      if (value !== url && value !== url.slice(0, -4)) reject();
      originCount++;
      continue;
    }
    if (key === 'remote.origin.fetch' && value === '+refs/heads/*:refs/remotes/origin/*') continue;
    if (key === 'core.repositoryformatversion' && value === '0') continue;
    if (
      ['core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks'].includes(key) &&
      ['true', 'false'].includes(value)
    )
      continue;
    if (key === 'core.bare' && value === 'false') continue;
    if (['user.name', 'user.email'].includes(key) && value.length > 0 && value.length < 512 && !controls(value))
      continue;
    if (/^branch\.[a-z0-9_/-]+\.remote$/.test(key) && value === 'origin') continue;
    if (/^branch\.[a-z0-9_/-]+\.merge$/.test(key) && value.startsWith('refs/heads/') && branch(value.slice(11)))
      continue;
    reject();
  }
  if (originCount !== 1) reject();
}

export type TrustedLocalGitRead =
  | { operation: 'identity' | 'status' | 'head' | 'tracked' }
  | { operation: 'diff'; staged: boolean; relativePath?: string }
  | { operation: 'log'; maxCount: number };

export interface TrustedLocalGitReadOptions { snapshotDirectory: string; source: LocalGitSnapshotSource }
async function trustedReadExecutable(file: string): Promise<void> {
  if (await realpath(file) !== file) reject();
  const st = await lstat(file);
  if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o6022) !== 0 || (st.mode & 0o111) === 0) reject();
  for (let parent = path.dirname(file);; parent = path.dirname(parent)) {
    const directory = await lstat(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) reject();
    if (parent === '/') break;
  }
}
async function readonlyGitLibraries(): Promise<string[]> {
  await trustedReadExecutable('/usr/bin/ldd');
  const mounts = new Map<string, string>();
  for (const executable of ['/usr/bin/git', '/usr/local/libexec/gram-sandbox-entry']) {
    const result = await superviseFixedGit('dependencies', '/', [executable], { PATH: '/usr/bin:/bin', LANG: 'C' },
      { strictUtf8: true, maxOutputBytes: 65536, timeoutMs: 10000 });
    if (result.exitCode !== 0) reject();
    for (const line of result.stdout.split('\n').map(value => value.trim()).filter(Boolean)) {
      if (/^linux-vdso\.so\.1 \(0x[a-f0-9]+\)$/u.test(line)) continue;
      const match = /^(?:[^\s]+ => )?(\/(?:usr\/lib[^/]*|lib[^/]*)\/[^\s]+) \(0x[a-f0-9]+\)$/u.exec(line);
      const target = match?.[1];if (!target || path.normalize(target) !== target) reject();
      const source = await realpath(target);const st = await lstat(source);
      if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o6022) !== 0) reject();
      for (let parent = path.dirname(source);; parent = path.dirname(parent)) {
        const directory = await lstat(parent);
        if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) reject();
        if (parent === '/') break;
      }
      mounts.set(target, source);if (mounts.size > 32) reject();
    }
  }
  if (mounts.size === 0) reject();
  return [...mounts].flatMap(([target, source]) => ['--ro-bind', source, target]);
}
/** A fixed read-only namespace over a complete private native-broker capture.
 * Live project/config/object paths never enter Git's execution namespace. */
export async function readTrustedLocalGit(basePath: string, request: TrustedLocalGitRead, options: TrustedLocalGitReadOptions): Promise<SpawnResult & { owner: string; name: string }> {
  let snapshot: Awaited<ReturnType<typeof createLocalGitSnapshot>> | undefined;
  try {
    if (!options || !path.isAbsolute(basePath) || process.platform !== 'linux' || process.arch !== 'x64') reject();
    let args: string[];
    if (request.operation === 'identity') args = [];
    else if (request.operation === 'head') args = ['rev-parse', '--verify', 'HEAD'];
    else if (request.operation === 'tracked') args = ['ls-files', '-v', '-z'];
    else if (request.operation === 'status') args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'];
    else if (request.operation === 'diff') {
      if (typeof request.staged !== 'boolean' || (request.relativePath !== undefined && !safePath(request.relativePath))) reject();
      args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color',
        ...(request.staged ? ['--cached'] : []), '--', ...(request.relativePath === undefined ? [] : [request.relativePath])];
    } else if (request.operation === 'log') {
      if (!Number.isSafeInteger(request.maxCount) || request.maxCount < 1 || request.maxCount > 100) reject();
      args = ['log', '--format=%H%x00%s%x00', `--max-count=${request.maxCount}`, '--no-show-signature', '--no-decorate', '--'];
    } else reject();
    snapshot = await createLocalGitSnapshot(options.source, options.snapshotDirectory);
    const env = environment();
    const execution = { strictUtf8: true, maxOutputBytes: 1024 * 1024, timeoutMs: 10_000 };
    // Parsing a private regular config with --no-includes does not execute it.
    // It is replaced by synthesized configuration before any repository read.
    await trustedReadExecutable('/usr/bin/git');
    const configPath = path.join(snapshot.workspace, '.git/config');
    const config = await superviseTrustedGit(snapshot.workspace, ['config', '--no-includes', '--file', configPath, '--null', '--list'], env, execution);
    if (config.exitCode !== 0) reject();
    const origins = config.stdout.split('\0').filter(value => value.startsWith('remote.origin.url\n'));
    if (origins.length !== 1) reject();
    const origin = origins[0]?.slice('remote.origin.url\n'.length) ?? '';
    const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)\/?(?:\.git)?$/u.exec(origin);
    const owner = match?.[1], name = match?.[2];
    if (!owner || !name || name === '.' || name === '..') reject();
    validateConfig(config.stdout, `https://github.com/${owner}/${name}.git`);
    if (args.length === 0) return { owner, name, exitCode: 0, stdout: '', stderr: '' };
    let safeConfig = '[core]\nrepositoryformatversion = 0\nbare = false\n';
    for (const field of config.stdout.split('\0')) {
      const match = /^core\.(filemode|ignorecase|precomposeunicode|symlinks)\n(true|false)$/u.exec(field);
      if (match) safeConfig += `${match[1]} = ${match[2]}\n`;
    }
    await writeFile(configPath, safeConfig, { mode: 0o600 });
    const entry = '/usr/local/libexec/gram-sandbox-entry';
    for (const executable of ['/usr/bin/git', '/usr/bin/bwrap', entry]) await trustedReadExecutable(executable);
    assertTrustedRuntime(RUNTIME_ROOT);
    const namespace = ['--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
      '--disable-userns', '--uid', String(process.getuid?.()), '--gid', String(process.getgid?.()),
      '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
      '--ro-bind', '/usr/bin/git', '/usr/bin/git', ...await readonlyGitLibraries(),
      '--ro-bind', RUNTIME_ROOT, '/runtime', '--ro-bind', entry, '/gram-sandbox-entry',
      '--ro-bind', snapshot.workspace, '/workspace', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--tmpfs', '/home/gram-sandbox', '--dir', '/run', '--chdir', '/workspace'];
    for (const [key, value] of Object.entries({ ...env, HOME: '/home/gram-sandbox', GIT_DIR: '/workspace/.git',
      GIT_WORK_TREE: '/workspace', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', OPENSSL_CONF: '/dev/null' })) {
      namespace.push('--setenv', key, value);
    }
    namespace.push('--', '/gram-sandbox-entry', '/workspace', '/runtime', '--', '/usr/bin/git', '--no-pager', ...fixedConfig, ...args);
    const result = await superviseFixedGit('read-only-namespace', '/', namespace, {}, execution);
    if (result.exitCode !== 0) reject();
    return { owner, name, ...result };
  } catch { throw new Error('Trusted local Git denied or failed'); }
  finally {await snapshot?.close();}
}
/** Construct only for fixed application Git adapters. Never select this port by
 * an untrusted ordinary command's category. Metadata is controller-owned and
 * inaccessible for mutation by the ordinary sandbox; concurrent trusted edits
 * remain outside this admission check's security guarantee. */
export class TrustedGitSpawner implements ProcessSpawner {
  constructor(private readonly options: TrustedGitSpawnerOptions) {}
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (
      request.category !== 'GIT' ||
      'shellText' in request ||
      request.executable !== 'git' ||
      !/^[A-Za-z0-9_-]+$/.test(request.taskId)
    )
      reject();
    const context = await this.options.contextForTask(request.taskId);
    if (!context || !/^[A-Za-z0-9_-]+$/.test(context.owner) || !/^[A-Za-z0-9_.-]+$/.test(context.name)) reject();
    if (request.cwd !== context.basePath && request.cwd !== context.worktreePath) reject();
    const url = `https://github.com/${context.owner}/${context.name}.git`;
    const network = validateArgs(request.args, context, request.cwd, url);
    await metadata(context, request.cwd);
    if (request.args[0] === 'worktree' && request.args[1] === 'remove') {
      if (!context.worktreePath || context.worktreePath === context.basePath) reject();
      await metadata(context, context.worktreePath);
    }
    if (equal(request.args, ['worktree', 'prune'])) {
      const folder = path.join(context.basePath, '.git', 'worktrees');
      const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        const pointer = path.join(folder, entry, 'gitdir');
        await regular(pointer);
        const target = (await readFile(pointer, 'utf8')).trim();
        // A global Git prune is admitted only when no unrelated stale entry
        // can be removed. The caller's exact registered target is the exception.
        if (target !== path.join(context.worktreePath ?? '', '.git')) await lstat(target);
      }
    }
    const env = environment();
    const config = await superviseTrustedGit(
      request.cwd,
      ['config', '--no-includes', '--local', '--null', '--list'],
      env,
      this.options.execution,
    );
    if (config.exitCode !== 0) reject();
    validateConfig(config.stdout, url);
    // RemoteService confirms pushes using the fixed origin alias. Resolve it only
    // after metadata/config admission, and never pass a mutable alias to transport.
    const admittedArgs = request.args[0] === 'ls-remote' && request.args[1] === 'origin'
      ? ['ls-remote', url, request.args[2] ?? '']
      : request.args;
    const args = [...fixedConfig, ...admittedArgs];
    // These options are command-specific and cannot be supplied as global flags.
    if (request.args[0] === 'diff' || request.args[0] === 'show')
      args.splice(fixedConfig.length + 1, 0, '--no-ext-diff', '--no-textconv');
    if (!network) return superviseTrustedGit(request.cwd, args, env, this.options.execution);
    return superviseAuthenticatedGit(request.cwd, args, env, this.options.secrets, this.options.execution);
  }
}

/** Internal credential transport; callers must admit the exact fixed Git operation first. */
export async function superviseAuthenticatedGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  secrets: SecretProvider,
  options: TrustedGitExecutionOptions = {},
): Promise<SpawnResult> {
  const lease = await secrets.getForUse('github.token');
  let token = '';
  let encoded = '';
  let header = '';
  try {
    lease.withValue((value) => {
      if (!value || /[\r\n\0]/u.test(value)) reject();
      token = value;
      encoded = Buffer.from(`x-access-token:${value}`).toString('base64');
      header = `AUTHORIZATION: basic ${encoded}`;
    });
    const result = await superviseTrustedGit(
      cwd,
      ['--config-env=http.https://github.com/.extraheader=GRAM_GIT_AUTH_HEADER', ...args],
      { ...env, GRAM_GIT_AUTH_HEADER: header },
      options,
    );
    const redact = (text: string): string =>
      [header, encoded, token].reduce((value, secret) => value.split(secret).join('[REDACTED]'), text);
    return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  } finally {
    lease.dispose();
    token = '';
    encoded = '';
    header = '';
  }
}
