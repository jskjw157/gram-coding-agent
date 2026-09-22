import { describe, expect, it, vi } from 'vitest';
import {
  ChecksService,
  type CiPullRequestContext,
  type RequiredCheckSnapshot,
} from './checks-service.js';

const pr: CiPullRequestContext = {
  taskId: '018d8a73-6b4e-7000-8000-000000000001',
  pullRequestId: 17,
  owner: 'company',
  name: 'web',
  number: 42,
  headSha: 'a'.repeat(40),
  baseBranch: 'main',
};

function check(
  overrides: Partial<RequiredCheckSnapshot> = {},
): RequiredCheckSnapshot {
  return {
    providerRunId: 'run-10',
    providerCheckId: 'check-20',
    workflowName: 'ci',
    checkName: 'verify',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/company/web/actions/runs/10',
    startedAt: '2026-09-22T01:00:00.000Z',
    finishedAt: '2026-09-22T01:01:00.000Z',
    ...overrides,
  };
}

describe('ChecksService lock-free CI observation', () => {
  it('observes and completes required-success CI without touching a Repo Lock', async () => {
    const forbiddenLock = {
      acquire: vi.fn(() => {
        throw new Error('CI observer must not acquire repo lock');
      }),
      release: vi.fn(() => {
        throw new Error('CI observer must not release repo lock');
      }),
    };
    const persistence = {
      upsertCheck: vi.fn(),
    };
    const completion = {
      complete: vi.fn(),
    };
    const client = {
      listRequiredChecks: vi.fn(async () => [
        check(),
        check({
          providerCheckId: 'check-21',
          checkName: 'build',
        }),
      ]),
    };

    const service = new ChecksService({
      client,
      persistence,
      completion,
      delay: { wait: vi.fn() },
      maxAttempts: 3,
      pollIntervalMs: 25,
    });

    const result = await service.observeRequiredChecks(pr);

    expect(result.outcome).toBe('SUCCESS');
    expect(result.attempts).toBe(1);
    expect(persistence.upsertCheck).toHaveBeenCalledTimes(2);
    expect(completion.complete).toHaveBeenCalledWith(pr.taskId);
    expect(forbiddenLock.acquire).not.toHaveBeenCalled();
    expect(forbiddenLock.release).not.toHaveBeenCalled();
  });

  it('records terminal required-check failure and does not complete or mutate code', async () => {
    const persistence = {
      upsertCheck: vi.fn(),
    };
    const completion = {
      complete: vi.fn(),
    };
    const service = new ChecksService({
      client: {
        listRequiredChecks: vi.fn(async () => [
          check({ conclusion: 'failure' }),
        ]),
      },
      persistence,
      completion,
      delay: { wait: vi.fn() },
      maxAttempts: 3,
      pollIntervalMs: 25,
    });

    const result = await service.observeRequiredChecks(pr);

    expect(result.outcome).toBe('FAILURE');
    expect(result.checks[0]).toMatchObject({
      checkName: 'verify',
      status: 'completed',
      conclusion: 'failure',
    });
    expect(persistence.upsertCheck).toHaveBeenCalledTimes(1);
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it('bounds polling and returns PENDING so observation can resume later', async () => {
    const wait = vi.fn(async () => undefined);
    const listRequiredChecks = vi.fn(async () => [
      check({
        status: 'in_progress',
        conclusion: null,
        finishedAt: null,
      }),
    ]);
    const completion = {
      complete: vi.fn(),
    };
    const service = new ChecksService({
      client: { listRequiredChecks },
      persistence: { upsertCheck: vi.fn() },
      completion,
      delay: { wait },
      maxAttempts: 2,
      pollIntervalMs: 25,
    });

    const result = await service.observeRequiredChecks(pr);

    expect(result.outcome).toBe('PENDING');
    expect(result.attempts).toBe(2);
    expect(listRequiredChecks).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(25);
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it('can resume a previously pending observation and complete on a later call', async () => {
    const listRequiredChecks = vi
      .fn()
      .mockResolvedValueOnce([
        check({
          status: 'in_progress',
          conclusion: null,
          finishedAt: null,
        }),
      ])
      .mockResolvedValueOnce([check()]);
    const completion = {
      complete: vi.fn(),
    };
    const service = new ChecksService({
      client: { listRequiredChecks },
      persistence: { upsertCheck: vi.fn() },
      completion,
      delay: { wait: vi.fn() },
      maxAttempts: 1,
      pollIntervalMs: 25,
    });

    const first = await service.observeRequiredChecks(pr);
    const second = await service.observeRequiredChecks(pr);

    expect(first.outcome).toBe('PENDING');
    expect(second.outcome).toBe('SUCCESS');
    expect(completion.complete).toHaveBeenCalledTimes(1);
  });
});
