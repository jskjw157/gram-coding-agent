import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitCommitRepository,
  LockRepository,
  openDatabase,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { RepoLockService } from '@gram/repo-lock';
import {
  PersistentCiContextError,
  PersistentCiContextResolver,
  RegisteredRepositoryProfiles,
  UnknownRepositorySelectorError,
} from './persistence-adapters.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

const REPO_ID = 7701;
const PR_NUMBER = 42;
const SHA = 'a91c34f0a91c34f0a91c34f0a91c34f0a91c34f0';
const BRANCH = 'fix/task-000001-ship-web-fix';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gram-persistence-adapters-'));
  roots.push(root);
  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);

  const repositories = new RepositoryRepository(db);
  const tasks = new TaskRepository(db);
  const pullRequests = new PullRequestRepository(db);
  const gitCommits = new GitCommitRepository(db);
  const locks = new LockRepository(db);
  return { root, db, repositories, tasks, pullRequests, gitCommits, locks };
}

function seedRepository(repositories: RepositoryRepository, root: string): void {
  repositories.upsert({
    githubRepositoryId: REPO_ID,
    owner: 'acme',
    name: 'web',
    defaultBranch: 'main',
    localBasePath: join(root, 'web'),
  });
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('persistence adapters', () => {
  it('resolves a registered selector and binds the selector-only task before locking', async () => {
    const { root, db, repositories, tasks, locks } = setup();
    seedRepository(repositories, root);
    const task = tasks.create({
      goal: 'Ship the web fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoSelector: 'acme/web',
    });
    expect(tasks.get(task.id)?.repoId).toBeNull();

    const profiles = new RegisteredRepositoryProfiles({ repositories, tasks });
    const profile = await profiles.resolveAndBind(task.id);

    expect(profile).toEqual({
      githubRepositoryId: REPO_ID,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      localBasePath: join(root, 'web'),
    });
    expect(tasks.get(task.id)?.repoId).toBe(REPO_ID);

    tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
    const lockDirectory = join(root, 'locks');
    const service = new RepoLockService({
      locks,
      tasks,
      lockDirectory,
      now: () => new Date('2026-09-28T00:00:00.000Z'),
      pid: () => 4242,
      bootId: () => 'boot-adapters-1',
      scheduler: {
        setInterval: (): unknown => 0,
        clearInterval: (): void => undefined,
      },
    });
    const lease = await service.acquire(REPO_ID, task.id);
    expect(tasks.get(task.id)?.status).toBe('PREPARING');
    await lease.release();

    const count = db.prepare('SELECT COUNT(*) AS count FROM repo_locks').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(existsSync(join(lockDirectory, `${REPO_ID}.lock`))).toBe(false);
  });

  it('rejects an unknown selector before any lock file or SQL lease is created', async () => {
    const { root, db, repositories, tasks } = setup();
    seedRepository(repositories, root);
    const task = tasks.create({
      goal: 'Ship the unknown fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoSelector: 'acme/unknown',
    });

    const profiles = new RegisteredRepositoryProfiles({ repositories, tasks });
    await expect(profiles.resolve('acme/unknown')).rejects.toThrow(
      UnknownRepositorySelectorError,
    );
    await expect(profiles.resolveAndBind(task.id)).rejects.toThrow(
      UnknownRepositorySelectorError,
    );

    const count = db.prepare('SELECT COUNT(*) AS count FROM repo_locks').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(existsSync(join(root, 'locks'))).toBe(false);
    expect(tasks.get(task.id)?.repoId).toBeNull();
    expect(tasks.get(task.id)?.status).toBe('QUEUED');
  });

  it('builds CI context from the persisted repository pull request and confirmed commit', async () => {
    const { root, repositories, tasks, pullRequests, gitCommits } = setup();
    seedRepository(repositories, root);
    const task = tasks.create({
      goal: 'Ship the web fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: REPO_ID,
    });
    const pr = pullRequests.upsertForTask({
      taskId: task.id,
      repoId: REPO_ID,
      number: PR_NUMBER,
      url: 'https://example.com/acme/web/pull/42',
      headBranch: BRANCH,
      baseBranch: 'main',
      state: 'open',
    });
    const commitId = gitCommits.recordCommit({
      taskId: task.id,
      repoId: REPO_ID,
      sha: SHA,
      branch: BRANCH,
    });
    gitCommits.markRemoteConfirmed(commitId);

    const resolver = new PersistentCiContextResolver({
      tasks,
      repositories,
      pullRequests,
      gitCommits,
    });
    await expect(resolver.resolve(task.id)).resolves.toEqual({
      taskId: task.id,
      pullRequestId: pr.id,
      owner: 'acme',
      name: 'web',
      number: PR_NUMBER,
      headSha: SHA,
      baseBranch: 'main',
    });
  });

  it('fails closed when persisted CI context is incomplete or unconfirmed', async () => {
    const unconfirmed = setup();
    seedRepository(unconfirmed.repositories, unconfirmed.root);
    const unconfirmedTask = unconfirmed.tasks.create({
      goal: 'Ship the web fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: REPO_ID,
    });
    unconfirmed.pullRequests.upsertForTask({
      taskId: unconfirmedTask.id,
      repoId: REPO_ID,
      number: PR_NUMBER,
      url: 'https://example.com/acme/web/pull/42',
      headBranch: BRANCH,
      baseBranch: 'main',
      state: 'open',
    });
    unconfirmed.gitCommits.recordCommit({
      taskId: unconfirmedTask.id,
      repoId: REPO_ID,
      sha: SHA,
      branch: BRANCH,
    });
    const unconfirmedResolver = new PersistentCiContextResolver({
      tasks: unconfirmed.tasks,
      repositories: unconfirmed.repositories,
      pullRequests: unconfirmed.pullRequests,
      gitCommits: unconfirmed.gitCommits,
    });
    await expect(unconfirmedResolver.resolve(unconfirmedTask.id)).rejects.toThrow(
      PersistentCiContextError,
    );

    const missingPr = setup();
    seedRepository(missingPr.repositories, missingPr.root);
    const missingPrTask = missingPr.tasks.create({
      goal: 'Ship the web fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: REPO_ID,
    });
    const missingPrCommitId = missingPr.gitCommits.recordCommit({
      taskId: missingPrTask.id,
      repoId: REPO_ID,
      sha: SHA,
      branch: BRANCH,
    });
    missingPr.gitCommits.markRemoteConfirmed(missingPrCommitId);
    const missingPrResolver = new PersistentCiContextResolver({
      tasks: missingPr.tasks,
      repositories: missingPr.repositories,
      pullRequests: missingPr.pullRequests,
      gitCommits: missingPr.gitCommits,
    });
    await expect(missingPrResolver.resolve(missingPrTask.id)).rejects.toThrow(
      PersistentCiContextError,
    );
  });
});
