import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubChecksClient } from '../../../packages/github/src/checks-client.js';
import {
  createFakeGitHubServer,
  type FakeGitHubServer,
} from './fake-github-server.js';

const TOKEN = 'fake-test-token-not-a-real-pat';

const servers: FakeGitHubServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function bearer(token: string): { authorization: string } {
  return { authorization: 'Bearer ' + token };
}

function jsonHeaders(token: string): { authorization: string; 'content-type': string } {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}

function serverPort(server: FakeGitHubServer): number {
  return Number(new URL(server.apiBaseUrl).port);
}

interface RawHttpResult {
  status: number;
  body: string;
}

function rawHttpStatus(
  port: number,
  target: string,
  headers: Record<string, string>,
): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const separator = text.indexOf('\r\n\r\n');
      const head = separator === -1 ? text : text.slice(0, separator);
      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1]);
      resolve({ status, body: separator === -1 ? '' : text.slice(separator + 4) });
    });
    socket.on('error', reject);
    const headerLines = Object.entries(headers).map(
      ([name, value]) => name + ': ' + value,
    );
    socket.write(
      'GET ' +
        target +
        ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' +
        (headerLines.length > 0 ? headerLines.join('\r\n') + '\r\n' : '') +
        '\r\n',
    );
  });
}

