import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadonlyDatabaseConfig } from './database-config.js';
import type { DatabaseRuntime, DatabaseRuntimeOptions } from './database-runtime.js';
import { startAgent, type RunningAgent } from './main.js';
import * as persistence from '@gram/persistence';
import { TaskRunner } from '@gram/task-engine';
import { StructuredLogger } from '@gram/observability';

// These mocks exercise Agent composition, not database connectivity or SQL enforcement.
const ports = vi.hoisted(() => ({ configImports: 0, runtimeImports: 0,
  load: vi.fn<(path: string) => ReadonlyDatabaseConfig>(),
  create: vi.fn<(options: DatabaseRuntimeOptions) => DatabaseRuntime>(),
}));
vi.mock('./database-config.js', () => { ports.configImports++;return { loadDatabaseConfig: ports.load }; });
vi.mock('./database-runtime.js', () => { ports.runtimeImports++;return { createDatabaseRuntime: ports.create }; });

const directories: string[] = [];
const running: RunningAgent[] = [];
const secret = 'database-composition-secret';
const config: ReadonlyDatabaseConfig = { version: 1, connections: [{ id: 'reporting', engine: 'mysql',
  host: 'composition-private.invalid', port: 3306, database: 'composition-private-db', user: 'composition-private-user',
  passwordSecret: 'database-readonly-composition-private', tls: {}, maxRows: 500, timeoutMs: 10000, maxBytes: 1048576 }] };
const connections = vi.fn(async () => [{ connectionId: 'reporting', engine: 'mysql' }]);
const select = vi.fn(async () => ({ columns: ['value'], rows: [[1]], truncated: false }));
const closeDatabase = vi.fn(async () => {});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-database-composition-'));directories.push(root);
  const stateDirectory = join(root, 'state');const secretDirectory = join(root, 'secrets');
  mkdirSync(stateDirectory);mkdirSync(secretDirectory, { mode: 0o700 });
  const internalSecret = join(secretDirectory, 'mcp-internal-secret');
  writeFileSync(internalSecret, secret + '\n', { mode: 0o600 });chmodSync(internalSecret, 0o600);
  return { stateDirectory, secretDirectory };
}
async function start(port = 0) {
  const app = await startAgent({ ...fixture(), port, installSignalHandlers: false });running.push(app);return app;
}
async function rpc(app: RunningAgent, method: string, params: unknown) {
  const response = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-gram-agent-auth': secret },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.status).toBe(200);const text = await response.text();
  const json = text.trim().startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))?.slice(6);
  if (!json) throw new Error('Missing MCP response');
  return JSON.parse(json) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
}
async function names(app: RunningAgent) { return (await rpc(app, 'tools/list', {})).result.tools?.map(tool => tool.name) ?? []; }

