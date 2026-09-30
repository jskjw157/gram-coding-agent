import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();

export const GitStatusInput = z.object({ taskId: TaskId }).strict();
export const GitDiffInput = z
  .object({
    taskId: TaskId,
    baseRef: z.string().trim().min(1).optional(),
  })
  .strict();
export const GitLogInput = z
  .object({
    taskId: TaskId,
    maxCount: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const GitBlameInput = z
  .object({
    taskId: TaskId,
    path: z.string().trim().min(1),
    line: z.number().int().min(1).optional(),
  })
  .strict();

export type GitStatusInputValue = z.infer<typeof GitStatusInput>;
export type GitDiffInputValue = z.infer<typeof GitDiffInput>;

type MaybePromise<T> = T | Promise<T>;

export interface GitToolsPort {
  status(taskId: string): MaybePromise<unknown>;
  diff(taskId: string, baseRef?: string): MaybePromise<string>;
  log(taskId: string, maxCount: number): MaybePromise<unknown>;
  blame(taskId: string, path: string, line?: number): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerGitTools(server: McpServer, git: GitToolsPort): void {
  server.registerTool(
    'git_status',
    {
      description: 'Return Git status for the selected task workspace.',
      inputSchema: GitStatusInput,
    },
    async ({ taskId }) => jsonResult(await git.status(taskId)),
  );

  server.registerTool(
    'git_diff',
    {
      description: 'Return Git diff for the selected task workspace.',
      inputSchema: GitDiffInput,
    },
    async ({ taskId, baseRef }) => {
      const diff =
        baseRef === undefined ? await git.diff(taskId) : await git.diff(taskId, baseRef);
      return { content: [{ type: 'text' as const, text: diff }] };
    },
  );

  server.registerTool(
    'git_log',
    {
      description: 'Return recent Git history for the selected task workspace.',
      inputSchema: GitLogInput,
    },
    async ({ taskId, maxCount }) => jsonResult(await git.log(taskId, maxCount)),
  );

  server.registerTool(
    'git_blame',
    {
      description: 'Return blame information for a task-workspace path.',
      inputSchema: GitBlameInput,
    },
    async ({ taskId, path, line }) =>
      jsonResult(
        line === undefined
          ? await git.blame(taskId, path)
          : await git.blame(taskId, path, line),
      ),
  );
}
