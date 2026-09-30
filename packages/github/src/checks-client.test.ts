import { describe, expect, it, vi } from 'vitest';
import type { SecretProvider } from '@gram/secrets';
import type { CiPullRequestContext } from './checks-service.js';
import { GitHubChecksClient } from './checks-client.js';
import type { GitHubFetch, GitHubHttpResponse } from './github-client.js';

const CONTEXT: CiPullRequestContext = {
  taskId: '018f0000-0000-7000-8000-000000000001',
  pullRequestId: 7,
  owner: 'acme',
  name: 'demo',
  number: 42,
  headSha: 'a'.repeat(40),
  baseBranch: 'main',
};

function response(status: number, body: unknown): GitHubHttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

function secretProvider(dispose = vi.fn()): SecretProvider {
  return {
    getForUse: vi.fn(async () => ({
      withValue: <T>(use: (value: string) => T) => use('github_pat_test_secret'),
      dispose,
    })),
  };
}

describe('GitHubChecksClient', () => {
  it('returns only required check-runs for the exact published HEAD', async () => {
    const dispose = vi.fn();
    const secrets = secretProvider(dispose);
    const fetch: GitHubFetch = vi.fn(async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer github_pat_test_secret');

      if (url.includes('/protection/required_status_checks')) {
        return response(200, {
          strict: true,
          contexts: ['verify'],
          checks: [{ context: 'verify', app_id: 15368 }],
        });
      }

      if (url.includes('/check-runs')) {
        return response(200, {
          total_count: 2,
          check_runs: [
            {
              id: 2001,
              name: 'verify',
              head_sha: CONTEXT.headSha,
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://github.test/acme/demo/actions/runs/1001',
              started_at: '2026-01-01T00:00:00Z',
              completed_at: '2026-01-01T00:00:05Z',
              check_suite: { id: 1001 },
              app: { id: 15368 },
            },
            {
              id: 2002,
              name: 'optional-lint',
              head_sha: CONTEXT.headSha,
              status: 'completed',
              conclusion: 'failure',
              details_url: 'https://github.test/acme/demo/actions/runs/1002',
              check_suite: { id: 1002 },
              app: { id: 15368 },
            },
          ],
        });
      }

      throw new Error('unexpected URL: ' + url);
    });

    const client = new GitHubChecksClient({
      secrets,
      fetch,
      apiBaseUrl: 'https://api.github.test',
    });

    await expect(client.listRequiredChecks(CONTEXT)).resolves.toEqual([
      {
        providerRunId: '1001',
        providerCheckId: '2001',
        checkName: 'verify',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.test/acme/demo/actions/runs/1001',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:05Z',
      },
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.test/repos/acme/demo/branches/main/protection/required_status_checks',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.test/repos/acme/demo/commits/' +
        CONTEXT.headSha +
        '/check-runs?filter=latest&per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(dispose).toHaveBeenCalledTimes(2);
  });


  it('keeps distinct legacy contexts while preferring fine-grained app rules for duplicate names', async () => {
    const fetch: GitHubFetch = vi.fn(async (url) => {
      if (url.includes('/protection/required_status_checks')) {
        return response(200, {
          strict: true,
          contexts: ['verify', 'security-scan'],
          checks: [{ context: 'verify', app_id: 15368 }],
        });
      }
      return response(200, {
        total_count: 2,
        check_runs: [
          {
            id: 3001,
            name: 'verify',
            head_sha: CONTEXT.headSha,
            status: 'completed',
            conclusion: 'success',
            app: { id: 15368 },
          },
          {
            id: 3002,
            name: 'security-scan',
            head_sha: CONTEXT.headSha,
            status: 'in_progress',
            conclusion: null,
            app: { id: 991 },
          },
        ],
      });
    });

    const client = new GitHubChecksClient({
      secrets: secretProvider(),
      fetch,
      apiBaseUrl: 'https://api.github.test',
    });

    await expect(client.listRequiredChecks(CONTEXT)).resolves.toEqual([
      expect.objectContaining({
        providerCheckId: '3001',
        checkName: 'verify',
        status: 'completed',
        conclusion: 'success',
      }),
      expect.objectContaining({
        providerCheckId: '3002',
        checkName: 'security-scan',
        status: 'in_progress',
        conclusion: null,
      }),
    ]);
  });

  it('returns a synthetic queued required check instead of treating a missing provider check as success', async () => {
    const fetch: GitHubFetch = vi.fn(async (url) => {
      if (url.includes('/protection/required_status_checks')) {
        return response(200, {
          strict: true,
          contexts: ['verify'],
          checks: [],
        });
      }
      return response(200, {
        total_count: 1,
        check_runs: [
          {
            id: 2001,
            name: 'verify',
            head_sha: 'b'.repeat(40),
            status: 'completed',
            conclusion: 'success',
            app: { id: 15368 },
          },
        ],
      });
    });

    const client = new GitHubChecksClient({
      secrets: secretProvider(),
      fetch,
      apiBaseUrl: 'https://api.github.test',
    });

    await expect(client.listRequiredChecks(CONTEXT)).resolves.toEqual([
      {
        providerCheckId: 'required:verify',
        checkName: 'verify',
        status: 'queued',
        conclusion: null,
      },
    ]);
  });

  it('normalizes GitHub pre-run statuses to queued', async () => {
    const fetch: GitHubFetch = vi.fn(async (url) => {
      if (url.includes('/protection/required_status_checks')) {
        return response(200, {
          strict: true,
          contexts: [],
          checks: [{ context: 'verify', app_id: -1 }],
        });
      }
      return response(200, {
        total_count: 1,
        check_runs: [
          {
            id: 2001,
            name: 'verify',
            head_sha: CONTEXT.headSha,
            status: 'waiting',
            conclusion: null,
            app: { id: 999 },
          },
        ],
      });
    });

    const client = new GitHubChecksClient({
      secrets: secretProvider(),
      fetch,
      apiBaseUrl: 'https://api.github.test',
    });

    const checks = await client.listRequiredChecks(CONTEXT);
    expect(checks).toEqual([
      expect.objectContaining({
        providerCheckId: '2001',
        checkName: 'verify',
        status: 'queued',
        conclusion: null,
      }),
    ]);
  });

  it('fails closed when required-check protection cannot be read or is empty', async () => {
    const notFound = new GitHubChecksClient({
      secrets: secretProvider(),
      fetch: vi.fn(async () => response(404, { message: 'Not Found' })),
      apiBaseUrl: 'https://api.github.test',
    });

    await expect(notFound.listRequiredChecks(CONTEXT)).rejects.toThrow(
      /required status checks/i,
    );

    const empty = new GitHubChecksClient({
      secrets: secretProvider(),
      fetch: vi.fn(async (url) =>
        url.includes('/protection/required_status_checks')
          ? response(200, { strict: true, contexts: [], checks: [] })
          : response(200, { total_count: 0, check_runs: [] }),
      ),
      apiBaseUrl: 'https://api.github.test',
    });

    await expect(empty.listRequiredChecks(CONTEXT)).rejects.toThrow(
      /no required status checks/i,
    );
  });
});