beforeEach(() => {
  for (const name of ['GRAM_AGENT_DATABASE_CONFIG', 'GRAM_AGENT_OWNER_WORKSPACE_CONFIG', 'GRAM_AGENT_EGO_BROWSER_MODE',
    'GRAM_AGENT_SMOKE_REPOSITORY_ID', 'GRAM_AGENT_LOCAL_FS_ROOTS_JSON', 'GRAM_AGENT_READONLY_PROJECT_ROOT']) vi.stubEnv(name, undefined);
  ports.load.mockReset().mockReturnValue(config);
  connections.mockClear();select.mockClear();closeDatabase.mockReset().mockResolvedValue(undefined);
  ports.create.mockReset().mockImplementation(() => ({ tools: { connections, select }, close: closeDatabase }));
});
afterEach(async () => {
  while (running.length) await running.pop()?.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('optional read-only database Agent composition', () => {
  it('keeps the existing catalog and does not import or instantiate DB modules without configuration', async () => {
    expect(ports.configImports).toBe(0);expect(ports.runtimeImports).toBe(0);
    const app = await start();
    expect(app.health()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
    const tools = await names(app);
    expect(tools).not.toContain('database_connections');expect(tools).not.toContain('database_select');
    expect(ports.configImports).toBe(0);expect(ports.runtimeImports).toBe(0);
    expect(ports.load).not.toHaveBeenCalled();expect(ports.create).not.toHaveBeenCalled();
    await app.close();expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('validates trusted configuration before constructing or importing the driver runtime', async () => {
    vi.stubEnv('GRAM_AGENT_DATABASE_CONFIG', '/etc/gram-coding-agent/database-invalid.json');
    ports.load.mockImplementation(() => { throw new Error('Database configuration denied'); });
    const attempt = startAgent({ ...fixture(), port: 0, installSignalHandlers: false }).then(app => { running.push(app);return app; });
    await expect(attempt).rejects.toThrow(/^Database configuration denied$/u);
    expect(ports.load).toHaveBeenCalledExactlyOnceWith('/etc/gram-coding-agent/database-invalid.json');
    expect(ports.runtimeImports).toBe(0);expect(ports.create).not.toHaveBeenCalled();
  });

  it('adds exactly two tools from a lazy trusted runtime while preserving normal health and public metadata', async () => {
    const baseline = await start();const original = await names(baseline);await baseline.close();
    vi.stubEnv('GRAM_AGENT_DATABASE_CONFIG', '/etc/gram-coding-agent/databases.json');
    const app = await start();
    expect(ports.load).toHaveBeenCalledExactlyOnceWith('/etc/gram-coding-agent/databases.json');
    expect(ports.create).toHaveBeenCalledTimes(1);
    const options = ports.create.mock.calls[0]?.[0];
    expect(options?.config).toBe(config);expect(typeof options?.secrets.getForUse).toBe('function');
    expect(options?.redactor.redact(secret)).toBe('***REDACTED***');
    expect(connections).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
    expect(app.health()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
    expect((await names(app)).sort()).toEqual([...original, 'database_connections', 'database_select'].sort());
    const listed = (await rpc(app, 'tools/call', { name: 'database_connections', arguments: {} })).result;
    expect(JSON.parse(listed.content?.[0]?.text ?? '')).toEqual([{ connectionId: 'reporting', engine: 'mysql' }]);
    expect(JSON.stringify(listed)).not.toMatch(/composition-private|database-readonly|database-composition-secret/u);
    const input = { connectionId: 'reporting', sql: 'SELECT ? AS value', parameters: [1] };
    const result = (await rpc(app, 'tools/call', { name: 'database_select', arguments: input })).result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? '')).toEqual({ columns: ['value'], rows: [[1]], truncated: false });
    expect(select).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
  });

  it('stops accepting MCP requests while DB shutdown drains and keeps SQLite open until it settles', async () => {
    vi.stubEnv('GRAM_AGENT_DATABASE_CONFIG', '/etc/gram-coding-agent/databases.json');
    let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
    closeDatabase.mockImplementation(() => gate);
    const app = await start();let settled = false;
    const closing = app.close();void closing.then(() => { settled = true; }, () => { settled = true; });
    try {
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      let stopped = false;
      for (let attempt = 0; attempt < 10 && !stopped; attempt++) {
        try { const response = await fetch(`${app.url}/healthz`);await response.text(); }
        catch { stopped = true; }
      }
      expect(stopped).toBe(true);expect(settled).toBe(false);
      expect(app.health()).toEqual({ status: 'degraded', database: 'ok', mcp: 'not_ready' });
      release();await closing;
      expect(app.health()).toEqual({ status: 'degraded', database: 'error', mcp: 'not_ready' });
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally { release();await closing; }
  });

  it('closes the created runtime if MCP cannot bind its requested loopback port', async () => {
    const occupied = createServer();await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    try {
      vi.stubEnv('GRAM_AGENT_DATABASE_CONFIG', '/etc/gram-coding-agent/databases.json');
      const attempt = startAgent({ ...fixture(), port: (occupied.address() as AddressInfo).port, installSignalHandlers: false });
      await expect(attempt).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(ports.create).toHaveBeenCalledTimes(1);expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
  });
});


it('drains existing scheduled work and closes SQLite before reporting a safe DB shutdown failure', async () => {
  vi.stubEnv('GRAM_AGENT_DATABASE_CONFIG', '/etc/gram-coding-agent/databases.json');
  const paths = fixture();const statePath = join(paths.stateDirectory, 'agent.sqlite');
  const originalOpen = persistence.openDatabase;
  const seed = originalOpen(statePath);
  try {
    persistence.runMigrations(seed);
    new persistence.TaskRepository(seed).create({ goal: 'Composition drain fixture', taskType: 'CODING',
      publishMode: 'PULL_REQUEST', repoSelector: 'fixture/repository' });
  } finally { seed.close(); }
  const events: string[] = [];
  let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = vi.spyOn(TaskRunner.prototype, 'run').mockImplementation(async () => {
    await gate;events.push('task-drained');
  });
  let sqlite: ReturnType<typeof persistence.openDatabase> | undefined;
  let restoreClose: (() => void) | undefined;
  const opened = vi.spyOn(persistence, 'openDatabase').mockImplementation(path => {
    const actual = originalOpen(path);
    if (path === statePath) {
      sqlite = actual;const originalClose = actual.close.bind(actual);
      const spy = vi.spyOn(actual, 'close').mockImplementation(() => { events.push('sqlite-close');return originalClose(); });
      restoreClose = () => spy.mockRestore();
    }
    return actual;
  });
  const logged = vi.spyOn(StructuredLogger.prototype, 'info');
  closeDatabase.mockRejectedValue(new Error('private-database-cleanup-marker'));
  let outcome: Promise<unknown> | undefined;
  try {
    const app = await startAgent({ ...paths, port: 0, installSignalHandlers: false });running.push(app);
    expect(runner).toHaveBeenCalledTimes(1);
    let settled = false;
    outcome = app.close().then(() => { settled = true;return undefined; }, error => { settled = true;return error; });
    let stopped = false;
    for (let attempt = 0; attempt < 10 && !stopped; attempt++) {
      try { const response = await fetch(`${app.url}/healthz`);await response.text(); }
      catch { stopped = true; }
    }
    expect(stopped).toBe(true);
    expect(settled).toBe(false);expect(sqlite?.open).toBe(true);
    expect(events).not.toContain('sqlite-close');
    release();const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Database shutdown failed');
    expect(sqlite?.open).toBe(false);
    expect(events).toEqual(['task-drained', 'sqlite-close']);
    expect(app.health()).toEqual({ status: 'degraded', database: 'error', mcp: 'not_ready' });
    expect(logged.mock.calls.some(([message]) => message === 'agent stopped')).toBe(false);
  } finally {
    release();await outcome;
    await new Promise<void>(resolve => setImmediate(resolve));
    // Keep RED fixture failure from leaking its intentionally abandoned SQLite handle.
    if (sqlite?.open) sqlite.close();
    restoreClose?.();opened.mockRestore();runner.mockRestore();logged.mockRestore();
  }
});