describe('fake GitHub server', () => {
  it('creates and then reuses an open pull request by exact head/base pair', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const query = new URLSearchParams({
      state: 'open',
      head: 'acme:feat/task-000001-fix',
      base: 'main',
    });

    const before = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?' + query.toString(),
      { headers: bearer(TOKEN) },
    );
    expect(await before.json()).toEqual([]);

    const createdResponse = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls',
      {
        method: 'POST',
        headers: jsonHeaders(TOKEN),
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
      { headers: bearer(TOKEN) },
    );
    const found = await after.json() as Array<{ number: number }>;
    expect(found).toHaveLength(1);
    expect(found[0]?.number).toBe(created.number);
    expect(server.pullRequests).toHaveLength(1);
  });

  it('advances required checks deterministically from pending to success', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);
    const sha = 'a'.repeat(40);
    const url =
      server.apiBaseUrl + '/repos/acme/demo/commits/' + sha + '/check-runs';

    const first = await fetch(url, { headers: bearer(TOKEN) });
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

    const second = await fetch(url, { headers: bearer(TOKEN) });
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
    // The fake 401s any request whose Bearer token does not match, so it must
    // be configured with the exact credential the client below leases.
    const clientToken = 'fake-github-token';
    const server = await createFakeGitHubServer({ token: clientToken });
    servers.push(server);
    const sha = 'a'.repeat(40);

    const client = new GitHubChecksClient({
      secrets: {
        getForUse: async () => ({
          withValue: <T>(use: (value: string) => T) => use(clientToken),
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
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Ax&base=main', { headers: bearer(TOKEN) });
    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ head: 'x', base: 'main', title: 't', body: 'b' }),
    });

    expect(server.requests.map((request) => request.method + ' ' + request.pathname)).toEqual([
      'GET /repos/acme/demo/pulls',
      'POST /repos/acme/demo/pulls',
    ]);
  });

  it('B1: serves requests carrying the correct credential', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open',
      { headers: bearer(TOKEN) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('B2: rejects requests with no Authorization header', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      message: 'Bad credentials',
      documentation_url: 'https://docs.github.com/rest',
    });
  });

  it('B3: rejects requests with a wrong token value', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open',
      { headers: bearer('not-the-expected-token') },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      message: 'Bad credentials',
      documentation_url: 'https://docs.github.com/rest',
    });
  });

  it('B4: rejects the legacy token scheme', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open',
      { headers: { authorization: 'token ' + TOKEN } },
    );
    expect(response.status).toBe(401);
  });

  it('B5: rejects a duplicate pull request for the same head and base', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const payload = { head: 'feat/dup', base: 'main', title: 't', body: 'b' };
    const first = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    const second = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual({ message: 'A pull request already exists' });
  });

  it('B6: returns no pull request when head or base does not match', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const setup = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ head: 'feat/kept', base: 'main', title: 't', body: 'b' }),
    });
    expect(setup.status).toBe(201);

    const matching = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Afeat%2Fkept&base=main',
      { headers: bearer(TOKEN) },
    );
    const matchingBody = await matching.json() as Array<{ number: number }>;
    expect(matchingBody).toHaveLength(1);
    expect(matchingBody[0]?.number).toBe(1);

    const wrongHead = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Afeat%2Fother&base=main',
      { headers: bearer(TOKEN) },
    );
    expect(await wrongHead.json()).toEqual([]);

    const wrongBase = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Afeat%2Fkept&base=develop',
      { headers: bearer(TOKEN) },
    );
    expect(await wrongBase.json()).toEqual([]);
  });

  it('B7: tracks check-run completion independently per SHA', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const urlFor = (sha: string): string =>
      server.apiBaseUrl + '/repos/acme/demo/commits/' + sha + '/check-runs';

    await fetch(urlFor(shaA), { headers: bearer(TOKEN) });
    const completedA = await fetch(urlFor(shaA), { headers: bearer(TOKEN) });
    const completedBody = await completedA.json() as {
      check_runs: Array<{ status: string; conclusion: string | null }>;
    };
    expect(completedBody.check_runs[0]).toMatchObject({ status: 'completed', conclusion: 'success' });

    const firstB = await fetch(urlFor(shaB), { headers: bearer(TOKEN) });
    const firstBBody = await firstB.json() as {
      check_runs: Array<{ status: string; conclusion: string | null }>;
    };
    expect(firstBBody.check_runs[0]).toMatchObject({ status: 'in_progress', conclusion: null });
    expect(server.checkPollCount).toBe(3);
  });

  it('B8: accepts the pulls query parameter set GitHubClient sends, including per_page', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const created = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: JSON.stringify({ head: 'x', base: 'main', title: 't', body: 'b' }),
    });
    expect(created.status).toBe(201);

    const found = await fetch(
      server.apiBaseUrl + '/repos/acme/demo/pulls?state=open&head=acme%3Ax&base=main&per_page=10',
      { headers: bearer(TOKEN) },
    );
    expect(found.status).toBe(200);
    const body = await found.json() as Array<{ number: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.number).toBe(1);
  });

  it('B9: returns 404 for an unknown path when the credential is valid', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(server.apiBaseUrl + '/no/such/route', {
      headers: bearer(TOKEN),
    });
    expect(response.status).toBe(404);
  });

  it('B10: returns 401 for an unknown path when the credential is missing', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(server.apiBaseUrl + '/no/such/route');
    expect(response.status).toBe(401);
  });

  it('B11: rejects a malformed JSON body with 400', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: '{not valid json',
    });
    expect(response.status).toBe(400);
  });

  it('records authorization outcome without storing secrets', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open', {
      headers: bearer(TOKEN),
    });
    await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open');

    expect(server.requests.map((request) => request.authorized)).toEqual([true, false]);
    expect(JSON.stringify(server.requests)).not.toContain(TOKEN);

    const denied = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls?state=open');
    const deniedText = await denied.text();
    expect(denied.status).toBe(401);
    expect(deniedText).not.toContain(TOKEN);
  });

  it('C1: returns 401 before parsing when the request target is unparseable and the credential is missing', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const result = await rawHttpStatus(serverPort(server), 'http://[bad', {});
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body) as unknown).toEqual({
      message: 'Bad credentials',
      documentation_url: 'https://docs.github.com/rest',
    });
  });

  it('C2: returns 400 when the request target is unparseable but the credential is valid', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const result = await rawHttpStatus(serverPort(server), 'http://[bad', {
      authorization: 'Bearer ' + TOKEN,
    });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body) as unknown).toEqual({
      message: 'malformed request target',
    });
  });

  it('C3: logs a placeholder pathname without leaking an unparseable target', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);
    const probe = 'fake-leak-probe-not-a-secret';

    const result = await rawHttpStatus(
      serverPort(server),
      'http://user:' + probe + '@[bad',
      {},
    );
    expect(result.status).toBe(401);
    expect(server.requests.map((request) => request.method + ' ' + request.pathname)).toEqual([
      'GET <unparseable>',
    ]);
    expect(JSON.stringify(server.requests)).not.toContain(probe);
  });

  it('C4: rejects a JSON null body with 422, not 500', async () => {
    const server = await createFakeGitHubServer({ token: TOKEN });
    servers.push(server);

    const response = await fetch(server.apiBaseUrl + '/repos/acme/demo/pulls', {
      method: 'POST',
      headers: jsonHeaders(TOKEN),
      body: 'null',
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: 'invalid pull request payload' });
  });
});
