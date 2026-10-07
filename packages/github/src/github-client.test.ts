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

describe('GitHubClient safe failures', () => {
  it.each(['http', 'transport'] as const)('does not propagate credential-bearing %s errors', async (kind) => {
    const token = 'private-github-token';
    const dispose = vi.fn();
    const client = new GitHubClient({
      secrets: { getForUse: async () => ({ withValue: <T>(use: (value: string) => T): T => use(token), dispose }) },
      fetch: async () => {
        if (kind === 'transport') throw new Error(`request Authorization: Bearer ${token}`);
        return { ok: false, status: 403, text: async () => `denied ${token}`, json: async () => ({}) };
      },
    });
    let error: unknown;
    try { await client.getJson('/repos/acme/web'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).toContain(kind === 'http' ? 'status 403' : 'transport failed');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
