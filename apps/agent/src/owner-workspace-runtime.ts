import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { LocalOperationRepository, openDatabase, type StoredRepository } from '@gram/persistence';
import type { SecretRedactor } from '@gram/secrets';
import type { LocalRepositoryInputValue } from '@gram/mcp';
import type { LocalDeveloperProject } from './local-developer.js';
import { LocalOwnerConsent } from './local-owner-consent.js';
import { LocalRecoveryStore } from './local-recovery-store.js';
import { OwnerWorkspaceCore, type OwnerWorkspaceRoot } from './owner-workspace-core.js';
import { FixedPosixWorkspaceTransport, PosixWorkspaceClient } from './posix-workspace-transport.js';
import { FixedWindowsWorkspaceTransport } from './windows-workspace-transport.js';
import { GIT_CHUNK_PATH, GIT_CHUNK_STAMP, WindowsWorkspaceClient, NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError, validateNativeWorkspaceOperation, type NativeWorkspaceOperation, type NativeWorkspaceReply, type NativeWorkspaceTransport } from './windows-workspace-client.js';
import { createWindowsOwnerConsentVerifier, createWindowsProtectedLocalViewer } from './windows-owner-consent-verifier.js';

interface Pin { path: string; sha256: string }
interface OwnerPin extends Pin { expectedOwnerSid: string }
export interface OwnerWorkspaceConfig {
  version: 1;
  roots: Record<string, OwnerWorkspaceRoot>;
  windows?: {
    helper: Pin; ownerPresence: OwnerPin; viewer?: OwnerPin;
    protectedPaths: string[]; protectedMutationPaths: string[];
    recoveryRoots: Record<string, { windowsPath: string; identity: string }>;
  };
  posix?: {
    artifacts: { bubblewrap: Pin; node: Pin; entry: Pin; worker: Pin; native: Pin };
    recoveryBase: string; recoveryRoots: Record<string, { path: string; identity: string }>;
  };
}
export interface OwnerWorkspaceRuntimeOptions {
  configPath: string; stateDirectory: string; secretDirectory: string; redactor: SecretRedactor;
  protectedReadPaths: string[]; protectedMutationPaths: string[];
  activeMutationPaths(): readonly string[];
}
export interface OwnerWorkspaceRuntime {
  core: OwnerWorkspaceCore;
  withProject<T>(input: LocalRepositoryInputValue, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  withRegisteredProject<T>(repository: StoredRepository, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  withRepositoryLeaseAdmission<T>(acquire: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const deny = () => new Error('Owner workspace runtime denied');
const inside = (parent: string, child: string) => parent === child || child.startsWith(parent === '/' ? '/' : `${parent}/`);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !/[\\\p{Cc}\p{Cf}]/u.test(value);
}
function windowsPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && value.length <= 4096 &&
    !/[/\p{Cc}\p{Cf}<>"|?*]/u.test(value.slice(3).replaceAll('\\', '')) &&
    (value.length === 3 || value.slice(3).split('\\').every(p => p && p !== '.' && p !== '..' && !/[. :]$/u.test(p) && !p.includes(':')));
}
function linuxWindows(value: string): string {
  if (!windowsPath(value)) throw deny();
  return '/mnt/' + value[0]?.toLowerCase() + (value.length === 3 ? '' : '/' + value.slice(3).replaceAll('\\', '/'));
}
function toWindows(value: string): string | null {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/u.exec(value);
  return match?.[1] ? `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}` : null;
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw deny();
}
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  record(value);
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw deny();
}
function pin(value: unknown, owner = false): void {
  shape(value, ['path', 'sha256', ...(owner ? ['expectedOwnerSid'] : [])]);
  if (!canonical(value.path) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      (owner && (typeof value.expectedOwnerSid !== 'string' || !/^S-1-\d+(?:-\d+){1,15}$/u.test(value.expectedOwnerSid)))) throw deny();
}
function paths(value: unknown, windows = false): void {
  if (!Array.isArray(value) || value.length > 256 || value.some(p => !(windows ? windowsPath(p) : canonical(p)))) throw deny();
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item);Object.freeze(value);}
  return value;
}
/** Pure strict parser; only the production loader below grants installed authority. */
export function parseOwnerWorkspaceConfig(input: unknown): OwnerWorkspaceConfig {
  shape(input, ['version', 'roots'], ['windows', 'posix']);
  if (input.version !== 1) throw deny();
  record(input.roots);
  const entries = Object.entries(input.roots);
  if (!entries.length || entries.length > 26) throw deny();
  for (const [id, root] of entries) {
    shape(root, ['label', 'kind', 'wslPath', 'writable'], ['windowsPath']);
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || typeof root.label !== 'string' || !root.label || root.label.length > 256 ||
        !canonical(root.wslPath) || root.wslPath === '/' || typeof root.writable !== 'boolean') throw deny();
    if (root.kind === 'windows-drive') {
      if (!windowsPath(root.windowsPath) || linuxWindows(root.windowsPath) !== root.wslPath || input.windows === undefined) throw deny();
    } else if (root.kind !== 'wsl-directory' || root.windowsPath !== undefined || input.posix === undefined) throw deny();
  }
  if (input.windows !== undefined) {
    const w = input.windows;
    shape(w, ['helper', 'ownerPresence', 'protectedPaths', 'protectedMutationPaths', 'recoveryRoots'], ['viewer']);
    pin(w.helper);pin(w.ownerPresence, true);
    if (Object.hasOwn(w, 'viewer')) pin(w.viewer, true);
    paths(w.protectedPaths, true);paths(w.protectedMutationPaths, true);record(w.recoveryRoots);
    for (const [id, vault] of Object.entries(w.recoveryRoots)) {
      shape(vault, ['windowsPath', 'identity']);
      if (!Object.hasOwn(input.roots, id) || (input.roots[id] as OwnerWorkspaceRoot).kind !== 'windows-drive' ||
          !windowsPath(vault.windowsPath) || typeof vault.identity !== 'string' || !/^\d+:\d+$/u.test(vault.identity)) throw deny();
    }
    for (const [id, root] of entries) if ((root as OwnerWorkspaceRoot).kind === 'windows-drive' && !Object.hasOwn(w.recoveryRoots, id)) throw deny();
  }
  if (input.posix !== undefined) {
    const p = input.posix;
    shape(p, ['artifacts', 'recoveryBase', 'recoveryRoots']);shape(p.artifacts, ['bubblewrap', 'node', 'entry', 'worker', 'native']);
    for (const value of Object.values(p.artifacts)) pin(value);
    if (!canonical(p.recoveryBase) || p.recoveryBase === '/') throw deny();
    record(p.recoveryRoots);
    for (const [id, vault] of Object.entries(p.recoveryRoots)) {
      shape(vault, ['path', 'identity']);
      if (!Object.hasOwn(input.roots, id) || (input.roots[id] as OwnerWorkspaceRoot).kind !== 'wsl-directory' ||
          !canonical(vault.path) || vault.path === '/' || typeof vault.identity !== 'string' || !/^\d+:\d+$/u.test(vault.identity)) throw deny();
    }
    for (const [id, root] of entries) if ((root as OwnerWorkspaceRoot).kind === 'wsl-directory' && !Object.hasOwn(p.recoveryRoots, id)) throw deny();
  }
  return freeze(structuredClone(input) as unknown as OwnerWorkspaceConfig);
}
function protectedAncestors(path: string): void {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const st = lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0 || realpathSync(parent) !== parent) throw deny();
    if (parent === '/') break;
  }
}
function readInstalledJson(path: string): unknown {
  if (process.platform !== 'linux' || !canonical(path) || realpathSync(path) !== path) throw deny();
  protectedAncestors(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) !== 0n || before.size > 65536n) throw deny();
    const bytes = readFileSync(fd);const after = fstatSync(fd, { bigint: true });
    if (bytes.length > 65536 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw deny();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {closeSync(fd);}
}
function readAutomation(path: string, roots: OwnerWorkspaceConfig['roots']): readonly string[] {
  try {lstatSync(path);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);throw deny();}
  try {
    const input = readInstalledJson(path);
    shape(input, ['version', 'unattendedRootIds']);
    if (input.version !== 1 || !Array.isArray(input.unattendedRootIds) || input.unattendedRootIds.length > 26 ||
        new Set(input.unattendedRootIds).size !== input.unattendedRootIds.length ||
        input.unattendedRootIds.some(id => typeof id !== 'string' || !Object.hasOwn(roots, id))) throw deny();
    return Object.freeze([...input.unattendedRootIds] as string[]);
  } catch {throw deny();}
}
function directory(path: string, ext4: boolean): { fd: number; identity: string } {
  if (!canonical(path) || realpathSync(path) !== path) throw deny();
  // Check every component, rather than accepting a symlink that happens to stay inside the root.
  let part = '';
  for (const component of path.split('/').filter(Boolean)) {
    part += '/' + component;const st = lstatSync(part);
    if (!st.isDirectory() || st.isSymbolicLink()) throw deny();
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || realpathSync(`/proc/self/fd/${fd}`) !== path || (ext4 && statfsSync(`/proc/self/fd/${fd}`, { bigint: true }).type !== 0xef53n)) throw deny();
    return { fd, identity: `${st.dev}:${st.ino}` };
  } catch (error) {closeSync(fd);throw error;}
}
function masks(root: string, privatePaths: readonly string[]): string[] {
  return privatePaths.filter(path => overlap(root, path)).map(path => inside(path, root) ? '.' : posix.relative(root, path));
}
const WINDOWS_PRIVATE = ['C:\\Windows', 'C:\\ProgramData\\Gram', 'C:\\Program Files\\Gram', 'C:\\Program Files (x86)\\Gram'];
// One FIFO reservation across runtimes, filesystem effects and database lease
// admission. A lease releases this reservation after acquisition, while its
// persisted active scope continues to deny overlapping filesystem mutations.
let admissionTail: Promise<void> = Promise.resolve();
function reserveAdmission<T>(operation: () => Promise<T>): Promise<T> {
  const prior = admissionTail;let release = () => {};
  admissionTail = new Promise<void>(resolve => {release = resolve;});
  return prior.then(operation).finally(release);
}

