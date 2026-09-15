import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { verifyInternalSecret } from './auth.js';

export interface CreateMcpHttpServerOptions {
  host: string;
  port: number;
  internalSecret: string;
  health?: () => unknown | Promise<unknown>;
}

export interface RunningMcpServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function createMcpHttpServer(options: CreateMcpHttpServerOptions): Promise<RunningMcpServer> {
  if (options.host !== '127.0.0.1' && options.host !== '::1') {
    throw new Error('MCP server must bind to loopback');
  }
  if (options.internalSecret.length === 0) {
    throw new Error('MCP internal secret must not be empty');
  }

  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: 'gram-coding-agent', version: '0.0.0' });
    server.registerTool(
      'agent_health',
      { description: 'Return the Gram coding agent health status.' },
      async () => {
        const health = options.health ? await options.health() : { status: 'healthy' };
        return { content: [{ type: 'text' as const, text: JSON.stringify(health) }] };
      },
    );
    return server;
  });
  const nodeHandler = toNodeHandler(mcpHandler);
  const validateHost = localhostHostValidation();

  const httpServer = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }
    if (!validateHost(request, response)) return;

    const header = request.headers['x-gram-agent-auth'];
    const supplied = typeof header === 'string' ? header : undefined;
    if (!verifyInternalSecret(options.internalSecret, supplied)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    void (async () => {
      try {
        await nodeHandler(request, response);
      } catch {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
        }
        if (!response.writableEnded) response.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen({ host: options.host, port: options.port }, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    await closeHttpServer(httpServer);
    await mcpHandler.close();
    throw new Error('MCP server did not expose a TCP address');
  }

  const port = (address as AddressInfo).port;
  const urlHost = options.host === '::1' ? '[::1]' : options.host;

  return {
    host: options.host,
    port,
    url: `http://${urlHost}:${port}`,
    async close() {
      await closeHttpServer(httpServer);
      await mcpHandler.close();
    },
  };
}
