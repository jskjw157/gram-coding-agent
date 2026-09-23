import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedChild } from './contracts.js';
import { CORE_PROTOCOL, probeCore, validCoreHealth, type CoreConnections, type CoreCredentials,
  type CoreRequest, type WireReply } from './health-probe.js';
const child = (): OwnedChild => ({ role: 'core', pid: 123, startIdentity: 'start-1', generation: 'generation-1',
  releaseDigest: 'a'.repeat(64), uid: 501 });
const healthy = { status: 'healthy', database: 'ok', mcp: 'ready' };
function reply(kind: CoreRequest): WireReply {
  const results = {
    health: healthy,
    initialize: { jsonrpc: '2.0', id: 1, result: { protocolVersion: CORE_PROTOCOL,
      capabilities: { tools: {} }, serverInfo: { name: 'gram-coding-agent', version: '0.0.0' } } },
    initialized: null,
    tools: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'agent_health', inputSchema: { type: 'object' } }] } },
    call: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(healthy) }] } },
  };
  return { status: kind === 'initialized' ? 202 : 200, contentType: 'application/json',
    body: kind === 'initialized' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(results[kind])) };
}
function fixture(change?: (kind: CoreRequest, base: WireReply) => WireReply) {
  const trace: string[] = []; let current = true; let foreign = false; let uses = 0; let opened = 0; let closed = 0;
  const credentials: CoreCredentials = { async withValue(use) { uses++; trace.push('credential'); return use('SYNTHETIC_TEST_SECRET'); } };
  const connections: CoreConnections = { async openOwnedConnection(_child, port, signal) {
    expect(port).toBe(3847); trace.push('open'); opened++;
    if (foreign || signal.aborted) return null;
    return { async isCurrent() { trace.push('verify'); return current; }, close() { closed++; },
      async request(kind, broker, session) {
        trace.push(kind); if (session !== undefined) trace.push('session');
        if (kind !== 'health') await broker.withValue(async () => undefined);
        return change ? change(kind, reply(kind)) : reply(kind);
      },
    };
  } };
  return { trace, connections, credentials, stats: () => ({ uses, opened, closed }),
    foreign() { foreign = true; }, stale() { current = false; } };
}
afterEach(() => vi.useRealTimers());
describe('owned core health protocol', () => {
  it('does not obtain a credential or send a request to an unknown or foreign peer', async () => {
    const f = fixture(); f.foreign();
    expect(await probeCore(child(), f.connections, f.credentials)).toMatchObject({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN' });
    expect(f.stats().uses).toBe(0); expect(f.trace).toEqual(['open']);
  });
  it('checks current identity before any HTTP request and credential use', async () => {
    const f = fixture(); f.stale();
    expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
    expect(f.stats()).toEqual({ uses: 0, opened: 1, closed: 1 });
  });
  it('requires health, initialize, notification, exact tool list and health call', async () => {
    const f = fixture();
    expect(await probeCore(child(), f.connections, f.credentials)).toEqual({ state: 'LOCAL_CORE_HEALTHY', code: 'OK',
      generation: 'generation-1', releaseDigest: 'a'.repeat(64), observedAtMs: expect.any(Number) });
    expect(f.stats()).toEqual({ uses: 4, opened: 5, closed: 5 });
    expect(f.trace.filter(t => ['health', 'initialize', 'initialized', 'tools', 'call'].includes(t)))
      .toEqual(['health', 'initialize', 'initialized', 'tools', 'call']);
  });
  it.each([[], ['task_create'], ['agent_health', 'task_create'], ['agent_health', 'agent_health']].map(names => ({ names })))(
    'blocks an unexpected tool surface $names', async ({ names }) => {
      const f = fixture((kind, r) => kind === 'tools' ? { ...r,
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: names.map(name => ({ name })) } })) } : r);
      expect(await probeCore(child(), f.connections, f.credentials)).toMatchObject({ state: 'BLOCKED', code: 'TOOL_SURFACE_MISMATCH' });
      expect(f.trace).not.toContain('call');
    });
  it('refuses a continuation cursor instead of accepting a partial tool list', async () => {
    const f = fixture((kind, r) => kind === 'tools' ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2,
      result: { tools: [{ name: 'agent_health' }], nextCursor: 'more' } })) } : r);
    expect((await probeCore(child(), f.connections, f.credentials)).code).toBe('TOOL_SURFACE_MISMATCH');
  });
  it.each([401, 403])('blocks credential retries after HTTP %i', async status => {
    const f = fixture((kind, r) => kind === 'initialize' ? { ...r, status } : r);
    expect(await probeCore(child(), f.connections, f.credentials)).toMatchObject({ state: 'BLOCKED', code: 'AUTH_BLOCKED' });
    expect(f.stats()).toEqual({ uses: 1, opened: 2, closed: 2 });
  });
  it.each([Buffer.alloc(0), Buffer.from('{broken'), Buffer.alloc(65537), Buffer.from([0xff]),
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })),
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'SYNTHETIC_TEST_SECRET' } }))])(
    'refuses invalid protocol responses without disclosing them', async body => {
      const f = fixture((kind, r) => kind === 'initialize' ? { ...r, body } : r);
      const result = await probeCore(child(), f.connections, f.credentials);
      expect(result.state).toBe('UNKNOWN'); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
    });
  it.each([301, 302, 307, 500])('does not follow redirect/error HTTP %i', async status => {
    const f = fixture((kind, r) => kind === 'health' ? { ...r, status } : r);
    expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
    expect(f.stats().uses).toBe(0);
  });
  it('rejects unsupported negotiated protocol and unexpected initialized bodies', async () => {
    for (const badStep of ['initialize', 'initialized'] as const) {
      const f = fixture((kind, r) => kind !== badStep ? r : kind === 'initialize'
        ? { ...r, body: Buffer.from(r.body.toString().replace(CORE_PROTOCOL, 'unsupported')) }
        : { ...r, body: Buffer.from('not empty') });
      expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
    }
  });
  it('refuses nonhealthy source values, extra health fields and tool errors', async () => {
    const values = [{ status: 'healthy', database: 'bad', mcp: 'ready' }, { ...healthy, extra: true }, { status: 'healthy' }];
    for (const value of values) {
      const f = fixture((kind, r) => kind === 'call' ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3,
        result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })) } : r);
      expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
    }
    const f = fixture((kind, r) => kind === 'call' ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(healthy) }] } })) } : r);
    expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
  });
  it('accepts one bounded MCP SSE response but rejects a second message', async () => {
    for (const repeat of [1, 2]) {
      const f = fixture((kind, r) => kind === 'call' ? { ...r, contentType: 'text/event-stream',
        body: Buffer.from(('event: message\ndata: ' + r.body.toString() + '\n\n').repeat(repeat)) } : r);
      expect((await probeCore(child(), f.connections, f.credentials)).state)
        .toBe(repeat === 1 ? 'LOCAL_CORE_HEALTHY' : 'UNKNOWN');
    }
  });
  it('keeps a validated session ID local and refuses a changed session', async () => {
    const f = fixture((kind, r) => kind === 'initialize' ? { ...r, sessionId: 'synthetic-session' } : r);
    const result = await probeCore(child(), f.connections, f.credentials);
    expect(result.state).toBe('LOCAL_CORE_HEALTHY'); expect(JSON.stringify(result)).not.toContain('synthetic-session');
    expect(f.trace.filter(t => t === 'session')).toHaveLength(3);
    const g = fixture((kind, r) => ['initialize', 'tools'].includes(kind) ? { ...r, sessionId: kind } : r);
    expect((await probeCore(child(), g.connections, g.credentials)).state).toBe('UNKNOWN');
  });
  it('discards an observation if ownership changes during a response', async () => {
    const f = fixture((kind, r) => { if (kind === 'call') f.stale(); return r; });
    expect((await probeCore(child(), f.connections, f.credentials)).state).toBe('UNKNOWN');
  });
  it('bounds a hung connection before any credentials are obtained', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.connections.openOwnedConnection = async () => new Promise(() => undefined);
    const check = expect(probeCore(child(), f.connections, f.credentials)).resolves.toMatchObject({ state: 'UNKNOWN' });
    await vi.advanceTimersByTimeAsync(2000); await check; expect(f.stats().uses).toBe(0);
  });
  it('does not start when already aborted and does not echo abort reasons', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort('SYNTHETIC_TEST_SECRET');
    const result = await probeCore(child(), f.connections, f.credentials, { signal: controller.signal });
    expect(result.state).toBe('UNKNOWN'); expect(f.stats().opened).toBe(0); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });
  it('validates owned-child claims before echoing values or contacting ports', async () => {
    const f = fixture();
    const result = await probeCore({ ...child(), generation: 'SYNTHETIC SECRET', uid: 0 }, f.connections, f.credentials);
    expect(result.state).toBe('UNKNOWN'); expect(f.stats().opened).toBe(0); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });
  it('does not accept accessors as a healthy body', () => {
    let reads = 0; const value = { ...healthy, get status() { reads++; return 'healthy'; } };
    expect(validCoreHealth(value)).toBe(false); expect(reads).toBe(0); expect(validCoreHealth(healthy)).toBe(true);
  });
});
