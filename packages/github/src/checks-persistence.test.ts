import { afterEach, describe, expect, it } from 'vitest';
import {
  CiRunRepository,
  openDatabase,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { PersistentCiCompletion } from './checks-service.js';

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function setup() {
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
  const tasks = new TaskRepository(db);
  const task = tasks.create({
    goal: 'observe CI',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 84722133,
  });

  tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
  tasks.transition(task.id, 'WAITING_REPO_LOCK', 'PREPARING');
  tasks.transition(task.id, 'PREPARING', 'RUNNING');
  tasks.transition(task.id, 'RUNNING', 'VERIFYING');
  tasks.transition(task.id, 'VERIFYING', 'PUBLISHING');

  const pr = new PullRequestRepository(db).upsertForTask({
    taskId: task.id,
    repoId: 84722133,
    number: 42,
    url: 'https://github.com/company/web/pull/42',
    headBranch: 'feat/task-000001-ci',
    baseBranch: 'main',
    state: 'open',
  });

  return { db, tasks, task, pr };
}

describe('CI persistence and completion', () => {
  it('upserts provider/check state so pending observation can resume without duplicate rows', () => {
    const { db, task, pr } = setup();
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

    const updated = ci.upsertCheck({
      taskId: task.id,
      pullRequestId: pr.id,
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

    expect(updated.id).toBe(first.id);
    expect(ci.listForTask(task.id)).toEqual([
      expect.objectContaining({
        id: first.id,
        providerRunId: 'run-10',
        providerCheckId: 'check-20',
        workflowName: 'ci',
        checkName: 'verify',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-09-22T01:00:00.000Z',
        finishedAt: '2026-09-22T01:01:00.000Z',
        url: 'https://github.com/company/web/actions/runs/10',
      }),
    ]);
  });

  it('moves PUBLISHING to COMPLETED only through the CI completion port', () => {
    const { tasks, task } = setup();
    const completion = new PersistentCiCompletion(tasks);

    completion.complete(task.id);

    expect(tasks.get(task.id)?.status).toBe('COMPLETED');
    expect(() => completion.complete(task.id)).not.toThrow();
  });

  it('rejects completion from a non-PUBLISHING state', () => {
    const { tasks, task } = setup();
    tasks.transition(task.id, 'PUBLISHING', 'RUNNING');
    const completion = new PersistentCiCompletion(tasks);

    expect(() => completion.complete(task.id)).toThrow(
      /requires PUBLISHING task state/i,
    );
  });
});
