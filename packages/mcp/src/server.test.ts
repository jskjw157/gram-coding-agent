import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer } from './server.js';

const running: RunningMcpServer[] = [];

function probe(url: string, secret?: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(secret === undefined ? {} : { 'x-gram-agent-auth': secret }),
    },
    body: '{}',
  });
}

afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

describe('authenticated loopback MCP server', () => {
  it('rejects non-loopback bind addresses', async () => {
    await expect(
      createMcpHttpServer({ host: '0.0.0.0', port: 0, internalSecret: 'test-secret' }),
    ).rejects.toThrow(/loopback/i);
  });

  it('rejects missing and incorrect credentials before MCP dispatch', async () => {
    const server = await createMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      internalSecret: 'correct-secret',
    });
    running.push(server);

    expect((await probe(server.url)).status).toBe(401);
    expect((await probe(server.url, 'wrong-secret')).status).toBe(401);
    expect((await probe(server.url, 'correct-secret')).status).not.toBe(401);
  });
});
