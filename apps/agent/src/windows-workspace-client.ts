/** Typed IPC only. Raw bytes returned here are controller-internal and must pass
 * content screening/owner authorization before any MCP response. */
export type NativeWorkspaceOperation =
  | { operation: 'list' | 'stat' | 'read' | 'mkdir'; path: string }
  | { operation: 'write'; path: string; expectedBase64: string | null; base64: string }
  | { operation: 'move'; path: string; destination: string; expectedBase64: string };
export interface NativeWorkspaceRequest {
  operation: NativeWorkspaceOperation['operation']; root: string; path: string;
  protectedPaths: readonly string[]; destination?: string; expectedBase64?: string | null; base64?: string;
}
export interface NativeWorkspaceReply {
  ok: true; kind?: 'file' | 'directory'; identity?: string; bytes?: number; base64?: string;
  entries?: { name: string; type: 'file' | 'directory' | 'symlink' }[];
}
export interface NativeWorkspaceTransport { run(request: NativeWorkspaceRequest): Promise<unknown> }
const LIMIT = 1024 * 1024;
const deny = () => new Error('Native workspace operation denied or failed');
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
function validate(input: NativeWorkspaceOperation): void {
  if (!object(input) || !['list', 'stat', 'read', 'mkdir', 'write', 'move'].includes(String(input.operation)) ||
      !textPath(input.path, input.operation === 'list' || input.operation === 'stat')) throw deny();
  const keys = ['operation', 'path'];
  if (input.operation === 'write') {
    keys.push('expectedBase64', 'base64');
    if ((input.expectedBase64 !== null && !base64(input.expectedBase64)) || !base64(input.base64)) throw deny();
  }
  if (input.operation === 'move') {
    keys.push('destination', 'expectedBase64');
    if (!textPath(input.destination) || !base64(input.expectedBase64)) throw deny();
  }
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k))) throw deny();
}
function reply(value: unknown, operation: NativeWorkspaceOperation['operation']): NativeWorkspaceReply {
  if (!object(value) || value.ok !== true || Object.keys(value).some(k => !['ok', 'kind', 'identity', 'bytes', 'base64', 'entries'].includes(k))) throw deny();
  if (operation === 'read' || operation === 'stat') {
    if (!['file', 'directory'].includes(String(value.kind)) || typeof value.identity !== 'string' || !/^\d+:\d+$/u.test(value.identity) ||
        (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0))) throw deny();
  }
  if (operation === 'read' && (value.kind !== 'file' || !base64(value.base64) || Buffer.from(value.base64, 'base64').length !== value.bytes)) throw deny();
  if (operation === 'list') {
    if (!Array.isArray(value.entries) || value.entries.length > 10000 || value.entries.some(entry => !object(entry) ||
        typeof entry.name !== 'string' || entry.name.includes('/') || entry.name.includes('\\') || entry.name.length > 255 ||
        !['file', 'directory', 'symlink'].includes(String(entry.type)) || Object.keys(entry).some(k => !['name', 'type'].includes(k)))) throw deny();
  }
  return value as unknown as NativeWorkspaceReply;
}

export class WindowsWorkspaceClient {
  private readonly roots: Readonly<Record<string, Readonly<{ windowsPath: string; writable: boolean }>>>;
  private readonly protectedPaths: readonly string[];
  private readonly transport: NativeWorkspaceTransport;
  constructor(options: { roots: Record<string, { windowsPath: string; writable: boolean }>; protectedPaths: readonly string[]; transport: NativeWorkspaceTransport }) {
    if (Object.keys(options.roots).length === 0 || Object.keys(options.roots).length > 26) throw deny();
    for (const [id, root] of Object.entries(options.roots)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || !/^[a-z]:\\/iu.test(root.windowsPath) || typeof root.writable !== 'boolean') throw deny();
    }
    if (Object.values(options.roots).some(root => root.writable) && options.protectedPaths.length === 0) throw deny();
    this.roots = Object.freeze(Object.fromEntries(Object.entries(options.roots).map(([id, root]) => [id, Object.freeze({ ...root })])));
    this.protectedPaths = Object.freeze([...options.protectedPaths]);
    this.transport = options.transport;
  }
  async invoke(rootId: string, input: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> {
    try {
      validate(input);const root = Object.hasOwn(this.roots, rootId) ? this.roots[rootId] : undefined;
      if (root === undefined || (!root.writable && ['write', 'mkdir', 'move'].includes(input.operation))) throw deny();
      const request = { ...input, root: root.windowsPath, protectedPaths: [...this.protectedPaths] };
      return reply(await this.transport.run(request), input.operation);
    } catch { throw deny(); }
  }
}
