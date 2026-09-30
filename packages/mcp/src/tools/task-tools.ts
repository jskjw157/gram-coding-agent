import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();

export const TaskCreateInput = z
  .object({
    repo: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    publishMode: z.enum(['PULL_REQUEST', 'DIRECT_MAIN']).default('PULL_REQUEST'),
  })
  .strict();

export const TaskReadInput = z.object({ taskId: TaskId }).strict();
export const TaskListInput = z
  .object({ limit: z.number().int().min(1).max(100).default(20) })
  .strict();

export type TaskCreateInputValue = z.infer<typeof TaskCreateInput>;
export type TaskReadInputValue = z.infer<typeof TaskReadInput>;
export type TaskListInputValue = z.infer<typeof TaskListInput>;

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

type MaybePromise<T> = T | Promise<T>;

export interface TaskReadPort {
  get(taskId: string): MaybePromise<unknown>;
  list(input: { limit: number }): MaybePromise<unknown>;
  logs(taskId: string): MaybePromise<unknown>;
  result(taskId: string): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createTaskCreateHandler(tasks: TaskCreatePort) {
  return async (input: TaskCreateInputValue) => jsonResult(await tasks.create(input));
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

export function registerTaskReadTools(server: McpServer, tasks: TaskReadPort): void {
  server.registerTool(
    'task_get',
    {
      description: 'Return persisted state for one task.',
      inputSchema: TaskReadInput,
    },
    async ({ taskId }) => jsonResult(await tasks.get(taskId)),
  );
  server.registerTool(
    'task_list',
    {
      description: 'List recent tasks without acquiring a repository mutation lock.',
      inputSchema: TaskListInput,
    },
    async ({ limit }) => jsonResult(await tasks.list({ limit })),
  );
  server.registerTool(
    'task_logs',
    {
      description: 'Return secret-safe logs belonging only to the selected task.',
      inputSchema: TaskReadInput,
    },
    async ({ taskId }) => jsonResult(await tasks.logs(taskId)),
  );
  server.registerTool(
    'task_result',
    {
      description: 'Return the durable result for the selected task.',
      inputSchema: TaskReadInput,
    },
    async ({ taskId }) => jsonResult(await tasks.result(taskId)),
  );
}
