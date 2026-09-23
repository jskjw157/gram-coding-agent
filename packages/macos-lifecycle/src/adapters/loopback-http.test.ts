import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnedChild } from '../contracts.js';
import { probeCore, type CoreCredentials, type CoreConnections } from '../health-probe.js';
import { bindOwnedConnection, createLoopbackConnections, type ConnectedPeerVerifier } from './loopback-http.js';
import { createMcpHttpServer } from '../../../mcp/src/server.js';
const sockets: Socket[] = []; const servers: Server[] = [];
const child = (): OwnedChild => ({ role: 'core', pid: process.pid, uid: 501, startIdentity: 'start-1',
  generation: 'generation-1', releaseDigest: 'a'.repeat(64) });
const signal = () => new AbortController().signal;
const secret = 'SYNTHETIC_LOCAL_AUTH';
function verifier(): ConnectedPeerVerifier { return { async current() { return true; }, async verify() { return 'OWNED'; } }; }
function credential(value = secret) { let uses = 0; const port: CoreCredentials = {
  async withValue(use) { uses++; return use(value); } }; return { port, uses: () => uses }; }
async function connected(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('connect', () => {
    socket.removeListener('error', reject); socket.on('error', () => undefined); socket.pause(); resolve();
  }); }); return socket;
}
async function fixture(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  let bytes = 0; let accepted = 0; const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => { requests.push(req); if (handler) handler(req, res);
    else { res.setHeader('content-type', 'application/json'); res.end('{}'); } }); servers.push(server);
  server.on('connection', socket => { sockets.push(socket); accepted++; socket.on('data', chunk => { bytes += chunk.length; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture address');
  return { port: address.port, requests, bytes: () => bytes, accepted: () => accepted };
}
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
describe('same-socket credential boundary (synthetic verifier, not native ownership proof)', () => {
  it.each(['FOREIGN', 'UNKNOWN'] as const)('sends zero bytes to a %s actual TCP peer', async verdict => {
    const f = await fixture(); const v = verifier(); v.verify = async () => verdict;
    const c = await bindOwnedConnection(await connected(f.port), child(), v, signal());
    expect(c).toBeNull(); await new Promise(resolve => setImmediate(resolve));
    expect(f.bytes()).toBe(0); expect(f.requests).toHaveLength(0);
  });
  it('defaults to unavailable without an independently supplied verifier', async () => {
    const f = await fixture();
    expect(await bindOwnedConnection(await connected(f.port), child(), undefined, signal())).toBeNull();
    expect(await createLoopbackConnections().openOwnedConnection(child(), 3847, signal())).toBeNull();
    expect(f.bytes()).toBe(0);
  });
  it('uses only the checked socket and permits one fixed HTTP exchange', async () => {
    const f = await fixture(); const v = verifier(); const seen: Socket[] = []; const cdt = credential();
    v.verify = async socket => { seen.push(socket); return 'OWNED'; };
    const socket = await connected(f.port); const c = await bindOwnedConnection(socket, child(), v, signal());
    expect(c).not.toBeNull(); if (!c) return;
    const r = await c.request('initialize', cdt.port, undefined, signal());
    expect(r.status).toBe(200); expect(f.accepted()).toBe(1); expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.url).toBe('/mcp'); expect(f.requests[0]?.headers['x-gram-agent-auth']).toBe(secret);
    expect(seen.every(s => s === socket)).toBe(true); expect(seen.length).toBeGreaterThanOrEqual(3);
    await expect(c.request('call', cdt.port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    c.close(); expect(cdt.uses()).toBe(1);
  });
  it('checks ownership again after asynchronous credential acquisition', async () => {
    const f = await fixture(); const v = verifier(); let owned = true; v.current = async () => owned;
    const c = await bindOwnedConnection(await connected(f.port), child(), v, signal()); if (!c) throw new Error('binding');
    const cdt: CoreCredentials = { async withValue(use) { owned = false; return use(secret); } };
    await expect(c.request('initialize', cdt, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(f.bytes()).toBe(0); expect(f.requests).toHaveLength(0);
  });
  it('does not reconnect when the checked socket dies during credential acquisition', async () => {
    const f = await fixture(); const socket = await connected(f.port);
    const c = await bindOwnedConnection(socket, child(), verifier(), signal()); if (!c) throw new Error('binding');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.accepted()).toBe(1);
    const cdt: CoreCredentials = { async withValue(use) { socket.destroy(); return use(secret); } };
    await expect(c.request('initialize', cdt, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(f.accepted()).toBe(1); expect(f.bytes()).toBe(0);
  });
  it('rechecks the established peer, not only a current PID, before sending a token', async () => {
    const f = await fixture(); const v = verifier(); let n = 0;
    v.verify = async () => ++n >= 3 ? 'FOREIGN' : 'OWNED';
    const c = await bindOwnedConnection(await connected(f.port), child(), v, signal()); if (!c) throw new Error('binding');
    await expect(c.request('initialize', credential().port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(f.bytes()).toBe(0);
  });
  it.each(['bad\r\nheader: injected', '', 'x'.repeat(1025)])('refuses invalid credential header values', async value => {
    const f = await fixture(); const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal());
    if (!c) throw new Error('binding');
    await expect(c.request('initialize', credential(value).port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(f.bytes()).toBe(0);
  });
  it('leaves health unauthenticated and does not use the broker', async () => {
    const f = await fixture(); const cdt = credential();
    const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    await c.request('health', cdt.port, undefined, signal()); c.close();
    expect(f.requests[0]?.url).toBe('/healthz'); expect(f.requests[0]?.headers['x-gram-agent-auth']).toBeUndefined();
    expect(cdt.uses()).toBe(0);
  });
  it.each(['body', 'header', 'encoding'] as const)('rejects an oversized or unsupported %s response', async mode => {
    const f = await fixture((_req, res) => { res.setHeader('content-type', 'application/json');
      if (mode === 'header') res.setHeader('x-oversized', 'x'.repeat(65537));
      if (mode === 'encoding') res.setHeader('content-encoding', 'gzip');
      res.end(mode === 'body' ? 'x'.repeat(65537) : '{}'); });
    const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    await expect(c.request('health', credential().port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
  });
  it('uses a total two-second deadline even while bytes continue arriving', async () => {
    const f = await fixture((req, res) => { res.setHeader('content-type', 'application/json'); res.write('{');
      const timer = setInterval(() => res.write(' '), 25); req.socket.once('close', () => clearInterval(timer)); });
    const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    const begin = Date.now();
    await expect(c.request('health', credential().port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(Date.now() - begin).toBeGreaterThanOrEqual(1800); expect(Date.now() - begin).toBeLessThan(6000);
  }, 8000);
  it('does not expose an abort reason or write after a delayed broker returns', async () => {
    const f = await fixture(); const controller = new AbortController(); let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { release = resolve; }); let resume: (() => void) | undefined;
    const held = new Promise<void>(resolve => { resume = resolve; });
    const cdt: CoreCredentials = { async withValue(use) { release?.(); await held; return use(secret); } };
    const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    const check = expect(c.request('initialize', cdt, undefined, controller.signal)).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    await entered; controller.abort('SYNTHETIC_ABORT_SECRET'); resume?.(); await check;
    expect(f.bytes()).toBe(0);
  });
  it('never follows an HTTP redirect to another listener', async () => {
    const destination = await fixture(); const source = await fixture((_req, res) => {
      res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${destination.port}/mcp`); res.end(); });
    const c = await bindOwnedConnection(await connected(source.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    expect((await c.request('health', credential().port, undefined, signal())).status).toBe(302); c.close();
    expect(destination.accepted()).toBe(0);
  });
  it('rejects arbitrary request names without acquiring credentials', async () => {
    const f = await fixture(); const cdt = credential();
    const c = await bindOwnedConnection(await connected(f.port), child(), verifier(), signal()); if (!c) throw new Error('binding');
    await expect(c.request('delete' as 'health', cdt.port, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
    expect(cdt.uses()).toBe(0); expect(f.bytes()).toBe(0);
  });
});
describe('pinned repository MCP compatibility (real server, synthetic ownership)', () => {
  it.each([true, false])('verifies the actual health-only server; correct credential=%s', async correct => {
    const app = await createMcpHttpServer({ host: '127.0.0.1', port: 0, internalSecret: secret,
      health: () => ({ status: 'healthy', database: 'ok', mcp: 'ready' }) });
    const connections: CoreConnections = { async openOwnedConnection(owned, _port, abort) {
      return bindOwnedConnection(await connected(app.port), owned, verifier(), abort);
    } };
    try {
      const result = await probeCore(child(), connections, credential(correct ? secret : 'wrong-synthetic').port);
      expect(result).toMatchObject(correct ? { state: 'LOCAL_CORE_HEALTHY', code: 'OK' }
        : { state: 'BLOCKED', code: 'AUTH_BLOCKED' });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally { for (const socket of sockets) socket.destroy(); await app.close(); }
  }, 10000);
});
