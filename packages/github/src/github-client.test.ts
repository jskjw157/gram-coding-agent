import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github-client.js';

describe('GitHubClient credential scope', () => {
  it('injects the GitHub credential only into the adapter request and disposes the lease', async () => {
    const dispose = vi.fn();
    const secrets = {
      getForUse: vi.fn(async () => ({
        withValue<T>(use: (value: string) => T): T {
          return use('github_pat_secret_value');
        },
        dispose,
      })),
    };
    const fetch = vi.fn(async (
      _url: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body?: string;
      },
    ) => {
      void _url;
      void init;
      return {
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return [
          {
            node_id: 'PR_node_42',
            number: 42,
            html_url: 'https://github.com/company/web/pull/42',
            state: 'open',
            head: { ref: 'feat/task-000001-fix' },
            base: { ref: 'main' },
          },
        ];
      },
    };
    });

    const client = new GitHubClient({
      secrets,
      fetch,
      apiBaseUrl: 'https://api.github.test',
      credentialName: 'github.task-token',
    });

    const pr = await client.findOpenPullRequest({
      owner: 'company',
      name: 'web',
      headBranch: 'feat/task-000001-fix',
      baseBranch: 'main',
    });

    expect(secrets.getForUse).toHaveBeenCalledWith('github.task-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.headers.Authorization).toBe('Bearer github_pat_secret_value');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pr).toMatchObject({
      number: 42,
      headBranch: 'feat/task-000001-fix',
      baseBranch: 'main',
      state: 'open',
    });
  });
});
