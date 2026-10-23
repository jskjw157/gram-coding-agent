/** Typed IPC only. Raw bytes returned here are controller-internal and must pass
 * content screening/owner authorization before any MCP response. */
type NativeDirectoryPreimage = { expectedKind: 'directory'; expectedVersion: string; expectedFileIdentity: string };
type NativeFilePreimage = { expectedKind: 'file'; expectedBase64: string; expectedFileIdentity: string };
export type NativeWorkspaceOperation =
  | { operation: 'list' | 'stat' | 'read' | 'treeStat'; path: string }
  | { operation: 'readGitChunk'; path: string; offset: number; length: number }
  | { operation: 'mkdir'; path: string; expectedRootIdentity: string }
  | { operation: 'write'; path: string; expectedBase64: string | null; base64: string; expectedRootIdentity: string; expectedFileIdentity: string | null }
  | ({ operation: 'move'; path: string; destination: string; expectedRootIdentity: string } &
      (NativeDirectoryPreimage | { expectedKind?: 'file'; expectedBase64: string; expectedFileIdentity: string }))
  | ({ operation: 'trash' | 'restore'; path: string; recoveryId: string; expectedRootIdentity: string } &
      (NativeDirectoryPreimage | NativeFilePreimage));
export interface NativeWorkspaceRequest {
  operation: NativeWorkspaceOperation['operation']; root: string; path: string;
  protectedPaths: readonly string[]; destination?: string; expectedBase64?: string | null; base64?: string;
  protectedMutationPaths?: readonly string[];
  expectedRootIdentity?: string; expectedFileIdentity?: string | null;
  expectedKind?: 'file' | 'directory'; expectedVersion?: string;
  offset?: number; length?: number;
  recoveryRoot?: string; recoveryId?: string; expectedRecoveryRootIdentity?: string;
}
export interface NativeWorkspaceReply {
  ok: true; rootIdentity: string; kind?: 'file' | 'directory'; identity?: string; bytes?: number; base64?: string; version?: string;
  entries?: { name: string; type: 'file' | 'directory' | 'symlink' }[];
  omitted?: boolean;
  totalBytes?: number; gitStamp?: string;
}
export interface NativeWorkspaceTransport { run(request: NativeWorkspaceRequest): Promise<unknown> }
export class NativeWorkspaceUnresolvedError extends Error {
  readonly code = 'NEEDS_RECONCILIATION';
  constructor() {super('Native workspace outcome is unresolved');}
}
export class NativeWorkspaceDeniedError extends Error {
  readonly code = 'NO_CHANGE';
  constructor() {super('Native workspace operation denied or failed');}
}
const LIMIT = 1024 * 1024;
export const GIT_CHUNK_BYTES = 256 * 1024;
export const GIT_PACK_MAX_BYTES = 64 * 1024 * 1024;
export const GIT_CHUNK_PATH = /(?:^|\/)\.git\/objects\/pack\/pack-[0-9a-f]{40}\.(?:pack|idx|rev)$/iu;
export const GIT_CHUNK_STAMP = /^\d+:\d+:\d+:\d+:\d+$/u;
const deny = () => new NativeWorkspaceDeniedError();
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function textPath(value: unknown, allowRoot = false): value is string {
  if (allowRoot && value === '.') return true;
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  return value.split('/').length <= 60 && value.split('/').every(part =>
    part !== '' && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ') &&
    !/[\\:<>"|?*]/u.test(part) && !Array.from(part).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part));
}
function base64(value: unknown): value is string {
  return typeof value === 'string' && value.length <= Math.ceil(LIMIT / 3) * 4 &&
    Buffer.from(value, 'base64').length <= LIMIT && Buffer.from(value, 'base64').toString('base64') === value;
}
const mutations = ['mkdir', 'write', 'move', 'trash', 'restore'];
const identity = (value: unknown): value is string => typeof value === 'string' && /^\d+:\d+$/u.test(value);
function validate(input: NativeWorkspaceOperation): void {
  if (!object(input) || !['list', 'stat', 'read', 'readGitChunk', 'treeStat', ...mutations].includes(String(input.operation)) ||
      !textPath(input.path, input.operation === 'list' || input.operation === 'stat')) throw deny();
  const keys = ['operation', 'path'];
  if (mutations.includes(input.operation)) {
    keys.push('expectedRootIdentity');
    if (!('expectedRootIdentity' in input) || !identity(input.expectedRootIdentity)) throw deny();
  }
  if (input.operation === 'readGitChunk') {
    keys.push('offset', 'length');
    if (!GIT_CHUNK_PATH.test(input.path) ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 ||
        input.offset > GIT_PACK_MAX_BYTES ||
        !Number.isSafeInteger(input.length) || input.length < 1 || input.length > GIT_CHUNK_BYTES ||
        input.offset + input.length > GIT_PACK_MAX_BYTES) throw deny();
  }
  if (input.operation === 'write') {
    keys.push('expectedBase64', 'base64', 'expectedFileIdentity');
    if ((input.expectedBase64 !== null && !base64(input.expectedBase64)) || !base64(input.base64) ||
        (input.expectedBase64 === null ? input.expectedFileIdentity !== null : !identity(input.expectedFileIdentity))) throw deny();
  }
  if (input.operation === 'move' || input.operation === 'trash' || input.operation === 'restore') {
    keys.push('expectedFileIdentity');
    if (!identity(input.expectedFileIdentity)) throw deny();
    if (input.operation === 'move') {
      keys.push('destination');if (!textPath(input.destination)) throw deny();
    } else {
      keys.push('recoveryId');
      if (!textPath(input.recoveryId) || input.recoveryId.includes('/') || input.recoveryId.length > 255) throw deny();
    }
    if (input.expectedKind === 'directory') {
      keys.push('expectedKind', 'expectedVersion');
      if (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedVersion)) throw deny();
    } else {
      keys.push('expectedBase64');
      if (input.operation !== 'move' || Object.hasOwn(input, 'expectedKind')) {
        keys.push('expectedKind');if (input.expectedKind !== 'file') throw deny();
      }
      if (!base64(input.expectedBase64)) throw deny();
    }
  }
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k))) throw deny();
}
function reply(value: unknown, operation: NativeWorkspaceOperation['operation']): NativeWorkspaceReply {
  if (!object(value) || value.ok !== true || typeof value.rootIdentity !== 'string' || !/^\d+:\d+$/u.test(value.rootIdentity) ||
      Object.keys(value).some(k => !['ok', 'rootIdentity', ...(operation === 'list' ? ['entries', 'omitted'] :
        operation === 'treeStat' ? ['kind', 'identity', 'version'] : operation === 'read' ? ['kind', 'identity', 'bytes', 'base64'] :
        operation === 'readGitChunk' ? ['kind', 'identity', 'bytes', 'base64', 'totalBytes', 'gitStamp'] :
          operation === 'stat' ? ['kind', 'identity', 'bytes'] : [])].includes(k))) throw deny();
  if (operation === 'treeStat' && (value.kind !== 'directory' || !identity(value.identity) ||
      typeof value.version !== 'string' || !/^[a-f0-9]{64}$/u.test(value.version))) throw deny();
  if (operation === 'read' || operation === 'stat' || operation === 'readGitChunk') {
    if (!['file', 'directory'].includes(String(value.kind)) || typeof value.identity !== 'string' || !/^\d+:\d+$/u.test(value.identity) ||
        (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0))) throw deny();
  }
  if (operation === 'read' && (value.kind !== 'file' || !base64(value.base64) || Buffer.from(value.base64, 'base64').length !== value.bytes)) throw deny();
  if (operation === 'readGitChunk' &&
      (value.kind !== 'file' || !base64(value.base64) ||
       !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > GIT_CHUNK_BYTES ||
       Buffer.from(value.base64, 'base64').length !== value.bytes ||
       !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 ||
       value.totalBytes > GIT_PACK_MAX_BYTES ||
       typeof value.gitStamp !== 'string' || !/^\d+:\d+:\d+:\d+:\d+$/u.test(value.gitStamp))) throw deny();
  if (operation === 'list') {
    if (Object.hasOwn(value, 'omitted') && typeof value.omitted !== 'boolean') throw deny();
    if (!Array.isArray(value.entries) || value.entries.length > 10000 || value.entries.some(entry => !object(entry) ||
        typeof entry.name !== 'string' || entry.name.includes('/') || entry.name.includes('\\') || entry.name.length > 255 ||
        !['file', 'directory', 'symlink'].includes(String(entry.type)) || Object.keys(entry).some(k => !['name', 'type'].includes(k)))) throw deny();
  }
  return value as unknown as NativeWorkspaceReply;
}

