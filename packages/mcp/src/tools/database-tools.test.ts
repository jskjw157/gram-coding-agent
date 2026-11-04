import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { DatabaseConnectionsInput, DatabaseSelectInput, registerReadOnlyDatabaseTools,
  type DatabaseSelectView, type ReadOnlyDatabaseToolsPort } from './database-tools.js';

const input = { connectionId: 'reporting', sql: 'SELECT ? AS value' };

function handlers(port: ReadOnlyDatabaseToolsPort) {
  type Context = { mcpReq: { signal: AbortSignal } };
  const calls = new Map<string, (input: unknown, context?: Context) => Promise<unknown>>();
  const server = { registerTool(name: string, _definition: unknown, handler: (input: unknown, context: Context) => Promise<unknown>) {
    calls.set(name, (input, context = { mcpReq: { signal: new AbortController().signal } }) => handler(input, context));
  } };
  registerReadOnlyDatabaseTools(server as unknown as McpServer, port);
  return calls;
}

describe('read-only database transport contracts', () => {
  it('accepts named IDs and positional JSON scalars without changing the SQL or values', () => {
    const value = { ...input, parameters: ["O'Reilly; DROP TABLE example; --", 3.5, true, null] };
    expect(DatabaseSelectInput.parse(value)).toEqual(value);
    expect(DatabaseSelectInput.parse(input)).toEqual(input);
    expect(DatabaseSelectInput.safeParse({ ...input, connectionId: 'A' + 'x'.repeat(63) }).success).toBe(true);
    for (const connectionId of ['', 'a'.repeat(65), '../private', '-option', 'space id']) {
      expect(DatabaseSelectInput.safeParse({ ...input, connectionId }).success).toBe(false);
    }
  });

  it('rejects caller-selected connection, credential, execution and result-limit overrides', () => {
    expect(DatabaseConnectionsInput.parse({})).toEqual({});
    for (const field of ['host', 'port', 'database', 'username', 'password', 'connectionString', 'driver',
      'secretName', 'credentialPath', 'signal', 'timeoutMs', 'maxRows', 'executable', 'env']) {
      expect(DatabaseConnectionsInput.safeParse({ [field]: 'caller-value' }).success).toBe(false);
      expect(DatabaseSelectInput.safeParse({ ...input, [field]: 'caller-value' }).success).toBe(false);
    }
  });

  it('bounds SQL by UTF-8 bytes, including multibyte input', () => {
    expect(DatabaseSelectInput.safeParse({ ...input, sql: '' }).success).toBe(false);
    expect(DatabaseSelectInput.safeParse({ ...input, sql: 'x'.repeat(16384) }).success).toBe(true);
    expect(DatabaseSelectInput.safeParse({ ...input, sql: 'x'.repeat(16385) }).success).toBe(false);
    expect(DatabaseSelectInput.safeParse({ ...input, sql: '\u00e9'.repeat(8192) }).success).toBe(true);
    expect(DatabaseSelectInput.safeParse({ ...input, sql: '\u00e9'.repeat(8193) }).success).toBe(false);
  });

  it('bounds bind count and each string by UTF-8 bytes', () => {
    expect(DatabaseSelectInput.safeParse({ ...input, parameters: Array(100).fill(null) }).success).toBe(true);
    expect(DatabaseSelectInput.safeParse({ ...input, parameters: Array(101).fill(null) }).success).toBe(false);
    for (const value of ['x'.repeat(8192), '\u00e9'.repeat(4096)]) {
      expect(DatabaseSelectInput.safeParse({ ...input, parameters: [value] }).success).toBe(true);
    }
    for (const value of ['x'.repeat(8193), '\u00e9'.repeat(4097)]) {
      expect(DatabaseSelectInput.safeParse({ ...input, parameters: [value] }).success).toBe(false);
    }
  });

  it('rejects non-finite numbers and non-scalar bind values', () => {
    for (const value of [NaN, Infinity, -Infinity, 1n, {}, [], undefined]) {
      expect(DatabaseSelectInput.safeParse({ ...input, parameters: [value] }).success).toBe(false);
    }
    expect(DatabaseSelectInput.safeParse({ ...input, parameters: { value: 1 } }).success).toBe(false);
  });

  it('registers only the two narrow tools and returns only their public result fields', async () => {
    const port: ReadOnlyDatabaseToolsPort = {
      connections: async () => [{ connectionId: 'reporting', engine: 'fixture', host: 'private.invalid',
        login: 'private-login', connectionString: 'private-connection' }],
      select: async () => ({ columns: ['value', 'value'], rows: [[1, 'github_pat_abcdefghijk']], truncated: false,
        sql: 'private-sql', connectionString: 'private-connection' }),
    };
    const tools = handlers(port);
    expect([...tools.keys()]).toEqual(['database_connections', 'database_select']);
    const connections = await tools.get('database_connections')?.({});
    expect(connections).toEqual({ content: [{ type: 'text', text: JSON.stringify([{ connectionId: 'reporting', engine: 'fixture' }]) }] });
    const result = await tools.get('database_select')?.(input);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ columns: ['value', 'value'],
      rows: [[1, '***REDACTED***']], truncated: false }) }] });
  });

  it('suppresses raw connection and query errors', async () => {
    const fail = async () => { throw new Error('private-connection private-password private-sql'); };
    const tools = handlers({ connections: fail, select: fail });
    await expect(tools.get('database_connections')?.({})).rejects.toThrow(/^Database operation denied or failed$/u);
    await expect(tools.get('database_select')?.(input)).rejects.toThrow(/^Database operation denied or failed$/u);
  });
});


describe('read-only database request cancellation', () => {
  it('forwards the exact MCP request signal to in-flight database work', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let stopped = false;
    const tools = handlers({ connections: async () => [], select: async (_input, signal?: AbortSignal) => {
      received = signal;
      if (!signal) return { columns: [], rows: [], truncated: false };
      return new Promise<DatabaseSelectView>((_resolve, reject) => signal.addEventListener('abort', () => {
        stopped = true;reject(new Error('private-abort-reason'));
      }, { once: true }));
    } });
    const pending = tools.get('database_select')?.(input, { mcpReq: { signal: controller.signal } });
    expect(received).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/^Database operation denied or failed$/u);
    expect(stopped).toBe(true);
  });

  it('does not invoke the database port for an already-aborted request', async () => {
    const controller = new AbortController();controller.abort(new Error('private-abort-reason'));
    const select = vi.fn(async () => ({ columns: [], rows: [], truncated: false }));
    const tools = handlers({ connections: async () => [], select });
    await expect(tools.get('database_select')?.(input, { mcpReq: { signal: controller.signal } }))
      .rejects.toThrow(/^Database operation denied or failed$/u);
    expect(select).not.toHaveBeenCalled();
  });

  it('does not return data if cancellation happened while the database port settled', async () => {
    const controller = new AbortController();
    const tools = handlers({ connections: async () => [], select: async () => {
      controller.abort();return { columns: ['value'], rows: [[1]], truncated: false };
    } });
    await expect(tools.get('database_select')?.(input, { mcpReq: { signal: controller.signal } }))
      .rejects.toThrow(/^Database operation denied or failed$/u);
  });
});
