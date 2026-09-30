import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer, type VerificationReviewIdentity } from '@gram/mcp';
import { CommitService, RemoteService } from '@gram/git';
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
  VerificationReviewRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { PublishingService } from '@gram/publishing';
import { RepoLockService } from '@gram/repo-lock';
import { SecretRedactor, type SecretProvider } from '@gram/secrets';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';
import { TaskService } from '@gram/task-engine';
import { WorktreeService } from '@gram/workspace';
import { PolicyGitAdapter, PolicyWorktreeAdapter } from '../../apps/agent/src/command-adapters.js';
import {
  PersistentCiContextResolver,
  RegisteredRepositoryProfiles,
} from '../../apps/agent/src/persistence-adapters.js';
import { createTaskRunner } from '../../apps/agent/src/task-runner-composition.js';
import { TaskScheduler } from '../../apps/agent/src/task-scheduler.js';
import { TaskVerificationSnapshots } from '../../apps/agent/src/verification-snapshot.js';
import {
  ExternalVerificationReview,
  type PendingVerificationReview,
} from '../../apps/agent/src/external-verification-review.js';
import { VerificationCoordinator } from '../../apps/agent/src/verification-coordinator.js';
import { createVerificationReviewCommandRunner } from '../../apps/agent/src/verification-review-command.js';
import { VerificationReviewSource, type ReviewFileView } from '../../apps/agent/src/verification-review-source.js';
import { BoundPublishingVerification } from '../../apps/agent/src/verified-publishing.js';
import { createFakeGitHubServer, type FakeGitHubServer } from './fakes/fake-github-server.js';
import {
  createTestRepository,
  NODE_ONLY_VERIFICATION_COMMANDS,
  type TestRepositoryFixture,
} from './fixtures/create-test-repo.js';

const REPO_ID = 730001;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function testSecrets(): SecretProvider {
  return {
    getForUse: async () => ({
      withValue: <T>(use: (value: string) => T): T => use('e2e-github-token'),
      dispose: () => undefined,
    }),
  };
}