export class WindowsWorkspaceClient {
  private readonly roots: Readonly<Record<string, Readonly<{ windowsPath: string; writable: boolean }>>>;
  private readonly protectedPaths: readonly string[];
  private readonly protectedMutationPaths: readonly string[];
  private readonly transport: NativeWorkspaceTransport;
  private readonly recoveryRoots: Readonly<Record<string, Readonly<{ windowsPath: string; identity: string }>>>;
  constructor(options: { roots: Record<string, { windowsPath: string; writable: boolean }>; protectedPaths: readonly string[]; protectedMutationPaths?: readonly string[]; recoveryRoots?: Record<string, { windowsPath: string; identity: string }>; transport: NativeWorkspaceTransport }) {
    if (Object.keys(options.roots).length === 0 || Object.keys(options.roots).length > 26) throw deny();
    for (const [id, root] of Object.entries(options.roots)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || !/^[a-z]:\\/iu.test(root.windowsPath) || typeof root.writable !== 'boolean') throw deny();
    }
    if (Object.values(options.roots).some(root => root.writable) && options.protectedPaths.length === 0) throw deny();
    this.roots = Object.freeze(Object.fromEntries(Object.entries(options.roots).map(([id, root]) => [id, Object.freeze({ ...root })])));
    for (const [id, vault] of Object.entries(options.recoveryRoots ?? {})) {
      if (!Object.hasOwn(options.roots, id) || !/^[a-z]:\\/iu.test(vault.windowsPath) || !identity(vault.identity)) throw deny();
    }
    this.recoveryRoots = Object.freeze(Object.fromEntries(Object.entries(options.recoveryRoots ?? {})
      .map(([id, vault]) => [id, Object.freeze({ ...vault })])));
    this.protectedPaths = Object.freeze([...new Set([...options.protectedPaths, ...Object.values(this.recoveryRoots).map(vault => vault.windowsPath)])]);
    this.protectedMutationPaths = Object.freeze([...(options.protectedMutationPaths ?? [])]);
    this.transport = options.transport;
  }
  async invoke(rootId: string, input: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> {
    try {
      validate(input);const root = Object.hasOwn(this.roots, rootId) ? this.roots[rootId] : undefined;
      if (root === undefined || (!root.writable && mutations.includes(input.operation))) throw deny();
      const recovery = (input.operation === 'trash' || input.operation === 'restore') && Object.hasOwn(this.recoveryRoots, rootId)
        ? this.recoveryRoots[rootId] : undefined;
      if ((input.operation === 'trash' || input.operation === 'restore') && recovery === undefined) throw deny();
      const request = { ...input, ...(recovery === undefined ? {} : { recoveryRoot: recovery.windowsPath, expectedRecoveryRootIdentity: recovery.identity }), root: root.windowsPath, protectedPaths: [...this.protectedPaths],
        ...(this.protectedMutationPaths.length === 0 ? {} : { protectedMutationPaths: [...this.protectedMutationPaths] }) };
      let response: unknown;
      try {response = await this.transport.run(request);}
      catch (error) {
        if (error instanceof NativeWorkspaceUnresolvedError) throw error;
        if (error instanceof NativeWorkspaceDeniedError || !mutations.includes(input.operation)) throw deny();
        throw new NativeWorkspaceUnresolvedError();
      }
      try {
        const parsed = reply(response, input.operation);
        if ('expectedRootIdentity' in input && parsed.rootIdentity !== input.expectedRootIdentity) throw deny();
        return parsed;
      } catch {
        if (mutations.includes(input.operation)) throw new NativeWorkspaceUnresolvedError();
        throw deny();
      }
    } catch (error) {
      if (error instanceof NativeWorkspaceUnresolvedError) throw error;
      throw deny();
    }
  }
}

export { validate as validateNativeWorkspaceOperation, reply as parseNativeWorkspaceReply };