/** Trusted local composition only. No caller can select executable paths, hashes, or native ports. */
export async function createOwnerWorkspaceRuntime(options: OwnerWorkspaceRuntimeOptions): Promise<OwnerWorkspaceRuntime> {
  const config = parseOwnerWorkspaceConfig(readInstalledJson(options.configPath));
  const automationPath = join(dirname(options.configPath), 'owner-workspace-automation.json');
  const unattendedRootIds = readAutomation(automationPath, config.roots);
  const reads = [options.configPath, automationPath, options.stateDirectory, options.secretDirectory, ...options.protectedReadPaths,
    ...Object.values(config.posix?.artifacts ?? {}).map(pin => pin.path),
    ...(config.windows ? [config.windows.helper.path, config.windows.ownerPresence.path,
      ...(config.windows.viewer ? [config.windows.viewer.path] : [])] : []),
    ...(config.posix ? [config.posix.recoveryBase, ...Object.values(config.posix.recoveryRoots).map(v => v.path)] : []),
    ...(config.windows ? [...config.windows.protectedPaths, ...Object.values(config.windows.recoveryRoots).map(v => v.windowsPath), ...WINDOWS_PRIVATE].map(linuxWindows) : [])];
  const mutations = [...reads, ...options.protectedMutationPaths,
    ...(config.windows?.protectedMutationPaths ?? []).map(linuxWindows)];
  paths(reads);paths(mutations);
  if (typeof options.activeMutationPaths !== 'function') throw deny();
  function activePaths(): string[] {const active = [...options.activeMutationPaths()];paths(active);return active;}
  function dynamicTransport(fixed: NativeWorkspaceTransport, encode: (active: string[]) => string[]): NativeWorkspaceTransport {
    return { run(request) {
      let protectedMutationPaths: string[];
      try {protectedMutationPaths = [...new Set([...(request.protectedMutationPaths ?? []), ...encode(activePaths())])];}
      catch {throw new NativeWorkspaceDeniedError();}
      return fixed.run({ ...request, protectedMutationPaths });
    } };
  }
  // Mandatory private directories must already exist with owner-only access.
  for (const path of [options.stateDirectory, options.secretDirectory]) {
    const pinned = directory(path, false);
    try {const st = fstatSync(pinned.fd);if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw deny();}
    finally {closeSync(pinned.fd);}
  }
  const rootPins = new Map<string, { fd: number; identity: string }>();
  let db: ReturnType<typeof openDatabase> | undefined;let journalFd: number | undefined;
  try {
    for (const [id, root] of Object.entries(config.roots)) {
      if (reads.some(path => inside(path, root.wslPath))) throw deny();
      rootPins.set(id, directory(root.wslPath, root.kind === 'wsl-directory'));
    }
    const windows = config.windows && Object.values(config.roots).some(root => root.kind === 'windows-drive') && new WindowsWorkspaceClient({
      roots: Object.fromEntries(Object.entries(config.roots).filter(([, r]) => r.kind === 'windows-drive').map(([id, r]) => [id, { windowsPath: r.windowsPath ?? '', writable: r.writable }])),
      protectedPaths: [...new Set([...config.windows.protectedPaths, ...WINDOWS_PRIVATE, ...reads.map(toWindows).filter((p): p is string => p !== null)])],
      protectedMutationPaths: [...new Set([...config.windows.protectedMutationPaths, ...mutations.map(toWindows).filter((p): p is string => p !== null)])],
      recoveryRoots: config.windows.recoveryRoots,
      transport: dynamicTransport(new FixedWindowsWorkspaceTransport({ helperPath: config.windows.helper.path, expectedSha256: config.windows.helper.sha256 }),
        active => active.map(toWindows).filter((p): p is string => p !== null)),
    });
    const clients = new Map<string, { invoke(root: string, operation: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> }>();
    for (const [id, root] of Object.entries(config.roots)) {
      if (root.kind === 'windows-drive') {if (!windows) throw deny();clients.set(id, windows);}
      else {
        const p = config.posix;const recoveryRoot = p?.recoveryRoots[id];if (!p || !recoveryRoot) throw deny();
        clients.set(id, new PosixWorkspaceClient({ rootId: id, rootPath: root.wslPath, writable: root.writable,
          protectedPaths: masks(root.wslPath, reads), protectedMutationPaths: masks(root.wslPath, mutations),
          transport: dynamicTransport(new FixedPosixWorkspaceTransport({ rootPath: root.wslPath, artifacts: p.artifacts, recoveryBase: p.recoveryBase, recoveryRoot }),
            active => masks(root.wslPath, active)) }));
      }
    }
    function checkRoot(id: string): OwnerWorkspaceRoot {
      const root = config.roots[id];const pin = rootPins.get(id);if (!root || !pin) throw deny();
      const current = directory(root.wslPath, root.kind === 'wsl-directory');
      try {if (current.identity !== pin.identity || realpathSync(`/proc/self/fd/${pin.fd}`) !== root.wslPath) throw deny();}
      finally {closeSync(current.fd);}
      return root;
    }
    function mutationGuard(target: string): void {
      const active = activePaths();
      if ([...mutations, ...active].some(path => overlap(path, target))) throw new NativeWorkspaceDeniedError();
    }
    const nativeIdentities = new Map<string, string>();
    const backend = { invoke(id: string, operation: NativeWorkspaceOperation) {
      const mutation = !['list', 'stat', 'read', 'readGitChunk', 'treeStat'].includes(operation.operation);
      const invoke = async () => {
        const client = (() => {
          try {
            validateNativeWorkspaceOperation(operation);const root = checkRoot(id);const client = clients.get(id);if (!client) throw deny();
            const target = posix.join(root.wslPath, operation.path);
            if (reads.some(path => inside(path, target))) throw deny();
            if (mutation) {mutationGuard(target);if ('destination' in operation) mutationGuard(posix.join(root.wslPath, operation.destination));}
            return client;
          } catch {throw new NativeWorkspaceDeniedError();}
        })();
        const reply = await client.invoke(id, operation);
        try {
          checkRoot(id);const expected = nativeIdentities.get(id);
          if (expected === undefined) {
            if (operation.operation !== 'stat' || operation.path !== '.' || reply.kind !== 'directory' || reply.identity !== reply.rootIdentity) throw deny();
            nativeIdentities.set(id, reply.rootIdentity);
          } else if (reply.rootIdentity !== expected) throw deny();
          return reply;
        } catch {throw mutation ? new NativeWorkspaceUnresolvedError() : new NativeWorkspaceDeniedError();}
      };
      return mutation ? reserveAdmission(invoke) : invoke();
    } };
    const journalPath = join(options.stateDirectory, 'owner-workspace.sqlite');
    try {journalFd = openSync(journalPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);}
    catch (error) {if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      journalFd = openSync(journalPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    const journalStat = fstatSync(journalFd);
    if (!journalStat.isFile() || journalStat.nlink !== 1 || journalStat.uid !== process.getuid?.() || (journalStat.mode & 0o077) !== 0 || realpathSync(journalPath) !== journalPath) throw deny();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {const st = lstatSync(journalPath + suffix);if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw deny();}
      catch (error) {if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;}
    }
    db = openDatabase(journalPath);
    const live = lstatSync(journalPath);if (live.dev !== journalStat.dev || live.ino !== journalStat.ino || live.nlink !== 1) throw deny();
    const recovery = new LocalRecoveryStore({ stateDirectory: options.stateDirectory });
    const ownerPin = config.windows?.ownerPresence;const viewerPin = config.windows?.viewer;
    const rawCore = await OwnerWorkspaceCore.create({ roots: config.roots, backend, recovery, unattendedRootIds,
      journal: new LocalOperationRepository(db), redactor: options.redactor,
      ...(ownerPin ? { consent: new LocalOwnerConsent({ verifier: createWindowsOwnerConsentVerifier({ helperPath: ownerPin.path, helperSha256: ownerPin.sha256, expectedOwnerSid: ownerPin.expectedOwnerSid }) }) } : {}),
      ...(viewerPin ? { viewer: createWindowsProtectedLocalViewer({ helperPath: viewerPin.path, helperSha256: viewerPin.sha256, expectedOwnerSid: viewerPin.expectedOwnerSid }) } : {}),
    });
    let closing = false;let closed: Promise<void> | undefined;const pending = new Set<Promise<unknown>>();
    function run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(deny());
      const result = Promise.resolve().then(operation);pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));return result;
    }
    const core = new Proxy(rawCore, { get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'roots') return () => {if (closing) throw deny();return target.roots();};
      return (...args: unknown[]) => run(() => Reflect.apply(value, target, args) as Promise<unknown>);
    } });
    // Pins and before/after observations detect replacement. They do not make
    // arbitrary callback path accesses atomic or replace command sandboxing.
    async function project<T>(input: LocalRepositoryInputValue, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T> {
      if (!input || Object.keys(input).sort().join() !== 'path,root') throw deny();
      validateNativeWorkspaceOperation({ operation: 'stat', path: input.path });
      const root = checkRoot(input.root);const target = posix.join(root.wslPath, input.path);
      if (mutations.some(path => overlap(path, target))) throw deny();
      const pinned = directory(target, root.kind === 'wsl-directory');
      try {
        const before = await backend.invoke(input.root, { operation: 'stat', path: input.path });
        if (before.kind !== 'directory' || before.rootIdentity !== nativeIdentities.get(input.root) || !before.identity) throw deny();
        const verify = async () => {
          const current = await backend.invoke(input.root, { operation: 'stat', path: input.path });
          if (current.kind !== 'directory' || current.identity !== before.identity || current.rootIdentity !== before.rootIdentity) throw deny();
        };
        const scoped = (relative: string) => {
          if (relative !== '.') validateNativeWorkspaceOperation({ operation: 'read', path: relative });
          return posix.join(input.path, relative);
        };
        const result = await operation({ canonicalPath: target, identity: before.identity,
          gitSnapshotSource: {
            verify,
            list: async relative => {
              const reply = await backend.invoke(input.root, { operation: 'list', path: scoped(relative) });
              if (!reply.entries || reply.omitted !== false) throw deny();return reply.entries;
            },
            read: async relative => {
              const relativePath = scoped(relative);
              // The snapshot checks project identity around every read. Native read
              // already pins and bounds ordinary files; avoid a separate stat.
              if (!GIT_CHUNK_PATH.test(relative)) {
                const reply = await backend.invoke(input.root, { operation: 'read', path: relativePath });
                if (reply.kind !== 'file' || typeof reply.base64 !== 'string' || !reply.identity ||
                    !Number.isSafeInteger(reply.bytes) || Number(reply.bytes) < 0 || Number(reply.bytes) > 1024 * 1024) throw deny();
                const bytes = Buffer.from(reply.base64, 'base64');
                if (bytes.length !== reply.bytes || bytes.toString('base64') !== reply.base64) throw deny();
                const mode = root.kind === 'windows-drive' ? 0 : lstatSync(posix.join(root.wslPath, relativePath)).mode;
                return { bytes, executable: (mode & 0o111) !== 0 };
              }
              await verify();
              const entry = await backend.invoke(input.root, { operation: 'stat', path: relativePath });await verify();
              if (entry.kind !== 'file' || typeof entry.bytes !== 'number' ||
                  !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw deny();
              let bytes: Buffer;
              if (entry.bytes > 1024 * 1024) {
                // Only Git's immutable pack-index objects have a bounded
                // chunk transport. No ordinary file/credential limit changes.
                if (root.kind !== 'windows-drive' ||
                    !GIT_CHUNK_PATH.test(relative) ||
                    entry.bytes > 64 * 1024 * 1024 || !entry.identity) throw deny();
                const parts: Buffer[] = [];
                let stamp: string | undefined, received = 0;
                for (let offset = 0; offset < entry.bytes; offset += 256 * 1024) {
                  const length = Math.min(256 * 1024, entry.bytes - offset);
                  const chunk = await backend.invoke(input.root, {
                    operation: 'readGitChunk', path: relativePath, offset, length,
                  });
                  await verify();
                  if (chunk.kind !== 'file' || chunk.identity !== entry.identity ||
                      chunk.totalBytes !== entry.bytes || typeof chunk.gitStamp !== 'string' ||
                      !GIT_CHUNK_STAMP.test(chunk.gitStamp) ||
                      (stamp !== undefined && chunk.gitStamp !== stamp) || typeof chunk.base64 !== 'string') throw deny();
                  const decoded = Buffer.from(chunk.base64, 'base64');
                  if (decoded.length !== length || decoded.toString('base64') !== chunk.base64) throw deny();
                  stamp = chunk.gitStamp;received += decoded.length;parts.push(decoded);
                }
                if (received !== entry.bytes) throw deny();
                const final = await backend.invoke(input.root, { operation: 'stat', path: relativePath });
                await verify();
                if (final.identity !== entry.identity || final.bytes !== entry.bytes) throw deny();
                bytes = Buffer.concat(parts, received);
              } else {
                const reply = await backend.invoke(input.root, { operation: 'read', path: relativePath });await verify();
                if (reply.base64 === undefined || reply.kind !== 'file' || reply.identity !== entry.identity) throw deny();
                bytes = Buffer.from(reply.base64, 'base64');
                if (bytes.length !== entry.bytes || bytes.toString('base64') !== reply.base64) throw deny();
              }
              // All bytes were admitted by the same native contained reader.
              const mode = root.kind === 'windows-drive' ? 0 : lstatSync(posix.join(root.wslPath, relativePath)).mode;
              return { bytes, executable: (mode & 0o111) !== 0 };
            },
          },
        });
        const after = await backend.invoke(input.root, { operation: 'stat', path: input.path });
        const current = directory(target, root.kind === 'wsl-directory');
        try {if (current.identity !== pinned.identity || after.identity !== before.identity || after.rootIdentity !== before.rootIdentity || realpathSync(`/proc/self/fd/${pinned.fd}`) !== target) throw deny();}
        finally {closeSync(current.fd);}
        if (mutations.some(path => overlap(path, target))) throw deny();return result;
      } finally {closeSync(pinned.fd);}
    }
    return { core,
      withRepositoryLeaseAdmission: acquire => run(() => reserveAdmission(acquire)),
      withProject: (input, operation) => run(() => project(input, operation)),
      withRegisteredProject: (repository, operation) => run(async () => {
        if (!canonical(repository.localBasePath)) throw deny();
        const entries = Object.entries(config.roots).filter(([, root]) => inside(root.wslPath, repository.localBasePath)).sort((a, b) => b[1].wslPath.length - a[1].wslPath.length);
        const match = entries[0];if (!match || !match[1].writable) throw deny();
        return project({ root: match[0], path: posix.relative(match[1].wslPath, repository.localBasePath) || '.' }, operation);
      }),
      close() {
        if (!closed) {closing = true;closed = (async () => {
          await Promise.allSettled([...pending]);db?.close();
          if (journalFd !== undefined) {closeSync(journalFd);journalFd = undefined;}
          for (const pin of rootPins.values()) closeSync(pin.fd);rootPins.clear();
        })();}return closed;
      },
    };
  } catch (error) {
    db?.close();if (journalFd !== undefined) closeSync(journalFd);
    for (const pin of rootPins.values()) closeSync(pin.fd);throw error;
  }
}
