import type { SecretProvider } from '@gram/secrets';
import type {
  PullRequestClientPort,
  PullRequestView,
} from './pull-request-service.js';

export interface GitHubHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type GitHubFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<GitHubHttpResponse>;

interface GitHubPullRequestPayload {
  node_id?: unknown;
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  head?: { ref?: unknown };
  base?: { ref?: unknown };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decodePullRequest(value: unknown): PullRequestView {
  if (value === null || typeof value !== 'object') {
    throw new Error('GitHub returned an invalid pull request payload');
  }
  const payload = value as GitHubPullRequestPayload;
  if (
    typeof payload.number !== 'number' ||
    typeof payload.html_url !== 'string' ||
    (payload.state !== 'open' && payload.state !== 'closed') ||
    typeof payload.head?.ref !== 'string' ||
    typeof payload.base?.ref !== 'string'
  ) {
    throw new Error('GitHub returned an incomplete pull request payload');
  }

  return {
    ...(typeof payload.node_id === 'string'
      ? { providerId: payload.node_id }
      : {}),
    number: payload.number,
    url: payload.html_url,
    headBranch: payload.head.ref,
    baseBranch: payload.base.ref,
    state: payload.state,
  };
}

export interface GitHubClientOptions {
  secrets: SecretProvider;
  fetch: GitHubFetch;
  apiBaseUrl?: string;
  credentialName?: string;
}

export class GitHubClient implements PullRequestClientPort {
  private readonly apiBaseUrl: string;
  private readonly credentialName: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
    this.credentialName = options.credentialName ?? 'github.token';
  }

  async findOpenPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestView | undefined> {
    const query = new URLSearchParams({
      state: 'open',
      head: `${input.owner}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: '10',
    });
    const response = await this.request(
      `/repos/${encode(input.owner)}/${encode(input.name)}/pulls?${query.toString()}`,
      { method: 'GET' },
    );
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error('GitHub pull request search did not return a list');
    }

    for (const value of body) {
      const pr = decodePullRequest(value);
      if (
        pr.state === 'open' &&
        pr.headBranch === input.headBranch &&
        pr.baseBranch === input.baseBranch
      ) {
        return pr;
      }
    }
    return undefined;
  }

  async createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestView> {
    const response = await this.request(
      `/repos/${encode(input.owner)}/${encode(input.name)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          head: input.headBranch,
          base: input.baseBranch,
          title: input.title,
          body: input.body,
        }),
      },
    );
    return decodePullRequest(await response.json());
  }

  private async request(
    path: string,
    input: { method: string; body?: string },
  ): Promise<GitHubHttpResponse> {
    const lease = await this.options.secrets.getForUse(this.credentialName);
    try {
      return await lease.withValue(async (token) => {
        const response = await this.options.fetch(
          `${this.apiBaseUrl}${path}`,
          {
            method: input.method,
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28',
              ...(input.body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        );
        if (!response.ok) {
          const message = await response.text();
          throw new Error(
            `GitHub request failed with status ${response.status}: ${message}`,
          );
        }
        return response;
      });
    } finally {
      lease.dispose();
    }
  }
}
