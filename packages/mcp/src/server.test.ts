import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer } from './server.js';

const running: RunningMcpServer[] = [];

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

    const missing = await fetch(`${server.url}/mcp`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${server.url}/mcp`, {
      headers: { 'x-gram-agent-auth': 'wrong-secret' },
    });
    expect(wrong.status).toBe(401);

    const accepted = await fetch(`${server.url}/mcp`, {
      headers: { 'x-gram-agent-auth': 'correct-secret' },
    });
    expect(accepted.status).not.toBe(401);
  });
});
