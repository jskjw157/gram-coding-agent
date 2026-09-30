import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const AgentTaskInput = z.object({}).strict();

type MaybePromise<T> = T | Promise<T>;

export interface AgentToolsPort {
  status(): MaybePromise<unknown>;
  health(): MaybePromise<unknown>;
  logs(): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerAgentTools(server: McpServer, agent: AgentToolsPort): void {
  server.registerTool(
    'agent_status',
    {
      description: 'Return agent runtime and scheduler status.',
      inputSchema: AgentTaskInput,
    },
    async () => jsonResult(await agent.status()),
  );
  server.registerTool(
    'agent_health',
    {
      description: 'Return the Gram coding agent health status.',
      inputSchema: AgentTaskInput,
    },
    async () => jsonResult(await agent.health()),
  );
  server.registerTool(
    'agent_logs',
    {
      description: 'Return secret-safe agent logs.',
      inputSchema: AgentTaskInput,
    },
    async () => jsonResult(await agent.logs()),
  );
}
