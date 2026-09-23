import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { createConnection, Socket } from 'node:net';
import type { OwnedChild } from '../contracts.js';
import { abortable, copyCoreChild, CORE_PROTOCOL, type CoreConnections, type CoreCredentials,
  type CoreRequest, type OwnedConnection, type WireReply } from '../health-probe.js';

/** INTERNAL trusted dependency. current must bind a live registered child handle,
 * generation, start identity and sealed release. verify must inspect this exact
 * established socket's accepted peer. No implementation is inferred from a PID,
 * port, callback type or serialized claim. Missing proof always fails closed. */
export interface ConnectedPeerVerifier {
  current(child: OwnedChild): Promise<boolean>;
  verify(socket: Socket, child: OwnedChild, signal: AbortSignal): Promise<'OWNED' | 'FOREIGN' | 'UNKNOWN'>;
}
function fail(): never { throw new Error('HEALTH_UNKNOWN'); }
function printable(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[^\x21-\x7e]/u.test(value);
}
function connected(socket: Socket): boolean {
  return !socket.destroyed && !socket.connecting && socket.readable && socket.writable
    && socket.localAddress === '127.0.0.1' && socket.remoteAddress === '127.0.0.1'
    && typeof socket.localPort === 'number' && typeof socket.remotePort === 'number';
}
function wire(kind: CoreRequest): { path: '/healthz' | '/mcp'; method: 'GET' | 'POST'; body: string } {
  switch (kind) {
    case 'health': return { path: '/healthz', method: 'GET', body: '' };
    case 'initialize': return { path: '/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
      method: 'initialize', params: { protocolVersion: CORE_PROTOCOL, capabilities: {},
        clientInfo: { name: 'gram-lifecycle-health', version: '0.0.0' } } }) };
    case 'initialized': return { path: '/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) };
    case 'tools': return { path: '/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) };
    case 'call': return { path: '/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3,
      method: 'tools/call', params: { name: 'agent_health', arguments: {} } }) };
    default: return fail();
  }
}
/** One request, one preconnected socket. No pooling, redirect, proxy, retry, URL
 * input or fallback createConnection. Raw bytes remain local and bounded. */
async function exchange(socket: Socket, kind: CoreRequest, secret: string | undefined,
  session: string | undefined, signal: AbortSignal): Promise<WireReply> {
  const w = wire(kind);
  if (!connected(socket) || signal.aborted) fail();
  const headers: Record<string, string> = { host: `127.0.0.1:${socket.remotePort}`, connection: 'close',
    accept: 'application/json, text/event-stream' };
  if (kind !== 'health') {
    if (!printable(secret, 1024) || (session !== undefined && !printable(session, 256))) fail();
    headers['x-gram-agent-auth'] = secret;
    headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(w.body));
    headers['mcp-protocol-version'] = CORE_PROTOCOL;
    if (session !== undefined) headers['mcp-session-id'] = session;
  }
  const agent = new Agent({ keepAlive: false, maxSockets: 1 }); let loaned = false;
  agent.createConnection = () => { if (loaned || !connected(socket) || signal.aborted) fail(); loaned = true; return socket; };
  let req: ClientRequest | undefined; let response: IncomingMessage | undefined;
  try {
    return await new Promise<WireReply>((resolve, reject) => {
      let settled = false; let count = 0; const chunks: Buffer[] = [];
      const done = (value?: WireReply) => {
        if (settled) return; settled = true; signal.removeEventListener('abort', abort);
        if (value) resolve(value); else reject(new Error('HEALTH_UNKNOWN'));
      };
      const abort = () => { done(); response?.destroy(); req?.destroy(); socket.destroy(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        req = httpRequest({ host: '127.0.0.1', port: socket.remotePort, method: w.method, path: w.path,
          headers, agent, maxHeaderSize: 65536, insecureHTTPParser: false }, res => {
          response = res;
          const encoding = res.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') { abort(); return; }
          const contentType = res.headers['content-type']; const sessionId = res.headers['mcp-session-id'];
          if (Array.isArray(contentType) || Array.isArray(sessionId)
            || (sessionId !== undefined && !printable(sessionId, 256))) { abort(); return; }
          res.on('data', (chunk: Buffer) => {
            if (!Buffer.isBuffer(chunk) || count + chunk.length > 65536 || chunks.length >= 1024) { abort(); return; }
            count += chunk.length; chunks.push(Buffer.from(chunk));
          });
          res.once('error', () => done()); res.once('aborted', () => done());
          res.once('end', () => {
            if (!res.complete || signal.aborted) { done(); return; }
            done({ status: res.statusCode ?? 0, contentType: contentType ?? '', body: Buffer.concat(chunks, count),
              ...(sessionId === undefined ? {} : { sessionId }) });
          });
        });
        req.once('socket', actual => { if (actual !== socket) { actual.destroy(); abort(); } else socket.resume(); });
        req.once('error', () => done()); req.once('upgrade', (_res, actual) => { actual.destroy(); abort(); });
        req.end(w.body);
      } catch { abort(); }
    });
  } finally { response?.destroy(); req?.destroy(); agent.destroy(); socket.destroy(); }
}

