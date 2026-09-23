import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostHostValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { verifyInternalSecret } from './auth.js';
import { registerCodeTools, type CodeToolsPort } from './tools/code-tools.js';
import {
  registerGitHubPullRequestTools,
  type GitHubPullRequestToolsPort,
} from './tools/github-tools.js';
import { registerTaskTools, type TaskCreatePort } from './tools/task-tools.js';

export interface CreateMcpHttpServerOptions {
  host: string;
  port: number;
  internalSecret: string;
  health?: () => unknown | Promise<unknown>;
  taskCreate?: TaskCreatePort;
  codeTools?: CodeToolsPort;
  githubPullRequests?: GitHubPullRequestToolsPort;
}

export interface RunningMcpServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

type McpNodeRequest = IncomingMessage & NodeIncomingMessageLike;

function isMcpNodeRequest(request: IncomingMessage): request is McpNodeRequest {
  return typeof request.method === 'string' && typeof request.url === 'string';
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
    if (options.taskCreate !== undefined) registerTaskTools(server, options.taskCreate);
    if (options.codeTools !== undefined) registerCodeTools(server, options.codeTools);
    if (options.githubPullRequests !== undefined) {
      registerGitHubPullRequestTools(server, options.githubPullRequests);
    }
    return server;
  });
  const nodeHandler = toNodeHandler(mcpHandler);
  const validateHost = localhostHostValidation();

  const httpServer = createServer((request, response) => {
    if (!isMcpNodeRequest(request)) {
      response.statusCode = 400;
      response.end('Bad Request');
      return;
    }
    if (!validateHost(request, response)) return;

    if (request.url === '/healthz') {
      void Promise.resolve(options.health ? options.health() : { status: 'healthy' })
        .then((health) => {
          if (response.writableEnded) return;
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(health));
        })
        .catch(() => {
          if (response.writableEnded) return;
          response.statusCode = 503;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ status: 'degraded' }));
        });
      return;
    }

    if (request.url !== '/mcp') {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }

    const header = request.headers['x-gram-agent-auth'];
    const supplied = typeof header === 'string' ? header : undefined;
    if (!verifyInternalSecret(options.internalSecret, supplied)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    void nodeHandler(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
      }
      if (!response.writableEnded) response.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
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
