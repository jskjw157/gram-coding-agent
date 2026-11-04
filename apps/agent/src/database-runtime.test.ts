import { describe, expect, it, vi } from 'vitest';
import { SecretRedactor } from '@gram/secrets';
import { createDatabaseRuntime } from './database-runtime.js';
import type { ReadonlyDatabaseConfig } from './database-config.js';
const config: ReadonlyDatabaseConfig = { version: 1, connections: [{ id: 'business', engine: 'mysql', host: '127.0.0.1',
  port: 3306, database: 'fixture', user: 'reader', passwordSecret: 'database-readonly-business', tls: false,
  maxRows: 500, maxBytes: 1048576, timeoutMs: 10000 }] };
function fixture() {
  const getForUse = vi.fn(async () => { throw new Error('unit fixture must not acquire a credential or connect'); });
  const runtime = createDatabaseRuntime({ config, secrets: { getForUse }, redactor: new SecretRedactor() });
  return { runtime, getForUse };
}
describe('read-only database runtime admission without network access', () => {
  it('lists only public configured ids and engines without acquiring credentials', async () => {
    const { runtime, getForUse } = fixture();
    expect(await runtime.tools.connections()).toEqual([{ connectionId: 'business', engine: 'mysql' }]);
    expect(getForUse).not.toHaveBeenCalled(); await runtime.close();
  });
  it('rejects an unknown connection before acquiring a credential', async () => {
    const { runtime, getForUse } = fixture();
    await expect(runtime.tools.select({ connectionId: 'missing', sql: 'SELECT 1' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    expect(getForUse).not.toHaveBeenCalled(); await runtime.close();
  });
  it('rejects a mutation before acquiring a credential', async () => {
    const { runtime, getForUse } = fixture();
    await expect(runtime.tools.select({ connectionId: 'business', sql: 'DELETE FROM sentinel' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    expect(getForUse).not.toHaveBeenCalled(); await runtime.close();
  });
  it('rejects an already-cancelled request before acquiring a credential', async () => {
    const { runtime, getForUse } = fixture(); const controller = new AbortController(); controller.abort();
    await expect(runtime.tools.select({ connectionId: 'business', sql: 'SELECT 1' }, controller.signal)).rejects.toThrow('Database operation denied or failed');
    expect(getForUse).not.toHaveBeenCalled(); await runtime.close();
  });
  it('stops new queries after an idempotent close', async () => {
    const { runtime, getForUse } = fixture(); await runtime.close(); await runtime.close();
    await expect(runtime.tools.select({ connectionId: 'business', sql: 'SELECT 1' }, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    expect(getForUse).not.toHaveBeenCalled();
  });
});
