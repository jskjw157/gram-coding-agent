import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

const boundedUtf8 = (maximum: number) => z.string().max(maximum)
  .refine(value => Buffer.byteLength(value, 'utf8') <= maximum, 'UTF-8 byte limit exceeded');
const scalar = z.union([boundedUtf8(8192), z.number().finite(), z.boolean(), z.null()]);
export const DatabaseConnectionsInput = z.object({}).strict();
export const DatabaseSelectInput = z.object({
  connectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u),
  sql: boundedUtf8(16384).refine(value => value.length > 0, 'SQL must not be empty'),
  parameters: z.array(scalar).max(100).optional(),
}).strict();
export type DatabaseScalar = z.infer<typeof scalar>;
export type DatabaseSelectInputValue = z.infer<typeof DatabaseSelectInput>;
export interface DatabaseConnectionView { connectionId: string; engine: string }
export interface DatabaseSelectView { columns: string[]; rows: DatabaseScalar[][]; truncated: boolean }
export interface ReadOnlyDatabaseToolsPort {
  connections(): Promise<readonly DatabaseConnectionView[]>;
  select(input: DatabaseSelectInputValue, signal: AbortSignal): Promise<DatabaseSelectView>;
}

async function call(operation: () => Promise<unknown>) {
  try { return safeJsonResult(await operation()); }
  catch { throw new Error('Database operation denied or failed'); }
}

export function registerReadOnlyDatabaseTools(server: McpServer, port: ReadOnlyDatabaseToolsPort): void {
  server.registerTool('database_connections', {
    description: 'List configured read-only database connection identifiers and engines without connection details.',
    inputSchema: DatabaseConnectionsInput,
  }, () => call(async () => (await port.connections()).map(({ connectionId, engine }) => ({ connectionId, engine }))));
  server.registerTool('database_select', {
    description: 'Execute a bounded read-only SELECT on a trusted named database connection using positional bind values.',
    inputSchema: DatabaseSelectInput,
  }, (input, context) => call(async () => {
    const signal = context.mcpReq.signal;
    signal.throwIfAborted();
    const { columns, rows, truncated } = await port.select(input, signal);
    signal.throwIfAborted();
    return { columns, rows, truncated };
  }));
}
