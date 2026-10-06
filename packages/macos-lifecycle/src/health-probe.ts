import type { OwnedChild, SafeCode } from './contracts.js';
/** Pinned compatibility fixture, not a claim about the latest MCP revision. */
export const CORE_PROTOCOL = '2025-11-25';
export type CoreRequest = 'health' | 'initialize' | 'initialized' | 'tools' | 'call';
export interface WireReply { status: number; contentType: string; body: Buffer; sessionId?: string }
export interface CoreCredentials { withValue<T>(use: (secret: string) => Promise<T>): Promise<T> }
/** INTERNAL ports: neither a serialized owner claim nor a callback authenticates
 * a process. Production bindings require independently trusted native proof. */
export interface OwnedConnection {
  isCurrent(): Promise<boolean>;
  request(kind: CoreRequest, credentials: CoreCredentials, session: string | undefined, signal: AbortSignal): Promise<WireReply>;
  close(): void;
}
export interface CoreConnections {
  openOwnedConnection(child: OwnedChild, port: 3847, signal: AbortSignal): Promise<OwnedConnection | null>;
}
export interface CoreEvidence {
  state: 'LOCAL_CORE_HEALTHY' | 'UNKNOWN' | 'BLOCKED'; code: SafeCode;
  generation: string; releaseDigest: string; observedAtMs: number;
}
export interface ProbeOptions { signal?: AbortSignal; now?: () => number }
const kinds: readonly CoreRequest[] = ['health', 'initialize', 'initialized', 'tools', 'call'];
function fail(code: 'HEALTH_UNKNOWN' | 'AUTH_BLOCKED' | 'TOOL_SURFACE_MISMATCH' = 'HEALTH_UNKNOWN'): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) fail();
    result[key] = d.value;
  }
  return result;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._-]/u.test(value);
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** Validation/detachment only; it does NOT establish ownership. */
export function copyCoreChild(value: OwnedChild): OwnedChild {
  const v = object(value);
  if (!exact(v, ['role', 'pid', 'startIdentity', 'generation', 'releaseDigest', 'uid']) || v.role !== 'core'
    || !time(v.pid) || v.pid < 1 || v.pid > 0x7fff_ffff || !time(v.uid) || v.uid < 1 || v.uid >= 0xffff_ffff
    || !id(v.startIdentity) || !id(v.generation) || typeof v.releaseDigest !== 'string'
    || v.releaseDigest.length !== 64 || /[^a-f0-9]/u.test(v.releaseDigest)) fail();
  return Object.freeze({ role: 'core', pid: v.pid, startIdentity: v.startIdentity,
    generation: v.generation, releaseDigest: v.releaseDigest, uid: v.uid });
}
export function validCoreHealth(value: unknown): boolean {
  try { const v = object(value); return exact(v, ['status', 'database', 'mcp'])
    && v.status === 'healthy' && v.database === 'ok' && v.mcp === 'ready'; } catch { return false; }
}
function text(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) fail();
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes) || value.startsWith('\uFEFF')) fail();
  return value;
}
function message(reply: WireReply): unknown {
  let value = text(reply.body);
  const mime = reply.contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'text/event-stream') {
    value = value.replace(/\r\n/gu, '\n');
    if (value.includes('\r') || !value.endsWith('\n\n')) fail();
    let data: string | null = null; const blocks = value.split('\n\n');
    if (blocks.length > 10) fail();
    for (const block of blocks) {
      const lines: string[] = []; let eventSeen = false; let idSeen = false;
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const split = line.indexOf(':'); if (split < 1) fail();
        const name = line.slice(0, split); let field = line.slice(split + 1);
        if (field.startsWith(' ')) field = field.slice(1);
        if (name === 'data') lines.push(field);
        else if (name === 'event' && !eventSeen && field === 'message') eventSeen = true;
        else if (name === 'id' && !idSeen && field.length <= 256 && !/[^\x21-\x7e]/u.test(field)) idSeen = true;
        else fail();
      }
      if (lines.length) { if (data !== null) fail(); data = lines.join('\n'); }
    }
    if (data === null) fail(); value = data;
  } else if (mime !== 'application/json') fail();
  const parsed: unknown = JSON.parse(value); return parsed;
}
function rpc(reply: WireReply, expectedId: number): Record<string, unknown> {
  const v = object(message(reply));
  if (!exact(v, ['jsonrpc', 'id', 'result']) || v.jsonrpc !== '2.0' || v.id !== expectedId) fail();
  return object(v.result);
}
function validate(kind: CoreRequest, reply: WireReply): void {
  if (!Buffer.isBuffer(reply.body) || reply.body.length > 65536) fail();
  if (kind !== 'health' && (reply.status === 401 || reply.status === 403)) fail('AUTH_BLOCKED');
  if (kind === 'initialized') { if (reply.status !== 202 || reply.body.length !== 0) fail(); return; }
  if (reply.status !== 200) fail();
  if (kind === 'health') { if (!validCoreHealth(message(reply))) fail(); return; }
  const result = rpc(reply, kind === 'initialize' ? 1 : kind === 'tools' ? 2 : 3);
  if (kind === 'initialize') {
    if (result.protocolVersion !== CORE_PROTOCOL || object(result.serverInfo).name !== 'gram-coding-agent'
      || !Object.hasOwn(object(result.capabilities), 'tools')) fail();
  } else if (kind === 'tools') {
    if (!exact(result, ['tools']) || !Array.isArray(result.tools) || result.tools.length !== 1
      || object(result.tools[0]).name !== 'agent_health') fail('TOOL_SURFACE_MISMATCH');
  } else {
    if (result.isError === true || Object.keys(result).some(k => k !== 'content' && k !== 'isError')
      || (Object.hasOwn(result, 'isError') && result.isError !== false)
      || !Array.isArray(result.content) || result.content.length !== 1) fail();
    const item = object(result.content[0]);
    if (!exact(item, ['type', 'text']) || item.type !== 'text' || typeof item.text !== 'string') fail();
    const health: unknown = JSON.parse(item.text); if (!validCoreHealth(health)) fail();
  }
}
function sessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[^\x21-\x7e]/u.test(value);
}
/** Observe rejected/late promises too; never leak provider error text. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('HEALTH_UNKNOWN'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export async function probeCore(child: OwnedChild, connections: CoreConnections, credentials: CoreCredentials,
  options: ProbeOptions = {}): Promise<CoreEvidence> {
  let generation = ''; let releaseDigest = ''; let observedAtMs = 0;
  const now = options.now ?? Date.now;
  try {
    const owned = copyCoreChild(child); generation = owned.generation; releaseDigest = owned.releaseDigest;
    const started = now(); if (!time(started)) fail(); observedAtMs = started;
    let session: string | undefined;
    for (const kind of kinds) {
      if (options.signal?.aborted) fail();
      const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 2000);
      const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
      let connection: OwnedConnection | null = null;
      try {
        const pending = connections.openOwnedConnection(owned, 3847, signal);
        void pending.then(c => { if (signal.aborted) c?.close(); }, () => undefined).catch(() => undefined);
        connection = await abortable(pending, signal);
        if (connection === null || !await abortable(connection.isCurrent(), signal)) fail();
        const response = await abortable(connection.request(kind, credentials, session, signal), signal);
        if (!await abortable(connection.isCurrent(), signal)) fail();
        if (response.sessionId !== undefined) {
          if (!sessionId(response.sessionId) || (kind !== 'initialize' && response.sessionId !== session)) fail();
          if (kind === 'initialize') session = response.sessionId;
        }
        validate(kind, response);
      } finally {
        clearTimeout(timer); deadline.abort();
        try { connection?.close(); } catch { /* A close failure cannot reveal provider error text. */ }
      }
    }
    const finished = now(); if (!time(finished) || finished < observedAtMs || options.signal?.aborted) fail();
    return { state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation, releaseDigest, observedAtMs: finished };
  } catch (error) {
    const raw = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
    const code: SafeCode = raw === 'AUTH_BLOCKED' || raw === 'TOOL_SURFACE_MISMATCH' ? raw : 'HEALTH_UNKNOWN';
    return { state: code === 'HEALTH_UNKNOWN' ? 'UNKNOWN' : 'BLOCKED', code, generation, releaseDigest, observedAtMs };
  }
}
