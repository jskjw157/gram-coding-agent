import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();

export const GitHubPullRequestEnsureInput = z
  .object({
    taskId: TaskId,
  })
  .strict();

export type GitHubPullRequestEnsureInputValue = z.infer<
  typeof GitHubPullRequestEnsureInput
>;

type MaybePromise<T> = T | Promise<T>;

export interface GitHubPullRequestToolsPort {
  ensure(taskId: string): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function createGitHubPullRequestToolHandlers(
  github: GitHubPullRequestToolsPort,
) {
  return {
    ensure: async ({ taskId }: GitHubPullRequestEnsureInputValue) =>
      jsonResult(await github.ensure(taskId)),
  };
}

export function registerGitHubPullRequestTools(
  server: McpServer,
  github: GitHubPullRequestToolsPort,
): void {
  const handlers = createGitHubPullRequestToolHandlers(github);
  server.registerTool(
    'github_pr_ensure',
    {
      description:
        'Create or reuse the pull request for a task after confirmed publishing.',
      inputSchema: GitHubPullRequestEnsureInput,
    },
    handlers.ensure,
  );
}
