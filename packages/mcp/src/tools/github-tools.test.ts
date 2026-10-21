import { describe, expect, it, vi } from 'vitest';
import {
  GitHubPullRequestEnsureInput,
  createGitHubPullRequestToolHandlers,
  type GitHubPullRequestToolsPort,
} from './github-tools.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';

describe('github PR MCP tool', () => {
  it('accepts only task identity and delegates ensure to the application port', async () => {
    expect(GitHubPullRequestEnsureInput.parse({ taskId })).toEqual({ taskId });
    expect(
      GitHubPullRequestEnsureInput.safeParse({
        taskId,
        owner: 'company',
        headBranch: 'arbitrary',
      }).success,
    ).toBe(false);

    const github = {
      ensure: vi.fn(async () => ({
        number: 42,
        url: 'https://github.com/company/web/pull/42',
        state: 'open',
      })),
    } satisfies GitHubPullRequestToolsPort;
    const handlers = createGitHubPullRequestToolHandlers(github);

    const result = await handlers.ensure({ taskId });

    expect(github.ensure).toHaveBeenCalledWith(taskId);
    expect(JSON.parse(result.content[0]?.text ?? 'null')).toMatchObject({
      number: 42,
      state: 'open',
    });
  });
});