function nativeGitHubFetch(lockRepository: LockRepository, events: string[]): GitHubFetch {
  return async (url, init) => {
    const parsed = new URL(url);
    const isPrRequest = parsed.pathname.endsWith('/pulls');
    const isCiRequest =
      parsed.pathname.includes('/protection/required_status_checks') || parsed.pathname.includes('/check-runs');

    if (isPrRequest || isCiRequest) {
      expect(lockRepository.get(REPO_ID), 'PR/CI provider calls must be lock-free').toBeUndefined();
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

async function waitForTerminalTask(tasks: TaskRepository, taskId: string, timeoutMs = 8_000): Promise<void> {
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

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected fixture result was missing');
  return value;
}

const REVIEW_AUTH = 'fixture-only-loopback-review-auth';
interface ToolResponse {
  result?: { isError?: boolean; content: { type: string; text: string }[] };
  error?: { message: string };
}

/** Deterministic external controller; all reviewed bytes come from authenticated production tools. */
class FixtureReviewController {
  private id = 0;
  constructor(private readonly url: string) {}
  request(name: string, args: unknown, auth: string | null = REVIEW_AUTH): Promise<Response> {
    return fetch(`${this.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth === null ? {} : { 'x-gram-agent-auth': auth }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } }),
    });
  }
  private async result(name: string, args: unknown): Promise<ToolResponse> {
    const response = await this.request(name, args);
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = text.startsWith('event:')
      ? required(text.split('\n').find((line) => line.startsWith('data:')))
          .slice(5)
          .trim()
      : text;
    return JSON.parse(data) as ToolResponse;
  }
  async call<T = unknown>(name: string, args: unknown): Promise<T> {
    const response = await this.result(name, args);
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
    return JSON.parse(required(required(response.result).content[0]).text) as T;
  }
  async rejected(name: string, args: unknown): Promise<string> {
    const response = await this.result(name, args);
    expect(response.result?.isError === true || response.error !== undefined).toBe(true);
    return JSON.stringify(response);
  }
}
function reviewIdentity(review: PendingVerificationReview): VerificationReviewIdentity {
  const { taskId, reviewId, workspaceId, planId, checkId, headSha, snapshotDigest } = review;
  return { taskId, reviewId, workspaceId, planId, checkId, headSha, snapshotDigest };
}
async function waitForReview(
  controller: FixtureReviewController,
  tasks: TaskRepository,
  taskId: string,
): Promise<PendingVerificationReview> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pending = await controller.call<PendingVerificationReview | null>('verification_review_get', { taskId });
    if (pending !== null) return pending;
    expect(tasks.get(taskId)?.status, 'task failed before authenticated review became available').not.toMatch(
      /FAILED|NEEDS_RECOVERY/,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No authenticated verification review became available');
}

describe('production verification with an authenticated fixture reviewer', () => {
  it('requires fresh declared commands and exact external reviews before remote-confirmed publication', async () => {
    let fixture: TestRepositoryFixture | undefined;
    let github: FakeGitHubServer | undefined;
    let database: ReturnType<typeof openDatabase> | undefined;
    let scheduler: TaskScheduler | undefined;
    let mcp: RunningMcpServer | undefined;
    let reviews: ExternalVerificationReview | undefined;

    try {
      fixture = createTestRepository(NODE_ONLY_VERIFICATION_COMMANDS);
      github = await createFakeGitHubServer();

      database = openDatabase(join(fixture.rootPath, 'agent.sqlite'));
      runMigrations(database);

      const tasks = new TaskRepository(database);
      const audit = new AuditRepository(database);
      const repositories = new RepositoryRepository(database);
      const locks = new LockRepository(database);
      const workspaces = new WorkspaceRepository(database);
      const verificationRepository = new VerificationRepository(database);
      const reviewRepository = new VerificationReviewRepository(database);
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
        commands: NODE_ONLY_VERIFICATION_COMMANDS,
      });

      const taskService = new TaskService(tasks, audit);
      const created = await taskService.create({
        repo: 'acme/demo',
        goal: 'Fix increment so the existing target test passes',
        publishMode: 'PULL_REQUEST',
      });

      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
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
      const ownedLeases = new Map<string, string>();
      const trackedLocks = {
        acquire: async (repoId: number, taskId: string) => {
          const lease = await lockService.acquire(repoId, taskId);
          expect(locks.get(repoId)?.ownerTaskId).toBe(taskId);
          events.push('lock.acquire');
          ownedLeases.set(taskId, lease.leaseToken);
          return {
            release: async () => {
              await lease.release();
              ownedLeases.delete(taskId);
              events.push('lock.release');
            },
          };
        },
      };

      const agentHome = join(fixture.rootPath, 'agent-home');
      const commandRunner = new CommandRunner({
        policy: new PolicyEngine(),
        approvals: { consume: async () => false },
        spawner: new NodeProcessSpawner(),
        commandRuns,
        outputCapture: new OutputCapture({
          homeDir: agentHome,
          redactor: new SecretRedactor(),
        }),
        homeDir: agentHome,
      });
      const policyGit = new PolicyGitAdapter({ runner: commandRunner });

      const worktreeService = new WorktreeService({
        homeDir: agentHome,
        git: new PolicyWorktreeAdapter({ runner: commandRunner }),
        workspaces,
        pathMapper: {
          toWindows: async (linuxPath) => `\\\\wsl.test\\Ubuntu${linuxPath.replaceAll('/', '\\\\')}`,
        },
      });

      const gitPort = policyGit;
      const snapshots = new TaskVerificationSnapshots({ runner: commandRunner, workspaces });
      const reviewRedactor = new SecretRedactor();
      reviews = new ExternalVerificationReview({
        tasks,
        workspaces,
        locks,
        reviews: reviewRepository,
        verification: verificationRepository,
        ownsLease: (taskId, leaseToken) => ownedLeases.get(taskId) === leaseToken,
        snapshots,
        source: new VerificationReviewSource({
          runner: createVerificationReviewCommandRunner({
            policy: new PolicyEngine(),
            approvals: { consume: async () => false },
            commandRuns,
            homeDir: agentHome,
            redactor: reviewRedactor,
          }),
          workspaces,
          redactor: reviewRedactor,
        }),
        timeoutMs: 10_000,
      });
      mcp = await createMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        internalSecret: REVIEW_AUTH,
        verificationReviews: reviews,
      });
      const controller = new FixtureReviewController(mcp.url);
      const verification = new VerificationCoordinator({
        tasks,
        repositories,
        verification: verificationRepository,
        snapshots,
        commands: commandRunner,
        reviews,
      });

      const acceptedReviews: PendingVerificationReview[] = [];
      const acknowledgedViews = new Map<string, ReviewFileView>();
      const publishing = {
        publish: async (context: {
          taskId: string;
          repoId: number;
          worktree: string;
          branch: string;
          paths: readonly string[];
          verification?: { planId: number; headSha: string };
          commitMessage: string;
          remote: string;
          lock: { release(): Promise<void> };
        }) => {
          events.push('publish.begin');
          expect(reviewRepository.get(required(acceptedReviews[0]).reviewId)?.state).toBe('ACCEPTED');
          expect(reviewRepository.get(required(acceptedReviews[1]).reviewId)?.state).toBe('ACCEPTED');
          if (context.verification === undefined) throw new Error('missing bound evidence');
          const remote = new RemoteService(commandRunner, { taskId: context.taskId }, context.worktree);
          const service = new PublishingService({
            verification: new BoundPublishingVerification({
              taskId: context.taskId,
              planId: context.verification.planId,
              headSha: context.verification.headSha,
              paths: context.paths,
              repository: verificationRepository,
              snapshots,
            }),
            commits: new CommitService(commandRunner, { taskId: context.taskId }),
            remote: {
              push: (worktree, branch, expectedSha) => remote.push(worktree, branch, expectedSha),
              confirmRemoteSha: async (remoteName, branch, expectedSha) => {
                expect(locks.get(REPO_ID)?.ownerTaskId).toBe(context.taskId);
                const confirmed = await remote.confirmRemoteSha(remoteName, branch, expectedSha);
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
        metadata: new PullRequestMetadataBuilder(new PullRequestEvidenceRepository(database)),
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
                ['export function increment(value: number): number {', '  return value + 1;', '}', ''].join('\n'),
                'utf8',
              );
              const headSha = await policyGit.headSha(workspace.linuxPath, task.taskId);
              // Coding is deterministic fixture behavior. Verification must start later,
              // after the production task transition into VERIFYING.
              expect(tasks.get(task.taskId)?.status).toBe('RUNNING');
              expect(verificationRepository.listForTask(task.taskId)).toEqual([]);
              return { sha: headSha };
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
      for (const checkName of ['secret-scan', 'diff-review'] as const) {
        const pending = await waitForReview(controller, tasks, created.id);
        expect(pending.checkName).toBe(checkName);
        expect(pending.paths).toEqual(['src/counter.ts']);
        expect(pending.headSha).toBe(fixture.initialSha);
        expect(tasks.get(created.id)?.status).toBe('VERIFYING');
        expect(verificationRepository.getBoundPlan(created.id, fixture.initialSha)).toBeUndefined();
        expect(commits.getLatestForTask(created.id)).toBeUndefined();
        expect(github.pullRequests).toHaveLength(0);
        expect(github.checkPollCount).toBe(0);
        expect(events).toEqual(['lock.acquire']);
        expect(locks.get(REPO_ID)?.leaseToken).toBe(ownedLeases.get(created.id));
        const workspace = required(workspaces.getByTaskId(created.id));
        expect(git(workspace.linuxPath, ['rev-parse', 'HEAD'])).toBe(fixture.initialSha);
        expect(git(fixture.canonicalPath, ['ls-remote', 'origin', `refs/heads/${workspace.branch}`])).toBe('');

        const identity = reviewIdentity(pending);
        const submission = {
          ...identity,
          status: 'PASS',
          acknowledgements: [],
          approvedPaths: checkName === 'diff-review' ? ['src/counter.ts'] : [],
        };
        // HTTP authentication and the single-review read requirement are enforced
        // before either controller decision can become publishable evidence.
        for (const auth of [null, 'incorrect-fixture-auth']) {
          const response = await controller.request(
            'verification_review_read',
            { ...identity, path: 'src/counter.ts' },
            auth,
          );
          expect(response.status).toBe(401);
          expect(await response.text()).not.toContain('return value');
        }
        expect(await controller.rejected('verification_review_submit', submission)).toMatch(/read and acknowledged/);
        expect(
          await controller.rejected('verification_review_read', {
            ...identity,
            planId: pending.planId + 1,
            path: 'src/counter.ts',
          }),
        ).toMatch(/mismatched/);

        const file = await controller.call<ReviewFileView>('verification_review_read', {
          ...identity,
          path: 'src/counter.ts',
        });
        expect(file.path).toBe('src/counter.ts');
        expect(file.before).toEqual({
          present: true,
          mode: '100644',
          oid: git(workspace.linuxPath, ['rev-parse', `${fixture.initialSha}:src/counter.ts`]),
          content: readFileSync(join(fixture.canonicalPath, 'src/counter.ts'), 'utf8'),
        });
        expect(file.after).toEqual({
          present: true,
          mode: '100644',
          oid: git(workspace.linuxPath, ['hash-object', '--no-filters', '--', 'src/counter.ts']),
          content: readFileSync(join(workspace.linuxPath, 'src/counter.ts'), 'utf8'),
        });
        expect(file.before.content).toContain('return value;');
        expect(file.after.content).toContain('return value + 1;');
        expect(file.digest).toMatch(/^[a-f0-9]{64}$/u);
        const prior = acceptedReviews[0];
        if (prior !== undefined) {
          const oldView = required(acknowledgedViews.get(prior.reviewId));
          expect(file.digest).not.toBe(oldView.digest);
          expect(
            await controller.rejected('verification_review_submit', {
              ...submission,
              acknowledgements: [{ path: file.path, digest: oldView.digest }],
            }),
          ).toMatch(/read and acknowledged/);
          expect(pending.planId).toBe(prior.planId);
          expect(pending.snapshotDigest).toBe(prior.snapshotDigest);
        }
        const acceptedSubmission = { ...submission, acknowledgements: [{ path: file.path, digest: file.digest }] };
        expect(
          await controller.rejected('verification_review_submit', {
            ...acceptedSubmission,
            evidenceRef: 'forged-controller-proof',
          }),
        ).toMatch(/evidenceRef|Unrecognized/);
        acknowledgedViews.set(pending.reviewId, file);
        acceptedReviews.push(pending);
        expect(await controller.call('verification_review_submit', acceptedSubmission)).toEqual({ accepted: true });
        expect(await controller.rejected('verification_review_submit', acceptedSubmission)).toMatch(/Unknown/);
      }
      await waitForTerminalTask(tasks, created.id);
      await scheduler.stop();

      const storedTask = tasks.get(created.id);
      expect(storedTask?.status).toBe('COMPLETED');
      expect(storedTask?.repoId).toBe(REPO_ID);

      const workspace = required(workspaces.getByTaskId(created.id));
      expect(workspace).toBeDefined();
      expect(workspace?.linuxPath).not.toBe(fixture.canonicalPath);
      expect(workspace?.linuxPath).toContain(join('.gram-agent', 'worktrees', String(REPO_ID), created.id));

      expect(readFileSync(join(fixture.canonicalPath, 'src', 'counter.ts'), 'utf8')).toContain('return value;');
      expect(readFileSync(join(workspace.linuxPath, 'src', 'counter.ts'), 'utf8')).toContain('return value + 1;');
      expect(git(fixture.canonicalPath, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.canonicalPath, ['rev-parse', 'HEAD'])).toBe(fixture.initialSha);

      const checks = verificationRepository.listForTask(created.id);
      expect(checks.map((check) => check.name)).toEqual(['lint', 'test', 'build', 'secret-scan', 'diff-review']);
      expect(checks.every((check) => check.required && check.status === 'PASS' && check.hasEvidence)).toBe(true);

      const sealedPlan = required(verificationRepository.getBoundPlan(created.id, fixture.initialSha));
      expect(sealedPlan?.approvedPaths).toEqual(['src/counter.ts']);
      expect(sealedPlan?.snapshot.entries.map((entry) => entry.path)).toEqual(['src/counter.ts']);
      expect(sealedPlan?.id).toBe(required(acceptedReviews[0]).planId);
      expect(sealedPlan?.snapshot.entries[0]?.oid).toBe(
        required(acknowledgedViews.get(required(acceptedReviews[0]).reviewId)).after.oid,
      );
      for (const pending of acceptedReviews) {
        const record = reviewRepository.get(pending.reviewId);
        expect(record).toMatchObject({
          taskId: created.id,
          workspaceId: workspace.id,
          workspacePath: workspace.linuxPath,
          branch: workspace.branch,
          planId: sealedPlan.id,
          checkId: pending.checkId,
          checkName: pending.checkName,
          headSha: fixture.initialSha,
          state: 'ACCEPTED',
          decision: 'PASS',
          snapshotDigest: createHash('sha256').update(JSON.stringify(sealedPlan.snapshot)).digest('hex'),
          views: [{ path: 'src/counter.ts', digest: required(acknowledgedViews.get(pending.reviewId)).digest }],
          approvedPaths: pending.checkName === 'diff-review' ? ['src/counter.ts'] : [],
        });
        expect(sealedPlan?.checks.find((check) => check.id === pending.checkId)?.evidenceRef).toBe(
          `external-review:${pending.reviewId}`,
        );
      }
      expect(
        new Set(acceptedReviews.map((pending) => required(reviewRepository.get(pending.reviewId)).runId)).size,
      ).toBe(1);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM verification_plans WHERE task_id = ?').get(created.id),
      ).toEqual({ count: 1 });

      const published = required(commits.getLatestForTask(created.id));
      expect(published?.remoteConfirmed).toBe(true);
      expect(published?.sha).toMatch(/^[0-9a-f]{40}$/u);
      const remoteLine = git(fixture.canonicalPath, ['ls-remote', 'origin', `refs/heads/${published.branch}`]);
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
      expect(events.indexOf('publish.begin')).toBeGreaterThan(events.indexOf('lock.acquire'));
      expect(events.indexOf('remote.confirm')).toBeGreaterThan(events.indexOf('publish.begin'));
      expect(events.indexOf('lock.release')).toBeGreaterThan(events.indexOf('remote.confirm'));
      expect(events.indexOf('pr.create')).toBeGreaterThan(events.indexOf('lock.release'));
      expect(events.indexOf('ci.observe')).toBeGreaterThan(events.indexOf('pr.create'));

      const auditRows = database
        .prepare(
          `SELECT event_type AS eventType, created_at AS createdAt
           FROM audit_events
           WHERE task_id = ?
             AND event_type IN ('REMOTE_PUSH_CONFIRMED', 'REPO_LOCK_RELEASED')
           ORDER BY id`,
        )
        .all(created.id) as Array<{ eventType: string; createdAt: string }>;

      expect(auditRows.map((row) => row.eventType)).toEqual(['REMOTE_PUSH_CONFIRMED', 'REPO_LOCK_RELEASED']);
      expect(Date.parse(required(auditRows[0]).createdAt)).toBeLessThanOrEqual(
        Date.parse(required(auditRows[1]).createdAt),
      );

      const persistedCommands = database
        .prepare(
          `SELECT executable, args_json AS argsJson, status
           FROM command_runs
           WHERE task_id = ?
           ORDER BY id`,
        )
        .all(created.id) as Array<{
        executable: string | null;
        argsJson: string | null;
        status: string;
      }>;
      expect(persistedCommands.length).toBeGreaterThan(5);
      expect(persistedCommands.every((run) => run.status === 'SUCCEEDED')).toBe(true);
      const gitArgs = persistedCommands
        .filter((run) => run.executable === 'git' && run.argsJson !== null)
        .map((run) => JSON.parse(required(run.argsJson)) as string[]);
      expect(gitArgs.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(true);
      expect(
        gitArgs.some((args) => args[0] === 'push' && args[2] === `${published?.sha}:refs/heads/${published?.branch}`),
      ).toBe(true);
      expect(gitArgs.some((args) => args[0] === 'ls-remote')).toBe(true);

      for (const name of ['lint', 'test', 'build'] as const) {
        const check = required(checks.find((check) => check.name === name));
        expect(commandRuns.get(required(check.commandRunId))).toMatchObject({
          taskId: created.id,
          cwd: workspace.linuxPath,
          category: 'VERIFICATION',
          shellText: NODE_ONLY_VERIFICATION_COMMANDS[name],
          status: 'SUCCEEDED',
          exitCode: 0,
        });
      }
      expect(JSON.parse(readFileSync(join(workspace.linuxPath, 'package.json'), 'utf8')).scripts).toEqual(
        NODE_ONLY_VERIFICATION_COMMANDS,
      );
      const persistedPlan = database
        .prepare('SELECT plan_json AS planJson FROM verification_plans WHERE id = ?')
        .get(sealedPlan.id) as { planJson: string };
      expect(JSON.parse(persistedPlan.planJson).externalReviews).toBe(true);
      const captures = database
        .prepare(
          'SELECT executable, args_json AS argsJson, stdout_path AS stdoutPath, stderr_path AS stderrPath FROM command_runs WHERE task_id = ?',
        )
        .all(created.id) as {
        executable: string | null;
        argsJson: string | null;
        stdoutPath: string;
        stderrPath: string;
      }[];
      const beforeView = required(acknowledgedViews.get(required(acceptedReviews[0]).reviewId)).before;
      const before = required(beforeView.content);
      const objectReads = captures.filter(
        (run) => run.executable === 'git' && run.argsJson === JSON.stringify(['show', beforeView.oid]),
      );
      expect(objectReads).toHaveLength(2);
      for (const run of objectReads) {
        expect(JSON.parse(readFileSync(run.stdoutPath, 'utf8'))).toEqual({
          omitted: 'verification review source',
          bytes: Buffer.byteLength(before),
          sha256: createHash('sha256').update(before).digest('hex'),
        });
      }
      // Source is transient review output, never durable command capture or SQLite payload.
      for (const run of captures) {
        for (const path of [run.stdoutPath, run.stderrPath]) {
          expect(readFileSync(path, 'utf8')).not.toContain('export function increment');
          expect(readFileSync(path, 'utf8')).not.toContain('return value + 1;');
        }
      }
      const persistedBytes = database.serialize();
      expect(persistedBytes.includes(Buffer.from('export function increment'))).toBe(false);
      expect(persistedBytes.includes(Buffer.from('return value + 1;'))).toBe(false);
    } finally {
      reviews?.close();
      if (scheduler !== undefined) await scheduler.stop();
      if (mcp !== undefined) await mcp.close();
      if (database !== undefined && database.open) database.close();
      if (github !== undefined) await github.close();
      fixture?.cleanup();
    }
  });
});
