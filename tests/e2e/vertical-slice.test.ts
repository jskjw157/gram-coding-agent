import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CommitService,
  RemoteService,
  type GitCommandRunnerPort,
} from '@gram/git';
import {
  GitHubChecksClient,
  GitHubClient,
  PullRequestMetadataBuilder,
  PullRequestService,
  type GitHubFetch,
} from '@gram/github';
import {
  AuditRepository,
  CiRunRepository,
  CommandRunRepository,
  GitCommitRepository,
  LockRepository,
  openDatabase,
  PullRequestEvidenceRepository,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  VerificationRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import { PublishingService } from '@gram/publishing';
import { RepoLockService } from '@gram/repo-lock';
import type { SecretProvider } from '@gram/secrets';
import { TaskService } from '@gram/task-engine';
import { CompletionEvaluator } from '@gram/verification';
import { WorktreeService } from '@gram/workspace';
import {
  PersistentCiContextResolver,
  RegisteredRepositoryProfiles,
} from '../../apps/agent/src/persistence-adapters.js';
import { createTaskRunner } from '../../apps/agent/src/task-runner-composition.js';
import { TaskScheduler } from '../../apps/agent/src/task-scheduler.js';
import {
  createFakeGitHubServer,
  type FakeGitHubServer,
} from './fakes/fake-github-server.js';
import {
  createTestRepository,
  type TestRepositoryFixture,
} from './fixtures/create-test-repo.js';

const REPO_ID = 730001;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

class LocalGitRunner implements GitCommandRunnerPort {
  async run(request: Parameters<GitCommandRunnerPort['run']>[0]) {
    if (!('executable' in request) || request.executable !== 'git') {
      throw new Error('E2E Git runner accepts git executable requests only');
    }
    const result = spawnSync('git', [...(request.args ?? [])], {
      cwd: request.cwd,
      encoding: 'utf8',
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
}

function testSecrets(): SecretProvider {
  return {
    getForUse: async () => ({
      withValue: <T>(use: (value: string) => T): T => use('e2e-github-token'),
      dispose: () => undefined,
    }),
  };
}

function nativeGitHubFetch(
  lockRepository: LockRepository,
  events: string[],
): GitHubFetch {
  return async (url, init) => {
    const parsed = new URL(url);
    const isPrRequest = parsed.pathname.endsWith('/pulls');
    const isCiRequest =
      parsed.pathname.includes('/protection/required_status_checks') ||
      parsed.pathname.includes('/check-runs');

    if (isPrRequest || isCiRequest) {
      expect(
        lockRepository.get(REPO_ID),
        'PR/CI provider calls must be lock-free',
      ).toBeUndefined();
    }
    if (isPrRequest && init.method === 'POST') events.push('pr.create');
    if (isCiRequest && !events.includes('ci.observe')) events.push('ci.observe');

    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return response;
  };
}

async function waitForTerminalTask(
  tasks: TaskRepository,
  taskId: string,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = tasks.get(taskId);
    if (task?.status === 'COMPLETED') return;
    if (task?.status === 'FAILED' || task?.status === 'NEEDS_RECOVERY') {
      throw new Error(`task ended in ${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task did not complete within ${timeoutMs}ms`);
}

describe('M2 deterministic vertical slice', () => {
  it('proves task_create through remote-confirmed publish, lock-free PR/CI, and COMPLETED', async () => {
    let fixture: TestRepositoryFixture | undefined;
    let github: FakeGitHubServer | undefined;
    let database: ReturnType<typeof openDatabase> | undefined;
    let scheduler: TaskScheduler | undefined;

    try {
      fixture = createTestRepository();
      github = await createFakeGitHubServer();

      database = openDatabase(join(fixture.rootPath, 'agent.sqlite'));
      runMigrations(database);

      const tasks = new TaskRepository(database);
      const audit = new AuditRepository(database);
      const repositories = new RepositoryRepository(database);
      const locks = new LockRepository(database);
      const workspaces = new WorkspaceRepository(database);
      const verificationRepository = new VerificationRepository(database);
      const commandRuns = new CommandRunRepository(database);
      const commits = new GitCommitRepository(database);
      const pullRequests = new PullRequestRepository(database);
      const ciRuns = new CiRunRepository(database);

      repositories.upsert({
        githubRepositoryId: REPO_ID,
        owner: 'acme',
        name: 'demo',
        defaultBranch: 'main',
        localBasePath: fixture.canonicalPath,
        projectType: 'typescript',
        language: 'typescript',
        packageManager: 'pnpm',
        commands: {
          lint: 'tsc --noEmit',
          test: 'node --test test/*.test.js',
          build: 'tsc',
        },
      });

      const taskService = new TaskService(tasks, audit);
      const created = await taskService.create({
        repo: 'acme/demo',
        goal: 'Fix increment so the existing target test passes',
        publishMode: 'PULL_REQUEST',
      });

      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(created.displayId).toBe('TASK-000001');
      expect(created.status).toBe('QUEUED');

      const events: string[] = [];
      const lockService = new RepoLockService({
        locks,
        tasks,
        lockDirectory: join(fixture.rootPath, 'locks'),
        bootId: () => 'e2e-boot',
        scheduler: {
          setInterval: () => Symbol('heartbeat'),
          clearInterval: () => undefined,
        },
      });
      const trackedLocks = {
        acquire: async (repoId: number, taskId: string) => {
          const lease = await lockService.acquire(repoId, taskId);
          expect(locks.get(repoId)?.ownerTaskId).toBe(taskId);
          events.push('lock.acquire');
          return {
            release: async () => {
              await lease.release();
              events.push('lock.release');
            },
          };
        },
      };

      const worktreeService = new WorktreeService({
        homeDir: join(fixture.rootPath, 'agent-home'),
        git: {
          createWorktree: async (input) => {
            git(input.repoPath, [
              'worktree',
              'add',
              '-b',
              input.branch,
              input.worktreePath,
              input.baseRef,
            ]);
            return { headSha: git(input.worktreePath, ['rev-parse', 'HEAD']) };
          },
          removeWorktree: async (input) => {
            git(input.repoPath, ['worktree', 'remove', '--force', input.worktreePath]);
          },
          pruneWorktrees: async (input) => {
            git(input.repoPath, ['worktree', 'prune']);
          },
        },
        workspaces,
        pathMapper: {
          toWindows: async (linuxPath) => `\\\\wsl.test\\Ubuntu${linuxPath.replaceAll('/', '\\\\')}`,
        },
      });

      const gitPort = {
        fetch: async (repoPath: string) => {
          git(repoPath, ['fetch', '--prune', 'origin']);
        },
        status: async (worktree: string) => {
          const output = execFileSync(
            'git',
            ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
            { cwd: worktree, encoding: 'utf8' },
          );
          return {
            entries: output
              .split('\0')
              .filter(Boolean)
              .map((entry) => ({ path: entry.slice(3) })),
          };
        },
        headSha: async (worktree: string) => git(worktree, ['rev-parse', 'HEAD']),
      };

      const evaluator = new CompletionEvaluator(verificationRepository);
      const verifiedTasks = new Set<string>();
      const verification = {
        requiredChecksPassed: async (taskId: string, headSha?: string) => {
          if (!verifiedTasks.has(taskId)) {
            expect(locks.get(REPO_ID)?.ownerTaskId).toBe(taskId);
            const workspace = workspaces.getByTaskId(taskId);
            if (workspace === undefined) throw new Error('missing E2E workspace');
            if (headSha === undefined) throw new Error('verification must be HEAD-bound');

            execFileSync('node', ['--test', 'test/counter.test.js'], {
              cwd: workspace.linuxPath,
              encoding: 'utf8',
              stdio: 'pipe',
            });

            const planId = verificationRepository.createPlan({
              taskId,
              headSha,
              changeClass: 'BACKEND',
              risk: 'LOW',
              plan: {
                required: ['target-test', 'diff-review'],
                approvedPaths: ['src/counter.ts'],
              },
            });
            const testCheck = verificationRepository.createCheck({
              planId,
              taskId,
              name: 'target-test',
              required: true,
            });
            verificationRepository.finishCheck(testCheck, {
              status: 'PASS',
              evidenceRef: 'e2e:node-test:counter',
            });
            const diffCheck = verificationRepository.createCheck({
              planId,
              taskId,
              name: 'diff-review',
              required: true,
            });
            verificationRepository.finishCheck(diffCheck, {
              status: 'PASS',
              evidenceRef: 'diff-review:src/counter.ts',
            });
            verifiedTasks.add(taskId);
          }
          return evaluator.requiredChecksPassed(taskId);
        },
        listApprovedPaths: async () => ['src/counter.ts'],
      };

      const gitRunner = new LocalGitRunner();
      const publishing = {
        publish: async (context: {
          taskId: string;
          repoId: number;
          worktree: string;
          branch: string;
          paths: readonly string[];
          commitMessage: string;
          remote: string;
          lock: { release(): Promise<void> };
        }) => {
          const remote = new RemoteService(
            gitRunner,
            { taskId: context.taskId },
            context.worktree,
          );
          const service = new PublishingService({
            verification: {
              assertPassed: (taskId) => {
                if (!evaluator.requiredChecksPassed(taskId)) {
                  throw new Error('E2E verification is not complete');
                }
              },
            },
            commits: new CommitService(gitRunner, { taskId: context.taskId }),
            remote: {
              push: (worktree, branch) => remote.push(worktree, branch),
              confirmRemoteSha: async (remoteName, branch, expectedSha) => {
                expect(locks.get(REPO_ID)?.ownerTaskId).toBe(context.taskId);
                const confirmed = await remote.confirmRemoteSha(
                  remoteName,
                  branch,
                  expectedSha,
                );
                if (confirmed) {
                  expect(locks.get(REPO_ID)?.ownerTaskId).toBe(context.taskId);
                  events.push('remote.confirm');
                }
                return confirmed;
              },
            },
            persistence: commits,
            audit,
          });
          const published = await service.publish(context);
          return {
            sha: published.sha,
            branch: published.branch,
            remote: published.remote,
          };
        },
      };

      const fetchForGitHub = nativeGitHubFetch(locks, events);
      const secrets = testSecrets();
      const pullRequestService = new PullRequestService({
        client: new GitHubClient({
          secrets,
          fetch: fetchForGitHub,
          apiBaseUrl: github.apiBaseUrl,
        }),
        metadata: new PullRequestMetadataBuilder(
          new PullRequestEvidenceRepository(database),
        ),
        persistence: pullRequests,
      });

      const repoProfiles = new RegisteredRepositoryProfiles({
        repositories,
        tasks,
      });
      const ciContext = new PersistentCiContextResolver({
        tasks,
        repositories,
        pullRequests,
        gitCommits: commits,
      });
      const checksClient = new GitHubChecksClient({
        secrets,
        fetch: fetchForGitHub,
        apiBaseUrl: github.apiBaseUrl,
      });

      const runner = createTaskRunner({
        audit,
        tasks,
        repos: repoProfiles,
        locks: trackedLocks,
        git: gitPort,
        worktrees: worktreeService,
        verification,
        publishing,
        pullRequests: pullRequestService,
        checks: {
          client: checksClient,
          persistence: ciRuns,
          delay: { wait: async () => undefined },
          maxAttempts: 2,
          pollIntervalMs: 0,
        },
        ciContext,
        workspaces,
        capabilities: {
          instructions: {
            load: async () => ({
              content: 'Modify only src/counter.ts and preserve the existing test.',
              source: 'deterministic-e2e',
            }),
          },
          analyze: {
            analyze: async () => ({
              summary: 'increment must add one',
              files: ['src/counter.ts'],
            }),
          },
          modify: {
            modify: async ({ task, workspace }) => {
              expect(locks.get(REPO_ID)?.ownerTaskId).toBe(task.taskId);
              writeFileSync(
                join(workspace.linuxPath, 'src', 'counter.ts'),
                [
                  'export function increment(value: number): number {',
                  '  return value + 1;',
                  '}',
                  '',
                ].join('\n'),
                'utf8',
              );
              return { sha: git(workspace.linuxPath, ['rev-parse', 'HEAD']) };
            },
          },
        },
      });

      scheduler = new TaskScheduler({
        tasks,
        runner,
        audit,
        logger: { error: () => undefined },
        interval: {
          setInterval: () => Symbol('scheduler'),
          clearInterval: () => undefined,
        },
        intervalMs: 60_000,
      });

      scheduler.start();
      await waitForTerminalTask(tasks, created.id);
      await scheduler.stop();

      const storedTask = tasks.get(created.id);
      expect(storedTask?.status).toBe('COMPLETED');
      expect(storedTask?.repoId).toBe(REPO_ID);

      const workspace = workspaces.getByTaskId(created.id);
      expect(workspace).toBeDefined();
      expect(workspace?.linuxPath).not.toBe(fixture.canonicalPath);
      expect(workspace?.linuxPath).toContain(
        join('.gram-agent', 'worktrees', String(REPO_ID), created.id),
      );

      expect(
        readFileSync(join(fixture.canonicalPath, 'src', 'counter.ts'), 'utf8'),
      ).toContain('return value;');
      expect(
        readFileSync(join(workspace!.linuxPath, 'src', 'counter.ts'), 'utf8'),
      ).toContain('return value + 1;');
      expect(git(fixture.canonicalPath, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.canonicalPath, ['rev-parse', 'HEAD'])).toBe(
        fixture.initialSha,
      );

      const checks = verificationRepository.listForTask(created.id);
      expect(checks).toHaveLength(2);
      expect(
        checks.every(
          (check) =>
            check.required &&
            check.status === 'PASS' &&
            check.hasEvidence,
        ),
      ).toBe(true);

      const published = commits.getLatestForTask(created.id);
      expect(published?.remoteConfirmed).toBe(true);
      expect(published?.sha).toMatch(/^[0-9a-f]{40}$/u);
      const remoteLine = git(fixture.canonicalPath, [
        'ls-remote',
        'origin',
        `refs/heads/${published!.branch}`,
      ]);
      expect(remoteLine.split(/\s+/u)[0]).toBe(published?.sha);

      expect(locks.get(REPO_ID)).toBeUndefined();

      const pr = pullRequests.getLatestForTask(created.id);
      expect(pr).toMatchObject({
        repoId: REPO_ID,
        headBranch: published?.branch,
        baseBranch: 'main',
        state: 'open',
      });
      expect(github.pullRequests).toHaveLength(1);

      const observedCi = ciRuns.listForTask(created.id);
      expect(observedCi).toHaveLength(1);
      expect(observedCi[0]).toMatchObject({
        providerCheckId: '2001',
        checkName: 'verify',
        status: 'completed',
        conclusion: 'success',
      });
      expect(github.checkPollCount).toBe(2);

      expect(events.indexOf('lock.acquire')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('remote.confirm')).toBeGreaterThan(
        events.indexOf('lock.acquire'),
      );
      expect(events.indexOf('lock.release')).toBeGreaterThan(
        events.indexOf('remote.confirm'),
      );
      expect(events.indexOf('pr.create')).toBeGreaterThan(
        events.indexOf('lock.release'),
      );
      expect(events.indexOf('ci.observe')).toBeGreaterThan(
        events.indexOf('pr.create'),
      );

      const auditRows = database
        .prepare(
          `SELECT event_type AS eventType, created_at AS createdAt
           FROM audit_events
           WHERE task_id = ?
             AND event_type IN ('REMOTE_PUSH_CONFIRMED', 'REPO_LOCK_RELEASED')
           ORDER BY id`,
        )
        .all(created.id) as Array<{ eventType: string; createdAt: string }>;

      expect(auditRows.map((row) => row.eventType)).toEqual([
        'REMOTE_PUSH_CONFIRMED',
        'REPO_LOCK_RELEASED',
      ]);
      expect(
        Date.parse(auditRows[0]!.createdAt),
      ).toBeLessThanOrEqual(Date.parse(auditRows[1]!.createdAt));

      expect(commandRuns).toBeDefined();
    } finally {
      if (scheduler !== undefined) await scheduler.stop();
      if (database !== undefined && database.open) database.close();
      if (github !== undefined) await github.close();
      fixture?.cleanup();
    }
  });
});
