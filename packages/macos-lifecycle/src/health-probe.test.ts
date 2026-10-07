import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedChild } from './contracts.js';
import { CORE_PROTOCOL, probeCore, validCoreHealth, type CoreConnections, type CoreCredentials,
  type CoreEvidence, type CoreRequest, type OwnedConnection, type WireReply } from './health-probe.js';
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
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function delayConnections(f: ReturnType<typeof fixture>, preparationMs: number, responseMs: number, recheckMs = 0) {
  const open = f.connections.openOwnedConnection.bind(f.connections);
  f.connections.openOwnedConnection = async (owned, port, signal) => {
    await pause(preparationMs);
    const connection = await open(owned, port, signal); if (connection === null) return null;
    return {
      close: connection.close.bind(connection),
      async isCurrent() { await pause(recheckMs); return connection.isCurrent(); },
      async request(...args) { await pause(responseMs); return connection.request(...args); },
    };
  };
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
  it('bounds a hung local connection provider by the complete protocol deadline', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.connections.openOwnedConnection = async () => new Promise(() => undefined);
    let result: CoreEvidence | undefined;
    const work = probeCore(child(), f.connections, f.credentials).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(59999); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result).toMatchObject({ state: 'UNKNOWN' }); expect(f.stats().uses).toBe(0);
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

describe('one absolute owned-health protocol deadline', () => {
  it('allows local preparation and responses below two seconds to compose beyond ten seconds', async () => {
    vi.useFakeTimers(); const f = fixture(); delayConnections(f, 1500, 1500, 1000);
    const work = probeCore(child(), f.connections, f.credentials);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await work).toMatchObject({ state: 'LOCAL_CORE_HEALTHY', code: 'OK' });
    expect(f.stats()).toEqual({ uses: 4, opened: 5, closed: 5 });
    expect(f.trace.filter(kind => ['health', 'initialize', 'initialized', 'tools', 'call'].includes(kind)))
      .toEqual(['health', 'initialize', 'initialized', 'tools', 'call']);
  });
  it('does not reset the sixty-second budget after each successful request', async () => {
    vi.useFakeTimers(); const f = fixture(); delayConnections(f, 12000, 1000);
    let result: CoreEvidence | undefined;
    const work = probeCore(child(), f.connections, f.credentials).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(59999); expect(result).toBeUndefined();
      expect(f.trace.filter(kind => ['health', 'initialize', 'initialized', 'tools', 'call'].includes(kind)))
        .toEqual(['health', 'initialize', 'initialized', 'tools']);
      await vi.advanceTimersByTimeAsync(1); await work;
      expect(result).toMatchObject({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.trace).not.toContain('call'); expect(f.stats().uses).toBe(3);
    } finally { await vi.runAllTimersAsync(); await work; }
  });
  it.each([59999, 60000])('includes the last ownership recheck at %i milliseconds in the same budget', async delay => {
    vi.useFakeTimers(); const f = fixture(); const open = f.connections.openOwnedConnection.bind(f.connections);
    let checks = 0;
    f.connections.openOwnedConnection = async (...args) => {
      const connection = await open(...args); if (connection === null) return null;
      return { ...connection, async isCurrent() { if (++checks === 10) await pause(delay); return connection.isCurrent(); } };
    };
    let result: CoreEvidence | undefined;
    const work = probeCore(child(), f.connections, f.credentials).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1); await work;
      expect(result?.state).toBe(delay === 59999 ? 'LOCAL_CORE_HEALTHY' : 'UNKNOWN');
      expect(f.stats()).toEqual({ uses: 4, opened: 5, closed: 5 });
    } finally { await vi.runAllTimersAsync(); await work; }
  });
  it('checks the absolute deadline before accepting a late local preparation even before timer dispatch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture();
    const open = f.connections.openOwnedConnection.bind(f.connections);
    f.connections.openOwnedConnection = async (...args) => {
      const connection = await open(...args); vi.setSystemTime(60000); return connection;
    };
    const result = await probeCore(child(), f.connections, f.credentials);
    expect(result.state).toBe('UNKNOWN'); expect(f.trace).toEqual(['open']); expect(f.stats().uses).toBe(0);
  });
  it.each(['caller', 'total'] as const)('closes a connection delivered after the %s deadline without requesting or authenticating', async kind => {
    vi.useFakeTimers(); const f = fixture(); const parent = new AbortController();
    const ready = deferred<OwnedConnection | null>(); let result: CoreEvidence | undefined;
    const close = vi.fn(); const request = vi.fn(async () => reply('health')); const current = vi.fn(async () => true);
    f.connections.openOwnedConnection = async () => ready.promise;
    const work = probeCore(child(), f.connections, f.credentials, { signal: parent.signal }).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(kind === 'caller' ? 4999 : 59999); expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1); if (kind === 'caller') parent.abort('SYNTHETIC_PRIVATE_ABORT');
      await work; expect(result).toMatchObject({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN' });
      ready.resolve({ close, request, isCurrent: current }); await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      expect(f.stats().uses).toBe(0); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
    } finally { parent.abort(); ready.resolve(null); await work; }
  });
  it.each(['read', 'callback'] as const)('prevents late credential %s after cancellation or the complete deadline', async phase => {
    vi.useFakeTimers(); const parent = new AbortController(); const entered = deferred<void>(); const resume = deferred<void>();
    const kinds: CoreRequest[] = []; let providerReads = 0; let delivered = 0; let result: CoreEvidence | undefined;
    const credentials: CoreCredentials = { async withValue(use) {
      providerReads++;
      if (phase === 'callback') { entered.resolve(); await resume.promise; }
      return use('SYNTHETIC_PRIVATE_CREDENTIAL');
    } };
    const connections: CoreConnections = { async openOwnedConnection() { return {
      async isCurrent() { return true; }, close() {},
      async request(kind, broker) {
        kinds.push(kind);
        if (kind === 'health') return reply(kind);
        if (phase === 'read') { entered.resolve(); await resume.promise; }
        return broker.withValue(async () => { delivered++; return reply(kind); });
      },
    }; } };
    const work = probeCore(child(), connections, credentials, { signal: parent.signal }).then(value => { result = value; });
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(phase === 'read' ? 4999 : 59999); expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1); if (phase === 'read') parent.abort();
      await work; expect(result).toMatchObject({ state: 'UNKNOWN', code: 'HEALTH_UNKNOWN' });
      resume.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(providerReads).toBe(phase === 'read' ? 0 : 1); expect(delivered).toBe(0);
      expect(kinds).toEqual(['health', 'initialize']); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
    } finally { parent.abort(); resume.resolve(); await work; }
  });
});