/** Takes exclusive ownership of an already connected local socket. This internal
 * capability seam permits isolated ephemeral-port fixtures; it is not exposed by
 * CLI/MCP. The production dialer below has only the fixed core endpoint. */
export async function bindOwnedConnection(socket: Socket, child: OwnedChild, verifier: ConnectedPeerVerifier | undefined,
  signal: AbortSignal): Promise<OwnedConnection | null> {
  if (!(socket instanceof Socket)) return null;
  const guard = () => undefined; socket.on('error', guard); socket.once('close', () => socket.off('error', guard));
  let owned: OwnedChild;
  try {
    owned = copyCoreChild(child);
    if (!verifier || signal.aborted || !connected(socket)
      || !await abortable(verifier.current(owned), signal)
      || await abortable(verifier.verify(socket, owned, signal), signal) !== 'OWNED'
      || signal.aborted || !connected(socket)) { socket.destroy(); return null; }
  } catch { socket.destroy(); return null; }
  const proof = verifier; let used = false; let closed = false;
  const close = () => { closed = true; socket.destroy(); };
  const assertOwned = async (abort: AbortSignal) => {
    if (closed || abort.aborted || !connected(socket) || socket.readableLength !== 0) fail();
    if (!await abortable(proof.current(owned), abort)
      || await abortable(proof.verify(socket, owned, abort), abort) !== 'OWNED') fail();
    if (closed || abort.aborted || !connected(socket) || socket.readableLength !== 0) fail();
  };
  return Object.freeze({
    async isCurrent() { try { return !signal.aborted && await abortable(proof.current(owned), signal); } catch { return false; } },
    close,
    async request(kind: CoreRequest, credentials: CoreCredentials, session: string | undefined, parent: AbortSignal) {
      const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 2000);
      const abort = AbortSignal.any([signal, parent, deadline.signal]);
      try {
        if (used || closed || abort.aborted) fail(); used = true; wire(kind);
        await assertOwned(abort);
        if (kind === 'health') return await exchange(socket, kind, undefined, undefined, abort);
        let sent = false;
        const result = await abortable(credentials.withValue(async value => {
          if (sent || !printable(value, 1024)) fail();
          await assertOwned(abort); sent = true;
          return exchange(socket, kind, value, session, abort);
        }), abort);
        if (!sent || abort.aborted) fail(); return result;
      } catch { return fail(); }
      finally { clearTimeout(timer); close(); deadline.abort(); }
    },
  });
}
export function createLoopbackConnections(verifier?: ConnectedPeerVerifier): CoreConnections {
  return Object.freeze({ async openOwnedConnection(child: OwnedChild, port: 3847, parent: AbortSignal) {
    if (!verifier || port !== 3847 || parent.aborted) return null;
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 2000);
    const signal = AbortSignal.any([parent, deadline.signal]); let socket: Socket | undefined;
    const abort = () => socket?.destroy(); signal.addEventListener('abort', abort, { once: true });
    try {
      const owned = copyCoreChild(child);
      if (!await abortable(verifier.current(owned), signal)) return null;
      socket = createConnection({ host: '127.0.0.1', port: 3847 });
      const active = socket; active.on('error', () => undefined);
      await abortable(new Promise<void>((resolve, reject) => {
        active.once('error', reject); active.once('connect', () => { active.removeListener('error', reject); active.pause(); resolve(); });
      }), signal);
      return await bindOwnedConnection(active, owned, verifier, parent);
    } catch { socket?.destroy(); return null; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  } });
}
