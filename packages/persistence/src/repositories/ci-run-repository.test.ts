import { afterEach, describe, expect, it } from 'vitest';
import {
  CiRunRepository,
  openDatabase,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('CiRunRepository resumable persistence', () => {
  it('updates the same provider check without erasing previously persisted provider metadata', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    runMigrations(db);

    new RepositoryRepository(db).upsert({
      githubRepositoryId: 84722133,
      owner: 'company',
      name: 'web',
      defaultBranch: 'main',
      localBasePath: '/workspace/company/web',
    });
    const task = new TaskRepository(db).create({
      goal: 'observe CI',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: 84722133,
    });
    const pr = new PullRequestRepository(db).upsertForTask({
      taskId: task.id,
      repoId: 84722133,
      providerId: 'PR_node_42',
      number: 42,
      url: 'https://github.com/company/web/pull/42',
      headBranch: 'feat/task-000001-ci',
      baseBranch: 'main',
      state: 'open',
    });

    const ci = new CiRunRepository(db);
    const first = ci.upsertCheck({
      taskId: task.id,
      pullRequestId: pr.id,
      providerRunId: 'run-10',
      providerCheckId: 'check-20',
      workflowName: 'ci',
      checkName: 'verify',
      status: 'in_progress',
      conclusion: null,
      url: 'https://github.com/company/web/actions/runs/10',
      startedAt: '2026-09-22T01:00:00.000Z',
      finishedAt: null,
      updatedAt: '2026-09-22T01:00:10.000Z',
    });

    const second = ci.upsertCheck({
      taskId: task.id,
      pullRequestId: pr.id,
      providerCheckId: 'check-20',
      checkName: 'verify',
      status: 'completed',
      conclusion: 'success',
      finishedAt: '2026-09-22T01:01:00.000Z',
      updatedAt: '2026-09-22T01:01:01.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(ci.listForTask(task.id)).toHaveLength(1);
    expect(second).toMatchObject({
      providerRunId: 'run-10',
      providerCheckId: 'check-20',
      workflowName: 'ci',
      checkName: 'verify',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/company/web/actions/runs/10',
      startedAt: '2026-09-22T01:00:00.000Z',
      finishedAt: '2026-09-22T01:01:00.000Z',
      updatedAt: '2026-09-22T01:01:01.000Z',
    });
  });
});
