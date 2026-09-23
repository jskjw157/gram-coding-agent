import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const TaskCreateInput = z.object({
  repo: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  publishMode: z.enum(['PULL_REQUEST', 'DIRECT_MAIN']).default('PULL_REQUEST'),
});

export type TaskCreateInputValue = z.infer<typeof TaskCreateInput>;

export interface TaskCreateView {
  id: string;
  displayId: string;
  repo: string;
  goal: string;
  status: string;
  publishMode: 'PULL_REQUEST' | 'DIRECT_MAIN';
}

export interface TaskCreatePort {
  create(input: TaskCreateInputValue): Promise<TaskCreateView>;
}

export function createTaskCreateHandler(tasks: TaskCreatePort) {
  return async (input: TaskCreateInputValue) => {
    const task = await tasks.create(input);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(task) }],
    };
  };
}

export function registerTaskTools(server: McpServer, tasks: TaskCreatePort): void {
  server.registerTool(
    'task_create',
    {
      description: 'Create a queued coding task for a repository selector.',
      inputSchema: TaskCreateInput,
    },
    createTaskCreateHandler(tasks),
  );
}
