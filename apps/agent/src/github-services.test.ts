import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChecksService, GitHubClient, type GitHubFetch } from '@gram/github';
import {
  CiRunRepository, openDatabase, PullRequestEvidenceRepository,
  PullRequestRepository, RepositoryRepository, runMigrations, TaskRepository,
} from '@gram/persistence';
import { createProductionGitHubServices } from './github-services.js';
import type { SmokeBoundaryObserver } from './smoke-lock-observer.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllGlobals();
});
const headSha = 'a'.repeat(40);
const prPayload = {
  number: 42, html_url: 'https://github.com/acme/web/pull/42', state: 'open',
  head: { ref: 'feat/task-fix' }, base: { ref: 'main' },
};
function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function fixture(fetch?: GitHubFetch, observer?: SmokeBoundaryObserver) {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  new RepositoryRepository(db).upsert({ githubRepositoryId: 1, owner: 'acme', name: 'web', defaultBranch: 'main', localBasePath: '/repo' });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ goal: 'Fix persisted goal', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoId: 1 });
  const pullRequests = new PullRequestRepository(db);
  const ciRuns = new CiRunRepository(db);
  const dispose = vi.fn();
  const secrets = { getForUse: vi.fn(async () => ({ withValue: <T>(use: (value: string) => T): T => use('fake-token'), dispose })) };
  const services = createProductionGitHubServices({ secrets, pullRequests, ciRuns, evidence: new PullRequestEvidenceRepository(db), ...(fetch === undefined ? {} : { fetch }), ...(observer === undefined ? {} : { observer }) });
  const context = { taskId: task.id, repoId: 1, owner: 'acme', name: 'web', headBranch: 'feat/task-fix', baseBranch: 'main' };
  return { services, context, pullRequests, ciRuns, secrets, dispose, tasks };
}

