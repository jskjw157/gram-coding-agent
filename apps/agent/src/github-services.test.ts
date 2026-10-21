import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChecksService, type GitHubFetch } from '@gram/github';
import {
  CiRunRepository, openDatabase, PullRequestEvidenceRepository,
  PullRequestRepository, RepositoryRepository, runMigrations, TaskRepository,
} from '@gram/persistence';
import { createProductionGitHubServices } from './github-services.js';

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
function fixture(fetch?: GitHubFetch) {
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
  const services = createProductionGitHubServices({ secrets, pullRequests, ciRuns, evidence: new PullRequestEvidenceRepository(db), ...(fetch === undefined ? {} : { fetch }) });
  const context = { taskId: task.id, repoId: 1, owner: 'acme', name: 'web', headBranch: 'feat/task-fix', baseBranch: 'main' };
  return { services, context, pullRequests, ciRuns, secrets, dispose, tasks };
}

describe('production GitHub services', () => {
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
