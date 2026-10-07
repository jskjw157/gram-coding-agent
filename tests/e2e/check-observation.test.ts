import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { GitHubChecksClient } from '../../packages/github/src/checks-client.js';
import { ChecksService } from '../../packages/github/src/checks-service.js';

it('observes a required check on page two through real HTTP without completing a pending rerun', async () => {
  const headSha = 'a'.repeat(40);
  const requests: string[] = [];
  let polls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    response.setHeader('content-type', 'application/json');
    expect(request.headers.authorization).toBe('Bearer fake-github-token');
    if (url.pathname === '/repos/acme/demo/branches/release%2Fm2/protection/required_status_checks') {
      response.end(JSON.stringify({ checks: [{ context: 'verify', app_id: 15368 }] }));
      return;
    }
    if (url.pathname !== `/repos/acme/demo/commits/${headSha}/check-runs`) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'unexpected path' }));
      return;
    }
    expect(url.searchParams.get('filter')).toBe('latest');
    expect(url.searchParams.get('per_page')).toBe('100');
    const page = url.searchParams.get('page');
    expect(['1', '2']).toContain(page);
    if (page === '1') polls += 1;
    const run = {
      id: 101, name: 'verify', head_sha: headSha, app: { id: 15368 },
      status: polls === 1 ? 'in_progress' : 'completed',
      conclusion: polls === 1 ? null : 'success',
    };
    // A successful duplicate on the first page must not hide the rerun.
    const firstPage = [
      { ...run, id: 1, status: 'completed', conclusion: 'success' },
      ...Array.from({ length: 99 }, (_, index) => ({
        ...run, id: index + 2, name: 'optional', status: 'completed', conclusion: 'success',
      })),
    ];
    response.end(JSON.stringify({ total_count: 101, check_runs: page === '1' ? firstPage : [run] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const dispose = vi.fn();
    const complete = vi.fn();
    const wait = vi.fn(async () => {
      expect(complete).not.toHaveBeenCalled();
    });
    const client = new GitHubChecksClient({
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secrets: {
        getForUse: async () => ({
          withValue: <T>(use: (value: string) => T) => use('fake-github-token'), dispose,
        }),
      },
      fetch: (url, init) => fetch(url, init),
    });
    const service = new ChecksService({
      client, persistence: { upsertCheck: vi.fn() }, completion: { complete },
      delay: { wait }, maxAttempts: 2, pollIntervalMs: 0,
    });
    const result = await service.observeRequiredChecks({
      taskId: '018f0000-0000-7000-8000-000000000156', pullRequestId: 1,
      owner: 'acme', name: 'demo', number: 42, headSha, baseBranch: 'release/m2',
    });
    expect(result.outcome).toBe('SUCCESS');
    expect(result.attempts).toBe(2);
    expect(result.checks.map((check) => check.providerCheckId)).toEqual(['1', '101']);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith('018f0000-0000-7000-8000-000000000156');
    expect(dispose).toHaveBeenCalledTimes(6);
    const expectedPoll = [
      '/repos/acme/demo/branches/release%2Fm2/protection/required_status_checks',
      `/repos/acme/demo/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`,
      `/repos/acme/demo/commits/${headSha}/check-runs?filter=latest&per_page=100&page=2`,
    ];
    expect(requests).toEqual([...expectedPoll, ...expectedPoll]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    }));
  }
});