describe('production GitHub services', () => {
  it('rejects unknown provider endpoints without inventing check-run evidence or sending HTTP', async () => {
    const transport = vi.fn(async () => response([]));
    const observer = { repoId: 1, sample: vi.fn(), bindPullRequest: vi.fn() };
    const f = fixture(transport, observer);
    const lookup = vi.spyOn(GitHubClient.prototype, 'findOpenPullRequest').mockImplementation(async function (this: GitHubClient) {
      await this.getJson('/repos/acme/web/unknown-endpoint');
      return undefined;
    });
    try {
      await expect(f.services.pullRequests.ensureForTask({ ...f.context, headSha })).rejects.toThrow('Smoke lock observation failed');
      expect(transport).not.toHaveBeenCalled();
      expect(observer.sample).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });
  it('requires explicit repository identity for opt-in CI and bypasses observer state for unrelated repositories', async () => {
    const transport = vi.fn(async (url: string) => response(url.includes('/rules/') || url.includes('/statuses?') ? [] : url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [] }));
    const observer = { repoId: 1, sample: vi.fn(() => { throw new Error('reader unavailable'); }), bindPullRequest: vi.fn() };
    const f = fixture(transport, observer);
    const withoutRepo = { taskId: f.context.taskId, owner: 'acme', name: 'web', headSha, pullRequestId: 8, number: 42, baseBranch: 'main' };
    await expect(f.services.checks.client.listRequiredChecks(withoutRepo)).rejects.toThrow('Smoke observation requires repository identity');
    expect(transport).not.toHaveBeenCalled();
    await expect(f.services.checks.client.listRequiredChecks({ ...withoutRepo, repoId: 2 })).resolves.toBeDefined();
    expect(observer.sample).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('brackets each actual CI HTTP call, including pagination, in independent samples', async () => {
    const order: string[] = [];
    const observer = { repoId: 1, sample: vi.fn((_context, boundary) => { order.push(`${boundary.boundary}:${boundary.endpoint}:${boundary.page}`); }), bindPullRequest: vi.fn() };
    const f = fixture(async (url) => {
      order.push('HTTP');
      return response(url.includes('/rules/') || url.includes('/statuses?') ? [] : url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: 'unit', head_sha: headSha, status: 'completed', conclusion: 'success' })) : [] });
    }, observer);
    await f.services.checks.client.listRequiredChecks({ ...f.context, headSha, pullRequestId: 8, number: 42 });
    expect(order).toEqual(['BEFORE:RULES:1', 'HTTP', 'AFTER:RULES:1', 'BEFORE:STATUSES:1', 'HTTP', 'AFTER:STATUSES:1', 'BEFORE:PROTECTION:null', 'HTTP', 'AFTER:PROTECTION:null', 'BEFORE:CHECK_RUNS:1', 'HTTP', 'AFTER:CHECK_RUNS:1', 'BEFORE:CHECK_RUNS:2', 'HTTP', 'AFTER:CHECK_RUNS:2']);
    expect(observer.sample.mock.calls.every(([context]) => context.headSha === headSha && context.pullRequestId === 8)).toBe(true);
  });
  it('binds PR samples after persistence and sanitizes transport failures', async () => {
    const observer = { repoId: 1, sample: vi.fn(), bindPullRequest: vi.fn() };
    const f = fixture(async (_url, init) => response(init.method === 'GET' ? [] : prPayload), observer);
    await f.services.pullRequests.ensureForTask({ ...f.context, headSha });
    expect(observer.sample).toHaveBeenCalledTimes(4);
    expect(observer.bindPullRequest).toHaveBeenCalledWith(expect.objectContaining({ headSha, pullRequestId: null }), expect.objectContaining({ number: 42 }));
    const failing = fixture(async () => { throw new Error('secret-token'); }, observer);
    await expect(failing.services.pullRequests.ensureForTask({ ...failing.context, headSha })).rejects.toThrow('GitHub request transport failed');
    expect(JSON.stringify(observer.sample.mock.calls)).not.toContain('secret-token');
  });
  it('blocks transport when measurement fails and leaves other repositories unaffected', async () => {
    const fetch = vi.fn(async () => response([prPayload]));
    const observer = { repoId: 1, sample: vi.fn(() => { throw new Error('inspection failed'); }), bindPullRequest: vi.fn() };
    const f = fixture(fetch, observer);
    await expect(f.services.pullRequests.ensureForTask({ ...f.context, headSha })).rejects.toThrow('Smoke lock observation failed');
    expect(fetch).not.toHaveBeenCalled();
    observer.repoId = 2;
    await expect(f.services.pullRequests.ensureForTask(f.context)).resolves.toMatchObject({ number: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes failed AFTER measurement from transport failure after a successful remote PR creation', async () => {
    let created = false;
    const recorded: string[] = [];
    const observer = { repoId: 1, bindPullRequest: vi.fn(), sample: vi.fn((_context, boundary) => {
      if (boundary.endpoint === 'PR_CREATE' && boundary.boundary === 'AFTER') throw new Error('private-journal-path');
      recorded.push(`${boundary.endpoint}:${boundary.boundary}`);
    }) };
    const f = fixture(async (_url, init) => {
      if (init.method === 'POST') created = true;
      return response(init.method === 'POST' ? prPayload : []);
    }, observer);
    await expect(f.services.pullRequests.ensureForTask({ ...f.context, headSha })).rejects.toThrow('Smoke lock observation failed');
    expect(created).toBe(true);
    expect(recorded).toEqual(['PR_FIND:BEFORE', 'PR_FIND:AFTER', 'PR_CREATE:BEFORE']);
    expect(observer.bindPullRequest).not.toHaveBeenCalled();
    expect(f.pullRequests.getLatestForTask(f.context.taskId)).toBeUndefined();
  });
  it.each(['BEFORE', 'AFTER'])('preserves CI measurement failure classification at %s', async (edge) => {
    const transport = vi.fn(async () => response([]));
    const observer = { repoId: 1, bindPullRequest: vi.fn(), sample: vi.fn((_context, boundary) => {
      if (boundary.boundary === edge) throw new Error('private-inspection-detail');
    }) };
    const f = fixture(transport, observer);
    await expect(f.services.checks.client.listRequiredChecks({ ...f.context, headSha, pullRequestId: 8, number: 42 })).rejects.toThrow('Smoke lock observation failed');
    expect(transport).toHaveBeenCalledTimes(edge === 'BEFORE' ? 0 : 1);
  });
  it('keeps concurrent HTTP samples bound to their own task, HEAD and PR', async () => {
    const observer = { repoId: 1, sample: vi.fn(), bindPullRequest: vi.fn() };
    const f = fixture(async (url) => {
      await Promise.resolve();
      return response(url.includes('/rules/') || url.includes('/statuses?') ? [] : url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [] });
    }, observer);
    await Promise.all([1, 2].map((id) => f.services.checks.client.listRequiredChecks({ ...f.context, taskId: `task-${id}`, headSha: String(id).repeat(40), pullRequestId: id, number: id })));
    for (const [context] of observer.sample.mock.calls) {
      expect(context.taskId).toBe(`task-${context.pullRequestId}`);
      expect(context.headSha).toBe(String(context.pullRequestId).repeat(40));
    }
    expect(new Set(observer.sample.mock.calls.map(([context]) => context.correlationId)).size).toBe(2);
  });
  it('creates a PR using persisted metadata and persists the returned identity', async () => {
    const requests: Array<{ url: string; init: Parameters<GitHubFetch>[1] }> = [];
    const f = fixture(async (url, init) => { requests.push({ url, init }); return response(init.method === 'GET' ? [] : prPayload); });
    const pr = await f.services.pullRequests.ensureForTask(f.context);
    expect(pr.number).toBe(42);
    expect(f.pullRequests.getLatestForTask(f.context.taskId)?.number).toBe(42);
    const requestBody = requests[1]?.init.body;
    if (requestBody === undefined) throw new Error('PR create body is missing');
    expect(JSON.parse(requestBody)).toMatchObject({ title: 'Fix persisted goal', head: 'feat/task-fix', base: 'main' });
    expect(requests.map(({ init }) => init.headers.Authorization)).toEqual(['Bearer fake-token', 'Bearer fake-token']);
    expect(f.secrets.getForUse).toHaveBeenCalledWith('github.token');
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });

  it('reuses an exact existing PR without issuing a create request', async () => {
    const requests: string[] = [];
    const f = fixture(async (_url, init) => { requests.push(init.method); return response([prPayload]); });
    await f.services.pullRequests.ensureForTask(f.context);
    expect(requests).toEqual(['GET']);
    expect(f.pullRequests.getLatestForTask(f.context.taskId)?.number).toBe(42);
  });

  it('uses HEAD-bound required checks and persists their observation', async () => {
    const f = fixture(async (url) => response(url.includes('/pulls?') ? [prPayload] : url.includes('/rules/branches/') || url.includes('/statuses?') ? [] : url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [{ id: 100, name: 'unit', head_sha: headSha, status: 'completed', conclusion: 'success' }] }));
    await f.services.pullRequests.ensureForTask(f.context);
    const storedPr = f.pullRequests.getLatestForTask(f.context.taskId);
    if (storedPr === undefined) throw new Error('PR was not persisted');
    const completed: string[] = [];
    const checks = new ChecksService({ ...f.services.checks, completion: { complete: (taskId) => { completed.push(taskId); } }, maxAttempts: 1 });
    const result = await checks.observeRequiredChecks({ ...f.context, pullRequestId: storedPr.id, number: 42, headSha });
    expect(result.outcome).toBe('SUCCESS');
    expect(completed).toEqual([f.context.taskId]);
    expect(f.ciRuns.listForTask(f.context.taskId)).toMatchObject([{ providerCheckId: '100', conclusion: 'success' }]);
  });

  it.each([401, 403, 429])('fails closed on HTTP %s without persisting a PR or retrying', async (status) => {
    let requests = 0;
    const f = fixture(async () => { requests++; return response({ message: 'denied' }, status); });
    await expect(f.services.pullRequests.ensureForTask(f.context)).rejects.toThrow(`status ${status}`);
    expect(f.pullRequests.getLatestForTask(f.context.taskId)).toBeUndefined();
    expect(requests).toBe(1);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 200, body: [{ type: 'required_status_checks' }] },
    { status: 200, body: [{ type: 'deletion' }] },
    { status: 200, body: {} },
    { status: 403, body: [] },
    { status: 404, body: [] },
    { status: 429, body: [] },
    { status: 500, body: [] },
    { status: 200, body: new Error('network unavailable') },
  ])('refuses unknown or unsupported active rules before reporting classic checks: %j', async ({ status, body }) => {
    const requests: string[] = [];
    const f = fixture(async (url) => {
      requests.push(url);
      if (url.includes('/rules/branches/')) {
        if (body instanceof Error) throw body;
        return response(body, status);
      }
      return response(url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [{ id: 100, name: 'unit', head_sha: headSha, status: 'completed', conclusion: 'success' }] });
    });
    const pr = f.pullRequests.upsertForTask({ ...f.context, number: 42, url: prPayload.html_url, state: 'open' });
    const completed: string[] = [];
    const checks = new ChecksService({ ...f.services.checks, completion: { complete: (id) => { completed.push(id); } }, maxAttempts: 1 });
    await expect(checks.observeRequiredChecks({ ...f.context, pullRequestId: pr.id, number: 42, headSha })).rejects.toThrow();
    expect(completed).toEqual([]);
    expect(f.ciRuns.listForTask(f.context.taskId)).toEqual([]);
    expect(requests).toEqual(['https://api.github.com/repos/acme/web/rules/branches/main?per_page=100&page=1']);
  });

  it('rejects malformed HEAD before fetching rules and rechecks active rules each observation', async () => {
    let ruleReads = 0;
    const f = fixture(async (url) => {
      if (url.includes('/statuses?')) return response([]);
      if (url.includes('/rules/branches/')) return response(++ruleReads === 1 ? [] : [{ type: 'required_status_checks' }]);
      return response(url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [] });
    });
    const context = { ...f.context, pullRequestId: 1, number: 42, headSha };
    await expect(f.services.checks.client.listRequiredChecks({ ...context, headSha: 'short' })).rejects.toThrow(/HEAD SHA/);
    expect(ruleReads).toBe(0);
    await expect(f.services.checks.client.listRequiredChecks(context)).resolves.toMatchObject([{ status: 'queued' }]);
    await expect(f.services.checks.client.listRequiredChecks(context)).rejects.toThrow(/rulesets/);
    expect(ruleReads).toBe(2);
  });

  it.each([
    { status: 200, body: [{ context: 'unit', state: 'failure' }] },
    { status: 200, body: [{ context: 'unrelated', state: 'success' }] },
    { status: 200, body: {} },
    { status: 200, body: null },
    { status: 401, body: [] },
    { status: 403, body: [] },
    { status: 404, body: [] },
    { status: 429, body: [] },
    { status: 500, body: [] },
    { status: 200, body: new Error('network unavailable') },
  ])('refuses legacy or unknown status evidence despite passing check-runs: %j', async ({ status, body }) => {
    const requests: string[] = [];
    const f = fixture(async (url) => {
      requests.push(url);
      if (url.includes('/rules/branches/')) return response([]);
      if (url.includes('/statuses?')) {
        if (body instanceof Error) throw body;
        return response(body, status);
      }
      return response(url.includes('/protection/') ? { contexts: ['unit'] } : { check_runs: [{ id: 100, name: 'unit', head_sha: headSha, status: 'completed', conclusion: 'success' }] });
    });
    const pr = f.pullRequests.upsertForTask({ ...f.context, number: 42, url: prPayload.html_url, state: 'open' });
    const completed: string[] = [];
    const checks = new ChecksService({ ...f.services.checks, completion: { complete: (id) => { completed.push(id); } }, maxAttempts: 1 });
    await expect(checks.observeRequiredChecks({ ...f.context, pullRequestId: pr.id, number: 42, headSha })).rejects.toThrow();
    expect(completed).toEqual([]);
    expect(f.ciRuns.listForTask(f.context.taskId)).toEqual([]);
    expect(requests).toEqual([
      'https://api.github.com/repos/acme/web/rules/branches/main?per_page=100&page=1',
      `https://api.github.com/repos/acme/web/commits/${headSha}/statuses?per_page=1&page=1`,
    ]);
  });

  it('does not acquire credentials at construction and fails before HTTP if unavailable', async () => {
    let requests = 0;
    const f = fixture(async () => { requests++; return response([]); });
    expect(f.secrets.getForUse).not.toHaveBeenCalled();
    f.secrets.getForUse.mockRejectedValueOnce(new Error('credential unavailable'));
    await expect(f.services.pullRequests.ensureForTask(f.context)).rejects.toThrow('credential unavailable');
    expect(requests).toBe(0);
  });

  it('bounds native requests and refuses redirects without exposing alternate hosts', async () => {
    const nativeFetch = vi.fn(async () => response([prPayload]));
    vi.stubGlobal('fetch', nativeFetch);
    const f = fixture();
    await f.services.pullRequests.ensureForTask(f.context);
    expect(nativeFetch).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/api.github.com\//), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
});
