import { afterEach, describe, expect, it } from 'vitest';
import { GitHubChecksClient } from '../../../packages/github/src/checks-client.js';
import {
  createFakeGitHubServer,
  type FakeGitHubServer,
} from './fake-github-server.js';

const servers: FakeGitHubServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe('fake GitHub server', () => {
  it('creates and then reuses an open pull request by exact head/base pair', async () => {
    const server = await createFakeGitHubServer();
    servers.push(server);

    const query = new URLSearchParams({
      state: 'open',
      head: 'acme:feat/task-000001-fix',
      base: 'main',
    });

    const before = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?' + query.toString(),
    );
    expect(await before.json()).toEqual([]);

    const createdResponse = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          head: 'feat/task-000001-fix',
          base: 'main',
          title: 'Fix counter',
          body: 'verified change',
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      number: number;
      html_url: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
    };
    expect(created).toMatchObject({
      number: 1,
      state: 'open',
      head: { ref: 'feat/task-000001-fix' },
      base: { ref: 'main' },
    });

    const after = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?' + query.toString(),
    );
    const found = await after.json() as Array<{ number: number }>;
    expect(found).toHaveLength(1);
    expect(found[0]?.number).toBe(created.number);
    expect(server.pullRequests).toHaveLength(1);
  });

  it('advances required checks deterministically from pending to success', async () => {
    const server = await createFakeGitHubServer();
    servers.push(server);
    const sha = 'a'.repeat(40);
    const url =
      server.apiBaseUrl + '/repos/acme/demo/commits/' + sha + '/check-runs';

    const first = await fetch(url);
    const firstBody = await first.json() as {
      check_runs: Array<{ id: number; status: string; conclusion: string | null }>;
    };
    expect(firstBody.check_runs).toEqual([
      expect.objectContaining({
        id: 2001,
        status: 'in_progress',
        conclusion: null,
      }),
    ]);

    const second = await fetch(url);
    const secondBody = await second.json() as {
      check_runs: Array<{ id: number; status: string; conclusion: string | null }>;
    };
    expect(secondBody.check_runs).toEqual([
      expect.objectContaining({
        id: 2001,
        status: 'completed',
        conclusion: 'success',
      }),
    ]);
    expect(server.checkPollCount).toBe(2);
  });


  it('drives the real GitHubChecksClient through required-check HTTP pending to success', async () => {
    const server = await createFakeGitHubServer();
    servers.push(server);
    const sha = 'a'.repeat(40);

    const client = new GitHubChecksClient({
      secrets: {
        getForUse: async () => ({
          withValue: <T>(use: (value: string) => T) => use('fake-github-token'),
          dispose: () => undefined,
        }),
      },
      fetch: async (url, init) =>
        fetch(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body === undefined ? {} : { body: init.body }),
        }),
      apiBaseUrl: server.apiBaseUrl,
    });

    const context = {
      taskId: '018f0000-0000-7000-8000-000000000073',
      pullRequestId: 1,
      owner: 'acme',
      name: 'demo',
      number: 7,
      headSha: sha,
      baseBranch: 'main',
    };

    const first = await client.listRequiredChecks(context);
    expect(first).toEqual([
      expect.objectContaining({
        providerCheckId: '2001',
        checkName: 'verify',
        status: 'in_progress',
        conclusion: null,
      }),
    ]);

    const second = await client.listRequiredChecks(context);
    expect(second).toEqual([
      expect.objectContaining({
        providerCheckId: '2001',
        checkName: 'verify',
        status: 'completed',
        conclusion: 'success',
      }),
    ]);

    expect(server.checkPollCount).toBe(2);
    expect(server.requests.map((request) => request.pathname)).toEqual([
      '/repos/acme/demo/branches/main/protection/required_status_checks',
      '/repos/acme/demo/commits/' + sha + '/check-runs',
      '/repos/acme/demo/branches/main/protection/required_status_checks',
      '/repos/acme/demo/commits/' + sha + '/check-runs',
    ]);
  });

  it('records request order for lock-boundary assertions in the full E2E', async () => {
    const server = await createFakeGitHubServer();
    servers.push(server);

    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Ax&base=main');
    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ head: 'x', base: 'main', title: 't', body: 'b' }),
    });

    expect(server.requests.map((request) => request.method + ' ' + request.pathname)).toEqual([
      'GET /repos/acme/demo/pulls',
      'POST /repos/acme/demo/pulls',
    ]);
  });
});
