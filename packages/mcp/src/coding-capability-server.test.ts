import { afterEach, expect, it } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer } from './server.js';
const servers: RunningMcpServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()?.close(); });
const taskId = '018d8a73-6b4e-7000-8000-000000000001';
function rpc(url: string, method: string, params: unknown = {}, secret = 'test-secret') {
  return fetch(`${url}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-gram-agent-auth': secret,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
it('exposes coding rendezvous only after existing MCP authentication', async () => {
  const server = await createMcpHttpServer({ host: '127.0.0.1', port: 0, internalSecret: 'test-secret', codingCapability: {
    get: (id) => ({ taskId: id, phase: 'ANALYZE' }), read: () => ({ content: 'source' }), submit: () => ({ accepted: true }), fail: () => ({ failed: true }),
  } });
  servers.push(server);
  expect((await rpc(server.url, 'tools/list', {}, 'incorrect')).status).toBe(401);
  const listed = await (await rpc(server.url, 'tools/list')).text();
  for (const name of ['coding_step_get', 'coding_step_read', 'coding_step_submit', 'coding_step_fail']) expect(listed).toContain(name);
  const result = await (await rpc(server.url, 'tools/call', { name: 'coding_step_get', arguments: { taskId } })).text();
  expect(result).toContain('ANALYZE');
  const invalid = await (await rpc(server.url, 'tools/call', { name: 'coding_step_get', arguments: { taskId, cwd: '/tmp' } })).text();
  expect(invalid).not.toContain('ANALYZE');
});
