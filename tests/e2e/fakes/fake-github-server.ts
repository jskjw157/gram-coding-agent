import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGitHubRequest {
  method: string;
  pathname: string;
}

export interface FakeGitHubPullRequest {
  node_id: string;
  number: number;
  html_url: string;
  state: 'open';
  head: { ref: string };
  base: { ref: string };
  title: string;
  body: string;
  owner: string;
  repo: string;
}

export interface FakeGitHubServer {
  apiBaseUrl: string;
  pullRequests: readonly FakeGitHubPullRequest[];
  requests: readonly FakeGitHubRequest[];
  readonly checkPollCount: number;
  close(): Promise<void>;
}

interface CreatePullRequestBody {
  head?: unknown;
  base?: unknown;
  title?: unknown;
  body?: unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parsePullsPath(pathname: string): { owner: string; repo: string } | undefined {
  const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(pathname);
  if (match === null) return undefined;
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) return undefined;
  return { owner: decodeURIComponent(owner), repo: decodeURIComponent(repo) };
}

function parseCheckRunsPath(
  pathname: string,
): { owner: string; repo: string; sha: string } | undefined {
  const match =
    /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/check-runs$/.exec(
      pathname,
    );
  if (match === null) return undefined;
  const owner = match[1];
  const repo = match[2];
  const sha = match[3];
  if (owner === undefined || repo === undefined || sha === undefined) {
    return undefined;
  }
  return {
    owner: decodeURIComponent(owner),
    repo: decodeURIComponent(repo),
    sha,
  };
}

export async function createFakeGitHubServer(): Promise<FakeGitHubServer> {
  const pullRequests: FakeGitHubPullRequest[] = [];
  const requests: FakeGitHubRequest[] = [];
  let checkPollCount = 0;
  let apiBaseUrl = '';

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method, pathname: url.pathname });

      const pullsRepo = parsePullsPath(url.pathname);
      if (pullsRepo !== undefined && method === 'GET') {
        const state = url.searchParams.get('state');
        const head = url.searchParams.get('head');
        const base = url.searchParams.get('base');
        const matches = pullRequests.filter((pullRequest) => {
          const exactHead = \`\${pullRequest.owner}:\${pullRequest.head.ref}\`;
          return (
            pullRequest.owner === pullsRepo.owner &&
            pullRequest.repo === pullsRepo.repo &&
            (state === null || state === 'open') &&
            (head === null || head === exactHead) &&
            (base === null || base === pullRequest.base.ref)
          );
        });
        sendJson(response, 200, matches);
        return;
      }

      if (pullsRepo !== undefined && method === 'POST') {
        const body = (await readJson(request)) as CreatePullRequestBody;
        if (
          typeof body.head !== 'string' ||
          typeof body.base !== 'string' ||
          typeof body.title !== 'string' ||
          typeof body.body !== 'string'
        ) {
          sendJson(response, 422, { message: 'invalid pull request payload' });
          return;
        }

        const existing = pullRequests.find(
          (pullRequest) =>
            pullRequest.owner === pullsRepo.owner &&
            pullRequest.repo === pullsRepo.repo &&
            pullRequest.head.ref === body.head &&
            pullRequest.base.ref === body.base,
        );
        if (existing !== undefined) {
          sendJson(response, 422, { message: 'A pull request already exists' });
          return;
        }

        const number = pullRequests.length + 1;
        const pullRequest: FakeGitHubPullRequest = {
          node_id: \`PR_fake_\${number}\`,
          number,
          html_url: \`\${apiBaseUrl}/\${pullsRepo.owner}/\${pullsRepo.repo}/pull/\${number}\`,
          state: 'open',
          head: { ref: body.head },
          base: { ref: body.base },
          title: body.title,
          body: body.body,
          owner: pullsRepo.owner,
          repo: pullsRepo.repo,
        };
        pullRequests.push(pullRequest);
        sendJson(response, 201, pullRequest);
        return;
      }

      const checkRepo = parseCheckRunsPath(url.pathname);
      if (checkRepo !== undefined && method === 'GET') {
        checkPollCount += 1;
        const complete = checkPollCount >= 2;
        sendJson(response, 200, {
          total_count: 1,
          check_runs: [
            {
              id: 2001,
              node_id: 'CR_fake_2001',
              name: 'verify',
              status: complete ? 'completed' : 'in_progress',
              conclusion: complete ? 'success' : null,
              details_url: \`\${apiBaseUrl}/\${checkRepo.owner}/\${checkRepo.repo}/actions/runs/1001\`,
              started_at: '2026-01-01T00:00:00.000Z',
              completed_at: complete ? '2026-01-01T00:00:01.000Z' : null,
              head_sha: checkRepo.sha,
              workflow_name: 'ci',
              run_id: 1001,
            },
          ],
        });
        return;
      }

      sendJson(response, 404, { message: 'Not Found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'fake server error';
      sendJson(response, 500, { message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address() as AddressInfo;
  apiBaseUrl = \`http://127.0.0.1:\${address.port}\`;

  return {
    apiBaseUrl,
    pullRequests,
    requests,
    get checkPollCount() {
      return checkPollCount;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    },
  };
}
