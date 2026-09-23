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

export type GitStatusInputValue = z.infer<typeof GitStatusInput>;
export type GitDiffInputValue = z.infer<typeof GitDiffInput>;

type MaybePromise<T> = T | Promise<T>;

export interface GitToolsPort {
  status(taskId: string): MaybePromise<unknown>;
  diff(taskId: string, baseRef?: string): MaybePromise<string>;
}

export function registerGitTools(server: McpServer, git: GitToolsPort): void {
  server.registerTool(
    'git_status',
    {
      description: 'Return Git status for the selected task workspace.',
      inputSchema: GitStatusInput,
    },
    async ({ taskId }) => {
      const status = await git.status(taskId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] };
    },
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
}
