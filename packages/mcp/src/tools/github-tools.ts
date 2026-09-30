import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();

export const GitHubPullRequestEnsureInput = z
  .object({ taskId: TaskId })
  .strict();
export const GitHubTaskInput = z.object({ taskId: TaskId }).strict();

export type GitHubPullRequestEnsureInputValue = z.infer<
  typeof GitHubPullRequestEnsureInput
>;

type MaybePromise<T> = T | Promise<T>;

export interface GitHubPullRequestToolsPort {
  ensure(taskId: string): MaybePromise<unknown>;
}

export interface GitHubReadToolsPort {
  getPullRequest(taskId: string): MaybePromise<unknown>;
  checks(taskId: string): MaybePromise<unknown>;
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

export function registerGitHubReadTools(
  server: McpServer,
  github: GitHubReadToolsPort,
): void {
  server.registerTool(
    'github_pr_get',
    {
      description: 'Return the persisted/provider pull request for a task.',
      inputSchema: GitHubTaskInput,
    },
    async ({ taskId }) => jsonResult(await github.getPullRequest(taskId)),
  );
  server.registerTool(
    'github_pr_checks',
    {
      description: 'Return required CI/check state for a task pull request.',
      inputSchema: GitHubTaskInput,
    },
    async ({ taskId }) => jsonResult(await github.checks(taskId)),
  );
}
