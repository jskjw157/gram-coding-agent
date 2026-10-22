import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, statfsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { NativeWorkspaceOperation, NativeWorkspaceReply, NativeWorkspaceRequest, NativeWorkspaceTransport } from './windows-workspace-client.js';
import { NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError, parseNativeWorkspaceReply, validateNativeWorkspaceOperation } from './windows-workspace-client.js';

interface Artifact { path: string; sha256: string }
interface Options {
  rootPath: string;
  recoveryBase: string;
  recoveryRoot: { path: string; identity: string };
  artifacts: { bubblewrap: Artifact; node: Artifact; entry: Artifact; worker: Artifact; native: Artifact };
  onCapture?: (directory: string) => void;
}
const INPUT_LIMIT = 3 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const PRIVATE = '/run/gram-owner-fs';
const LIBEXEC = '/usr/local/libexec';
const deny = () => new NativeWorkspaceDeniedError();
function canonicalText(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path &&
    !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function contains(parent: string, child: string): boolean { return parent === child || child.startsWith(`${parent}/`); }
/** Preserve Landlock's actual ancestor chain; aliases and nested mounts require
 * separate filesystem-specific proof and are unsupported by this profile. */
export function assertOriginalMountTopology(rootPath: string, mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')): void {
  const mounts = mountinfo.trim().split('\n').map(line => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    const id = fields[0], parentId = fields[1], device = fields[2];
    const root = fields[3], point = fields[4], source = fields[separator + 2];
    if (separator < 6 || root === undefined || point === undefined || source === undefined ||
        id === undefined || !/^[1-9]\d*$/u.test(id) || parentId === undefined || !/^\d+$/u.test(parentId) ||
        device === undefined || !/^\d+:\d+$/u.test(device) || fields.length < separator + 4) throw deny();
    const decode = (value: string) => value.replace(/\\(040|011|012|134)/gu,
      (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    return { id, parentId, device, root: decode(root), point: decode(point), source: decode(source) };
  });
  const mainRoots = mounts.filter(mount => mount.point === '/');
  const main = mainRoots[0];
  if (mainRoots.length !== 1 || main === undefined || main.root !== '/' ||
      new Set(mounts.map(mount => mount.id)).size !== mounts.length) throw deny();
  const governing = mounts.filter(mount => mount.point === '/' || contains(mount.point, rootPath))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (governing === undefined || governing.root !== '/' ||
      mounts.some(mount => mount.point !== rootPath && contains(rootPath, mount.point))) throw deny();
  // A bind of the entire filesystem also reports root '/'. Only the canonical
  // main root may have aliases elsewhere. An additional volume is supported
  // only when its device/root pair has exactly one mount instance.
  if (governing.id !== main.id && mounts.filter(mount =>
    mount.device === governing.device && mount.root === governing.root).length !== 1) throw deny();
}
function artifactPin(value: Artifact): boolean {
  return canonicalText(value.path) && /^[a-f0-9]{64}$/u.test(value.sha256);
}
function trustedAncestors(path: string): void {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const st = lstatSync(parent, { bigint: true });
    // A root-owned sticky directory cannot rename another owner's child.
    if (!st.isDirectory() || st.uid !== 0n || ((st.mode & 0o022n) !== 0n && (st.mode & 0o1000n) === 0n)) throw deny();
    if (parent === '/') break;
  }
}
function assertArtifact(value: Artifact): void {
  trustedAncestors(value.path);
  const fd = openSync(value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
        before.size > 256n * 1024n * 1024n || realpathSync(value.path) !== value.path) throw deny();
    const hash = createHash('sha256').update(readFileSync(fd)).digest('hex');
    const after = fstatSync(fd, { bigint: true });
    if (hash !== value.sha256 || ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs']
      .some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw deny();
  } finally { closeSync(fd); }
}

/** One trusted configured ext4 root, fixed executables, fixed argv and env.
 * The controller owns durable quarantine and recovery reconciliation. */
export class FixedPosixWorkspaceTransport implements NativeWorkspaceTransport {
  private readonly options: Options;
  private quarantined = false;
  constructor(options: Options) {
    if (!canonicalText(options.rootPath) || options.rootPath === '/' ||
        ['/usr', '/bin', '/lib', '/lib64', '/proc', '/dev', '/run', '/tmp'].some(path => contains(path, options.rootPath)) ||
        !canonicalText(options.recoveryBase) || options.recoveryBase === '/' || contains(options.rootPath, options.recoveryBase) ||
        !canonicalText(options.recoveryRoot.path) || options.recoveryRoot.path === '/' || contains(options.rootPath, options.recoveryRoot.path) ||
        contains(options.recoveryRoot.path, options.rootPath) || !/^\d+:\d+$/u.test(options.recoveryRoot.identity) ||
        contains(options.recoveryRoot.path, options.recoveryBase) || contains(options.recoveryBase, options.recoveryRoot.path) ||
        Object.values(options.artifacts).some(value => !artifactPin(value) || contains(options.rootPath, value.path))) throw deny();
    this.options = { ...options, recoveryRoot: Object.freeze({ ...options.recoveryRoot }), artifacts: Object.fromEntries(Object.entries(options.artifacts)
      .map(([key, value]) => [key, Object.freeze({ ...value })])) as Options['artifacts'] };
  }

  async run(request: NativeWorkspaceRequest): Promise<unknown> {
    const mutation = ['write', 'move', 'mkdir', 'trash', 'restore'].includes(request.operation);
    if (this.quarantined && mutation) throw new NativeWorkspaceUnresolvedError();
    let rootFd: number | undefined;
    let capture: string | undefined;
    let launched = false;
    try {
      const owner = process.getuid?.();
      if (process.platform !== 'linux' || owner === undefined || owner === 0 || request.root !== this.options.rootPath ||
          !['list', 'stat', 'read', 'treeStat', 'write', 'move', 'mkdir', 'trash', 'restore'].includes(request.operation)) throw deny();
      assertOriginalMountTopology(request.root);
      for (const artifact of Object.values(this.options.artifacts)) assertArtifact(artifact);
      rootFd = openSync(request.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const root = fstatSync(rootFd, { bigint: true });
      if (!root.isDirectory() || realpathSync(request.root) !== request.root ||
          statfsSync(`/proc/self/fd/${rootFd}`, { bigint: true }).type !== 0xef53n) throw deny();
      const expectedRoot = `${root.dev}:${root.ino}`;
      if (mutation && request.expectedRootIdentity !== expectedRoot) throw deny();
      const vault = lstatSync(this.options.recoveryRoot.path, { bigint: true });
      if (!vault.isDirectory() || vault.uid !== BigInt(owner) || (vault.mode & 0o7777n) !== 0o700n ||
          `${vault.dev}:${vault.ino}` !== this.options.recoveryRoot.identity || vault.dev !== root.dev ||
          realpathSync(this.options.recoveryRoot.path) !== this.options.recoveryRoot.path) throw deny();
      const base = lstatSync(this.options.recoveryBase, { bigint: true });
      if (!base.isDirectory() || base.uid !== BigInt(owner) || (base.mode & 0o7777n) !== 0o700n ||
          realpathSync(this.options.recoveryBase) !== this.options.recoveryBase ||
          statfsSync(this.options.recoveryBase, { bigint: true }).type !== 0xef53n) throw deny();
      const input = JSON.stringify({ ...request,
        ...(['write', 'trash', 'restore'].includes(request.operation) ? {
          recoveryRoot: this.options.recoveryRoot.path, expectedRecoveryRootIdentity: this.options.recoveryRoot.identity,
        } : {}),
      });
      if (request.recoveryRoot !== undefined && (request.recoveryRoot !== this.options.recoveryRoot.path ||
          request.expectedRecoveryRootIdentity !== this.options.recoveryRoot.identity)) throw deny();
      if (Buffer.byteLength(input) > INPUT_LIMIT) throw deny();
      capture = mkdtempSync(join(this.options.recoveryBase, 'capture-'));
      mkdirSync(join(capture, 'recovery'), { mode: 0o700 });
      this.options.onCapture?.(capture);
      const a = this.options.artifacts;
      const masks: string[] = [];
      for (const path of request.protectedPaths) {
        if (!path || path === '.' || posix.isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') ||
            path.includes('\\') || Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw deny();
        const target = join(request.root, path);
        try {
          const st = lstatSync(target);
          if (st.isSymbolicLink() || realpathSync(target) !== target) throw deny();
          if (st.isDirectory()) masks.push('--tmpfs', target);
          else if (st.isFile()) masks.push('--ro-bind', '/dev/null', target);
          else throw deny();
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--bind', '/', '/',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--dir', PRIVATE,
        '--bind', capture, `${PRIVATE}/home`, '--dir', `${PRIVATE}/runtime`, '--dir', `${PRIVATE}/runtime/bin`,
        '--ro-bind', a.node.path, `${PRIVATE}/runtime/bin/node`, '--tmpfs', LIBEXEC,
        '--ro-bind', a.entry.path, `${LIBEXEC}/gram-owner-fs-entry`,
        '--ro-bind', a.native.path, `${LIBEXEC}/gram-owner-fs-native`,
        '--ro-bind', a.worker.path, `${LIBEXEC}/gram-owner-fs-worker.mjs`,
        ...masks,
        '--clearenv', '--chdir', request.root, `${LIBEXEC}/gram-owner-fs-entry`, request.root,
        `${PRIVATE}/runtime`, '--', `${PRIVATE}/runtime/bin/node`, `${LIBEXEC}/gram-owner-fs-worker.mjs`, request.root, this.options.recoveryRoot.path];
      // Read the root path immediately before spawn; never bind this selected
      // directory as mount root, which would retain moved-parent authority.
      const current = lstatSync(request.root, { bigint: true });
      if (current.dev !== root.dev || current.ino !== root.ino || realpathSync(request.root) !== request.root) throw deny();
      const response = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(a.bubblewrap.path, args, { cwd: '/', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        launched = child.pid !== undefined;
        let failed = false;let size = 0;const chunks: Buffer[] = [];
        const fail = () => { failed = true;chunks.length = 0;child.kill('SIGKILL'); };
        const timer = setTimeout(fail, 20000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > OUTPUT_LIMIT) fail();else if (!failed) chunks.push(chunk);
        });
        child.stderr.on('data', fail);
        child.stdin.on('error', fail);
        child.on('error', fail);
        child.on('close', code => {
          clearTimeout(timer);
          if (failed || code !== 0) { reject(launched && mutation ? new NativeWorkspaceUnresolvedError() : deny());return; }
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (value === null || typeof value !== 'object' || Array.isArray(value)) throw deny();
            const result = value as Record<string, unknown>;
            if (result.ok === false && Object.keys(result).length === 2 && result.code === 'NO_CHANGE') { reject(deny());return; }
            if (result.ok !== true || result.rootIdentity !== expectedRoot) throw new NativeWorkspaceUnresolvedError();
            resolve(value);
          } catch (error) { reject(error instanceof NativeWorkspaceDeniedError ? error : mutation ? new NativeWorkspaceUnresolvedError() : deny()); }
        });
        child.stdin.end(input);
      });
      if (!mutation && capture !== undefined) { rmdirSync(join(capture, 'recovery'));rmdirSync(capture);capture = undefined; }
      return response;
    } catch (error) {
      if (error instanceof NativeWorkspaceUnresolvedError || (launched && mutation && !(error instanceof NativeWorkspaceDeniedError))) {
        this.quarantined = true;throw new NativeWorkspaceUnresolvedError();
      }
      throw deny();
    } finally { if (rootFd !== undefined) closeSync(rootFd); }
  }
}

/** A single configured root with the shared strict operation/reply protocol. */
export class PosixWorkspaceClient {
  private readonly options: {
    rootId: string; rootPath: string; writable: boolean; protectedPaths: readonly string[];
    protectedMutationPaths?: readonly string[]; transport: NativeWorkspaceTransport;
  };
  constructor(options: PosixWorkspaceClient['options']) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(options.rootId) || !canonicalText(options.rootPath) || options.rootPath === '/') throw deny();
    this.options = { ...options, protectedPaths: Object.freeze([...options.protectedPaths]),
      ...(options.protectedMutationPaths === undefined ? {} : { protectedMutationPaths: Object.freeze([...options.protectedMutationPaths]) }) };
  }
  async invoke(rootId: string, input: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> {
    validateNativeWorkspaceOperation(input);
    const mutation = !['list', 'read', 'stat', 'treeStat'].includes(input.operation);
    if (rootId !== this.options.rootId || (mutation && !this.options.writable)) throw deny();
    let response: unknown;
    try {
      response = await this.options.transport.run({ ...input, root: this.options.rootPath,
        protectedPaths: [...this.options.protectedPaths],
        ...(this.options.protectedMutationPaths === undefined ? {} : { protectedMutationPaths: [...this.options.protectedMutationPaths] }) });
    } catch (error) {
      if (error instanceof NativeWorkspaceUnresolvedError || error instanceof NativeWorkspaceDeniedError) throw error;
      throw mutation ? new NativeWorkspaceUnresolvedError() : deny();
    }
    try {
      const parsed = parseNativeWorkspaceReply(response, input.operation);
      if ('expectedRootIdentity' in input && parsed.rootIdentity !== input.expectedRootIdentity) throw deny();
      return parsed;
    } catch { throw mutation ? new NativeWorkspaceUnresolvedError() : deny(); }
  }
}
