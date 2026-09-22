import { afterEach, describe, expect, it } from 'vitest';
import {
  GitCommitRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('GitCommitRepository publishing state', () => {
  it('persists the local commit before remote confirmation and records confirmation later', () => {
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
      goal: 'publish verified change',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: 84722133,
    });

    const commits = new GitCommitRepository(db);
    const commitId = commits.recordCommit({
      taskId: task.id,
      repoId: 84722133,
      sha: 'a'.repeat(40),
      branch: 'feat/task-000001-publish',
      remoteName: 'origin',
      createdAt: '2026-09-22T01:00:00.000Z',
    });

    expect(commits.get(commitId)).toMatchObject({
      id: commitId,
      taskId: task.id,
      repoId: 84722133,
      sha: 'a'.repeat(40),
      remoteConfirmed: false,
      remoteConfirmedAt: null,
    });

    commits.markRemoteConfirmed(commitId, '2026-09-22T01:01:00.000Z');

    expect(commits.get(commitId)).toMatchObject({
      remoteConfirmed: true,
      remoteConfirmedAt: '2026-09-22T01:01:00.000Z',
    });
  });
});
