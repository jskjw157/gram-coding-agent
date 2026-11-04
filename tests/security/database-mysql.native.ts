import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lookup } from 'node:dns/promises';
import { createDatabaseRuntime, type DatabaseRuntime } from '../../apps/agent/src/database-runtime.js';
import type { DatabaseConnectionConfig } from '../../apps/agent/src/database-config.js';
import { FileSecretProvider, SecretRedactor } from '../../packages/secrets/src/index.js';
import { createMcpHttpServer } from '../../packages/mcp/src/index.js';

interface EngineFixture {
  engine: 'mysql' | 'mariadb'; id: string; port: number; containerId: string; containerName: string;
}
interface DatabaseFixture { caFile: string; secretDirectory: string; engines: EngineFixture[] }
interface FixtureConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}
interface FixtureDriver { createConnection(options: Record<string, unknown>): Promise<FixtureConnection> }
const require = createRequire(new URL('../../apps/agent/package.json', import.meta.url));
const driver = require('mariadb') as FixtureDriver;
const file = process.env.GRAM_DB_FIXTURE_FILE;
if (!file) throw new Error('GRAM_DB_FIXTURE_FILE is required; use the isolated database fixture script');
const fileStat = statSync(file);
if (!file.startsWith('/tmp/gram-db-fixture.') || fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o077) !== 0 || fileStat.nlink !== 1) {
  throw new Error('Unsafe database fixture manifest');
}
const fixture = JSON.parse(readFileSync(file, 'utf8')) as DatabaseFixture;
if (fixture.engines.length !== 2 || fixture.engines.map(row => row.engine).sort().join(',') !== 'mariadb,mysql') throw new Error('Both isolated engines are required');
const ca = readFileSync(fixture.caFile, 'utf8');
for (const engine of fixture.engines) {
  const inspect = JSON.parse(execFileSync('docker', ['inspect', engine.containerId], { encoding: 'utf8' })) as {
    Id: string; Name: string; Config: { Labels: Record<string, string> }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> };
  }[];
  const instance = inspect[0];
  const ports = instance?.NetworkSettings.Ports['3306/tcp'];
  if (instance?.Id !== engine.containerId || instance.Name !== '/' + engine.containerName ||
      instance.Config.Labels['gram.fixture'] !== 'readonly-db' || ports?.length !== 1 ||
      ports[0]?.HostIp !== '127.0.0.1' || Number(ports[0].HostPort) !== engine.port) {
    throw new Error('Fixture container identity or loopback binding mismatch');
  }
}
const secrets = new FileSecretProvider(fixture.secretDirectory);
const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });

function config(engine: EngineFixture, override: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return {
    id: engine.id, engine: engine.engine, host: '127.0.0.1', port: engine.port, database: 'gram_fixture',
    user: 'gram_readonly', passwordSecret: 'database-readonly-' + engine.id,
    tls: { ca }, maxRows: 500, timeoutMs: 10000, maxBytes: 1048576, ...override,
  };
}
function runtime(engine: EngineFixture, override: Partial<DatabaseConnectionConfig> = {}): DatabaseRuntime {
  const value = createDatabaseRuntime({ config: { version: 1, connections: [config(engine, override)] },
    secrets, redactor: new SecretRedactor(['fixture-mcp-authentication-secret']) });
  runtimes.push(value);
  return value;
}
async function connection(engine: EngineFixture, role: 'admin' | 'readonly' | 'writer'): Promise<FixtureConnection> {
  const secret = role === 'admin' ? 'fixture-admin-' + engine.engine : 'database-readonly-' + engine.engine + (role === 'readonly' ? '-fixture' : '-writer');
  const lease = await secrets.getForUse(secret);
  try {
    return await lease.withValue(password => driver.createConnection({
      host: '127.0.0.1', port: engine.port, database: 'gram_fixture',
      user: role === 'admin' ? 'root' : 'gram_' + role, password,
      ssl: { ca, rejectUnauthorized: true }, multipleStatements: false, permitLocalInfile: false,
      connectTimeout: 5000, maxAllowedPacket: 4194304, maxAllowedColumns: 128,
    }));
  } finally { lease.dispose(); }
}
async function sentinelUnchanged(engine: EngineFixture): Promise<void> {
  const admin = await connection(engine, 'admin');
  try {
    const rows = await admin.query('SELECT value FROM sentinel WHERE id=1');
    expect(JSON.stringify(rows).includes('unchanged')).toBe(true);
  } finally { await admin.end(); }
}
async function activeHeavyQueries(admin: FixtureConnection): Promise<number> {
  const rows = await admin.query("SELECT ID FROM information_schema.PROCESSLIST WHERE USER='gram_readonly' AND DB='gram_fixture' AND INFO LIKE '%gram_fixture_heavy%'");
  if (!Array.isArray(rows)) throw new Error('Invalid fixture process-list response');
  return rows.length;
}
async function waitForHeavyQuery(admin: FixtureConnection): Promise<void> {
  const limit = performance.now() + 8000;
  while (performance.now() < limit) {
    if (await activeHeavyQueries(admin) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Real fixture query did not enter the server process list');
}
const heavySql = 'SELECT SUM(a.n*b.n*c.n) AS gram_fixture_heavy FROM numbers a CROSS JOIN numbers b CROSS JOIN numbers c';
async function rpc(url: string, name: string, args: Record<string, unknown>, auth = 'fixture-mcp-authentication-secret'): Promise<{ status: number; value?: unknown }> {
  const response = await fetch(url + '/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-gram-agent-auth': auth,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  if (response.status !== 200) return { status: response.status };
  const body = await response.text();
  const line = body.trim().startsWith('{') ? body : body.split('\n').find(value => value.startsWith('data: '))?.slice(6);
  if (!line) throw new Error('Missing fixture MCP response');
  const envelope = JSON.parse(line) as { error?: unknown; result?: { isError?: boolean; content?: { type: string; text?: string }[] } };
  if (envelope.error || envelope.result?.isError) throw new Error('Fixture MCP call failed');
  const text = envelope.result?.content?.find(value => value.type === 'text')?.text;
  if (text === undefined) throw new Error('Missing fixture MCP text response');
  return { status: response.status, value: JSON.parse(text) as unknown };
}

describe.each(fixture.engines)('$engine real read-only database', engine => {
  it('returns an actual prepared SELECT result with verified TLS', async () => {
    const result = await runtime(engine).tools.select({ connectionId: engine.id, sql: 'SELECT 42 AS answer' }, new AbortController().signal);
    expect(result.columns).toEqual(['answer']);
    expect(result.rows).toEqual([[engine.engine === 'mysql' ? '42' : 42]]);
    expect(result.truncated).toBe(false);
    const admin = await connection(engine, 'admin');
    try {
      const cipher = await admin.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      const row: unknown = Array.isArray(cipher) ? cipher[0] : undefined;
      expect(row !== null && typeof row === 'object' && 'Value' in row && typeof row.Value === 'string' && row.Value.length > 0).toBe(true);
    } finally { await admin.end(); }
  });

  it('preserves duplicate columns and binds hostile-looking values as data', async () => {
    const data = "value'); DROP TABLE sentinel; --";
    const result = await runtime(engine).tools.select({
      connectionId: engine.id, sql: 'SELECT ? AS same, ? AS same', parameters: [11, data],
    }, new AbortController().signal);
    expect(result.columns).toEqual(['same', 'same']);
    expect(result.rows.length === 1 && result.rows[0]?.[0] === (engine.engine === 'mysql' ? '11' : 11) && result.rows[0]?.[1] === data).toBe(true);
    await sentinelUnchanged(engine);
  });

  it('preserves exact large integers, decimals and explicit binary encoding', async () => {
    const result = await runtime(engine).tools.select({
      connectionId: engine.id,
      sql: "SELECT CAST(9007199254740993 AS SIGNED) AS exact_value, CAST(1234567890.123456789 AS DECIMAL(30,9)) AS precise_value, CAST('abc' AS BINARY) AS binary_value",
    }, new AbortController().signal);
    expect(result.rows[0]?.[0] === '9007199254740993').toBe(true);
    expect(result.rows[0]?.[1] === '1234567890.123456789').toBe(true);
    expect(result.rows[0]?.[2] === 'base64:YWJj').toBe(true);
  });

  it('uses a genuinely restricted account and server read-only transaction', async () => {
    const reader = await connection(engine, 'readonly');
    try { await expect(reader.query("UPDATE sentinel SET value='changed' WHERE id=1")).rejects.toBeDefined(); }
    finally { await reader.end(); }
    const writer = await connection(engine, 'writer');
    try {
      await writer.query('START TRANSACTION READ ONLY');
      await expect(writer.query("UPDATE sentinel SET value='changed' WHERE id=1")).rejects.toBeDefined();
    } finally { await writer.query('ROLLBACK'); await writer.end(); }
    await sentinelUnchanged(engine);
  });

  it('rejects write-capable accounts, statement mutations and unsafe functions', async () => {
    const writer = runtime(engine, { id: engine.engine + '-writer', user: 'gram_writer', passwordSecret: 'database-readonly-' + engine.engine + '-writer' });
    await expect(writer.tools.select({ connectionId: engine.engine + '-writer', sql: 'SELECT 42' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    const reader = runtime(engine);
    for (const sql of ["UPDATE sentinel SET value='changed'", 'SELECT 1; DELETE FROM sentinel', "SELECT LOAD_FILE('/etc/passwd')", 'SELECT SLEEP(10)']) {
      await expect(reader.tools.select({ connectionId: engine.id, sql }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    }
    await sentinelUnchanged(engine);
  });

  it('returns only the bounded row window and settles actual server work', async () => {
    const reader = runtime(engine, { maxRows: 3 });
    const result = await reader.tools.select({ connectionId: engine.id, sql: 'SELECT n FROM numbers ORDER BY n' }, new AbortController().signal);
    expect(result.rows.length).toBe(3);
    expect(result.truncated).toBe(true);
    await sentinelUnchanged(engine);
  });

  it('distinguishes an empty result and an exact row-cap result from truncation', async () => {
    const reader = runtime(engine, { maxRows: 3 });
    const empty = await reader.tools.select({ connectionId: engine.id, sql: 'SELECT n FROM numbers WHERE n < 0' }, new AbortController().signal);
    expect(empty.columns).toEqual(['n']);
    expect(empty.rows.length === 0 && !empty.truncated).toBe(true);
    const exact = await reader.tools.select({ connectionId: engine.id, sql: 'SELECT n FROM numbers ORDER BY n LIMIT 3' }, new AbortController().signal);
    expect(exact.rows.length === 3 && !exact.truncated).toBe(true);
  });

  it('rejects byte and packet overflow instead of returning an empty success', async () => {
    const small = runtime(engine, { maxBytes: 1024 });
    await expect(small.tools.select({ connectionId: engine.id, sql: 'SELECT body FROM payload WHERE id=1' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    await expect(runtime(engine).tools.select({ connectionId: engine.id, sql: 'SELECT body FROM payload WHERE id=2' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    await sentinelUnchanged(engine);
  });

  it('rejects excessive metadata before exposing a result', async () => {
    const sql = 'SELECT ' + Array.from({ length: 129 }, (_, index) => String(index) + ' AS c' + String(index)).join(',');
    await expect(runtime(engine).tools.select({ connectionId: engine.id, sql }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
  });

  it('rejects an untrusted TLS authority without weakening verification', async () => {
    const wrongCa = readFileSync(join(dirname(fixture.caFile), 'untrusted-ca.pem'), 'utf8');
    await expect(runtime(engine, { tls: { ca: wrongCa } }).tools.select({ connectionId: engine.id, sql: 'SELECT 42' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
  });

  it('rejects a valid CA certificate with the wrong host identity', async () => {
    expect((await lookup('127.1')).address).toBe('127.0.0.1');
    const reader = runtime(engine, { host: '127.1' });
    await expect(reader.tools.select({ connectionId: engine.id, sql: 'SELECT 42' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
  });

  it('rejects incorrect database authentication without exposing credential values', async () => {
    const suffix = randomBytes(6).toString('hex');
    const passwordSecret = 'database-readonly-' + engine.engine + '-invalid-' + suffix;
    const password = 'invalid-fixture-password-' + suffix;
    writeFileSync(join(fixture.secretDirectory, passwordSecret), password, { flag: 'wx', mode: 0o600 });
    const reader = runtime(engine, { id: engine.engine + '-invalid', passwordSecret });
    await expect(reader.tools.select({ connectionId: engine.engine + '-invalid', sql: 'SELECT 42' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
  });

  it('screens the connection password in returned text and binary values', async () => {
    const lease = await secrets.getForUse('database-readonly-' + engine.id);
    try {
      await lease.withValue(async password => {
        const reader = runtime(engine);
        for (const sql of ['SELECT ? AS data', 'SELECT CAST(? AS BINARY) AS data']) {
          const result = await reader.tools.select({ connectionId: engine.id, sql, parameters: [password] }, new AbortController().signal);
          expect(result.rows[0]?.[0] === '***REDACTED***').toBe(true);
        }
      });
    } finally { lease.dispose(); }
  });

  it.each([
    { format: 'text', sql: 'SELECT ? AS data', value: 'fixture-mcp-authentication-secret' },
    { format: 'binary', sql: 'SELECT CAST(? AS BINARY) AS data', value: 'fixture-mcp-authentication-secret' },
    { format: 'embedded binary', sql: 'SELECT CAST(? AS BINARY) AS data', value: 'before-fixture-mcp-authentication-secret-after' },
  ])('screens the Agent MCP credential in $format results', async ({ sql, value }) => {
    const result = await runtime(engine).tools.select({ connectionId: engine.id, sql, parameters: [value] }, new AbortController().signal);
    expect(result.rows[0]?.[0] === '***REDACTED***').toBe(true);
  });

  it('cancels a query already running on the server before settling', async () => {
    const admin = await connection(engine, 'admin');
    const reader = runtime(engine);
    const controller = new AbortController();
    const result = reader.tools.select({ connectionId: engine.id, sql: heavySql }, controller.signal)
      .then(() => false, () => true);
    try {
      await waitForHeavyQuery(admin);
      controller.abort();
      expect(await result).toBe(true);
      expect(await activeHeavyQueries(admin)).toBe(0);
    } finally { controller.abort(); await result; await admin.end(); }
    await sentinelUnchanged(engine);
  });

  it('enforces the deadline on a real server query and drains it', async () => {
    const admin = await connection(engine, 'admin');
    const started = performance.now();
    const result = runtime(engine, { timeoutMs: 1500 }).tools.select({ connectionId: engine.id, sql: heavySql }, new AbortController().signal)
      .then(() => false, () => true);
    try {
      await waitForHeavyQuery(admin);
      expect(await result).toBe(true);
      expect(await activeHeavyQueries(admin)).toBe(0);
      expect(performance.now() - started < 10000).toBe(true);
    } finally { await result; await admin.end(); }
    await sentinelUnchanged(engine);
  });

  it('closes active work, rejects later queries and leaves no active server query', async () => {
    const admin = await connection(engine, 'admin');
    const reader = runtime(engine);
    const result = reader.tools.select({ connectionId: engine.id, sql: heavySql }, new AbortController().signal).then(() => false, () => true);
    try {
      await waitForHeavyQuery(admin);
      await reader.close();
      expect(await result).toBe(true);
      expect(await activeHeavyQueries(admin)).toBe(0);
      await expect(reader.tools.select({ connectionId: engine.id, sql: 'SELECT 42' }, new AbortController().signal)).rejects.toThrow();
    } finally { await reader.close(); await result; await admin.end(); }
  });

  it('serves authenticated real MCP SELECT results and denies wrong authentication', async () => {
    const reader = runtime(engine);
    const server = await createMcpHttpServer({ host: '127.0.0.1', port: 0, internalSecret: 'fixture-mcp-authentication-secret', database: reader.tools });
    try {
      const listed = await rpc(server.url, 'database_connections', {});
      expect(listed.value).toEqual([{ connectionId: engine.id, engine: engine.engine }]);
      const selected = await rpc(server.url, 'database_select', { connectionId: engine.id, sql: 'SELECT 42 AS answer' });
      expect(selected.value).toEqual({ columns: ['answer'], rows: [[engine.engine === 'mysql' ? '42' : 42]], truncated: false });
      expect((await rpc(server.url, 'database_select', { connectionId: engine.id, sql: 'SELECT 42' }, 'wrong-fixture-auth')).status).toBe(401);
    } finally { await server.close(); }
  });
});
