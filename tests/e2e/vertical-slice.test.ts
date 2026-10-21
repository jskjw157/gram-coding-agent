import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
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
  WorkspaceRepository,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { PublishingService } from '@gram/publishing';
import { RepoLockService } from '@gram/repo-lock';
import { SecretRedactor, type SecretProvider } from '@gram/secrets';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';
import { TaskService } from '@gram/task-engine';
import { CompletionEvaluator, EvidenceCollector, VerificationRunner } from '@gram/verification';
import { WorktreeService } from '@gram/workspace';
import {
  PolicyGitAdapter,
  PolicyWorktreeAdapter,
} from '../../apps/agent/src/command-adapters.js';
import {
  PersistentCiContextResolver,
  PersistentVerificationCompletion,
  RegisteredRepositoryProfiles,
} from '../../apps/agent/src/persistence-adapters.js';
import { createTaskRunner } from '../../apps/agent/src/task-runner-composition.js';
import { TaskScheduler } from '../../apps/agent/src/task-scheduler.js';
import { TaskVerificationSnapshots } from '../../apps/agent/src/verification-snapshot.js';
import { BoundPublishingVerification } from '../../apps/agent/src/verified-publishing.js';
import { createProductionGitHubServices } from '../../apps/agent/src/github-services.js';
import { SmokeLockObserver, type SmokeBoundary, type SmokeContext } from '../../apps/agent/src/smoke-lock-observer.js';
import {
  createFakeGitHubServer,
  type FakeGitHubServer,
} from './fakes/fake-github-server.js';
import {
  createTestRepository,
  type TestRepositoryFixture,
} from './fixtures/create-test-repo.js';

const REPO_ID = 730001;

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected persisted fixture evidence');
  return value;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

// The fake rejects any request whose Bearer token does not match, so the
// credential it is configured with and the one the client leases must be the
// same value. One constant keeps them from drifting apart.
const E2E_GITHUB_TOKEN = 'e2e-github-token';

function testSecrets(): SecretProvider {
  return {
    getForUse: async () => ({
      withValue: <T>(use: (value: string) => T): T => use(E2E_GITHUB_TOKEN),
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
  it.each([false, true])('proves task_create through remote-confirmed publish, lock-free PR/CI, and COMPLETED (independent observer: %s)', async (observeLocks) => {
    let fixture: TestRepositoryFixture | undefined;
    let github: FakeGitHubServer | undefined;
    let database: ReturnType<typeof openDatabase> | undefined;
    let scheduler: TaskScheduler | undefined;
    let observer: SmokeLockObserver | undefined;

    try {
      fixture = createTestRepository();
      github = await createFakeGitHubServer({ token: E2E_GITHUB_TOKEN });

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
      const evaluator = new CompletionEvaluator(verificationRepository);
      const verification = new PersistentVerificationCompletion(evaluator, verificationRepository);
      const evidence = new EvidenceCollector(verificationRepository);
      // Deterministic fixture non-command verifiers; production persistence,
      // command execution, snapshot capture and publication guards are real.
      const verificationRunner = new VerificationRunner({
        commands: commandRunner,
        evidence,
        snapshots,
        secretScan: { scan: async ({ cwd }) => ({
          passed: !readFileSync(join(cwd, 'src/counter.ts'), 'utf8').includes('e2e-github-token'),
          evidenceRef: 'e2e:fixture-token-scan',
        }) },
        diffReview: { review: async ({ taskId, cwd }) => {
          const changes = await policyGit.status(cwd, taskId);
          const changedPaths = changes.entries.map((entry) => entry.path);
          return {
            passed: changedPaths.length === 1 && changedPaths[0] === 'src/counter.ts',
            changedPaths,
            evidenceRef: 'e2e:reviewed-counter-only',
          };
        } },
      });

      const publishing = {
        publish: async (context: {
          taskId: string;
          repoId: number;
          worktree: string;
          branch: string;
          paths: readonly string[];
          verification?: {planId: number; headSha: string};
          commitMessage: string;
          remote: string;
          lock: { release(): Promise<void> };
        }) => {
          if (context.verification === undefined) throw new Error("missing bound evidence");
          const remote = new RemoteService(
            commandRunner,
            { taskId: context.taskId },
            context.worktree,
          );
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
      if (observeLocks) observer = new SmokeLockObserver({ stateDirectory: fixture.rootPath, repoId: REPO_ID });
      const fakeBaseUrl = github.apiBaseUrl;
      const productionGitHub = observeLocks ? createProductionGitHubServices({
        secrets,
        pullRequests,
        evidence: new PullRequestEvidenceRepository(database),
        ciRuns,
        ...(observer === undefined ? {} : { observer }),
        fetch: (url, init) => {
          const source = new URL(url);
          expect(source.origin).toBe('https://api.github.com');
          return fetchForGitHub(`${fakeBaseUrl}${source.pathname}${source.search}`, init);
        },
      }) : undefined;

      const runner = createTaskRunner({
        audit,
        tasks,
        repos: repoProfiles,
        locks: trackedLocks,
        git: gitPort,
        worktrees: worktreeService,
        verification,
        publishing,
        pullRequests: productionGitHub?.pullRequests ?? pullRequestService,
        checks: {
          client: productionGitHub?.checks.client ?? checksClient,
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
              const headSha = await policyGit.headSha(workspace.linuxPath, task.taskId);
              const plan = evidence.persistPlan({
                taskId: task.taskId, headSha, risk: 'LOW',
                plan: { changeClass: 'BACKEND', checks: [
                  { name: 'target-test', kind: 'COMMAND', required: true, status: 'PENDING', command: 'node --test test/counter.test.js' },
                  { name: 'secret-scan', kind: 'NON_COMMAND', required: true, status: 'PENDING' },
                  { name: 'diff-review', kind: 'NON_COMMAND', required: true, status: 'PENDING' },
                ] },
              });
              const checked = await verificationRunner.run(plan, { taskId: task.taskId, cwd: workspace.linuxPath });
              expect(checked.passed).toBe(true);
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
        readFileSync(join(defined(workspace).linuxPath, 'src', 'counter.ts'), 'utf8'),
      ).toContain('return value + 1;');
      expect(git(fixture.canonicalPath, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.canonicalPath, ['rev-parse', 'HEAD'])).toBe(
        fixture.initialSha,
      );

      const checks = verificationRepository.listForTask(created.id);
      expect(checks).toHaveLength(3);
      expect(
        checks.every(
          (check) =>
            check.required &&
            check.status === 'PASS' &&
            check.hasEvidence,
        ),
      ).toBe(true);

      const sealedPlan = verificationRepository.getBoundPlan(created.id, fixture.initialSha);
      expect(sealedPlan?.approvedPaths).toEqual(['src/counter.ts']);
      expect(sealedPlan?.snapshot.entries.map((entry) => entry.path)).toEqual(['src/counter.ts']);

      const published = commits.getLatestForTask(created.id);
      expect(published?.remoteConfirmed).toBe(true);
      expect(published?.sha).toMatch(/^[0-9a-f]{40}$/u);
      const remoteLine = git(fixture.canonicalPath, [
        'ls-remote',
        'origin',
        `refs/heads/${defined(published).branch}`,
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
        Date.parse(defined(auditRows[0]).createdAt),
      ).toBeLessThanOrEqual(Date.parse(defined(auditRows[1]).createdAt));

      const observationRows = database.prepare(`
        SELECT created_at AS createdAt, payload_json AS payloadJson
        FROM audit_events
        WHERE task_id = ? AND event_type = 'CI_OBSERVATION_STARTED'
        ORDER BY id
      `).all(created.id) as Array<{ createdAt: string; payloadJson: string }>;
      expect(observationRows).toHaveLength(2);
      expect(observationRows.map((row) => JSON.parse(row.payloadJson))).toEqual([
        { pullRequestId: defined(pr).id, headSha: defined(published).sha },
        { pullRequestId: defined(pr).id, headSha: defined(published).sha },
      ]);
      expect(Date.parse(defined(auditRows[1]).createdAt)).toBeLessThan(Date.parse(defined(pr).createdAt));
      expect(Date.parse(defined(pr).createdAt)).toBeLessThanOrEqual(Date.parse(defined(observationRows[0]).createdAt));

      if (observeLocks) {
        // Read committed evidence through a third, read-only SQLite connection:
        // these are actual transport boundary samples, not mock observer calls.
        const journal = new DatabaseSync(join(fixture.rootPath, 'smoke-lock-evidence.sqlite'), { readOnly: true });
        type Observation = SmokeContext & Partial<SmokeBoundary> & {
          kind: 'BOUNDARY' | 'PR_BINDING';
          observedAt: string;
          dbObservedAt: string;
          fileObservedAt: string;
          dbPresent: boolean;
          filePresent: boolean;
        };
        let observations: Observation[];
        try {
          observations = journal.prepare('SELECT payload FROM observations ORDER BY sequence').all()
            .map(row => JSON.parse(String(row.payload)) as Observation);
        } finally {
          journal.close();
        }
        const boundaries = observations.filter(sample => sample.kind === 'BOUNDARY');
        expect(github.requests).toHaveLength(10); // PR lookup/create and four endpoints per CI poll.
        expect(boundaries).toHaveLength(github.requests.length * 2);
        for (const sample of observations) {
          expect(sample).toMatchObject({ taskId: created.id, repoId: REPO_ID, headSha: defined(published).sha });
          expect(Number.isFinite(Date.parse(sample.observedAt))).toBe(true);
        }
        const expectedEndpoints = github.requests.map(request =>
          request.pathname.endsWith('/pulls') ? (request.method === 'POST' ? 'PR_CREATE' : 'PR_FIND') :
          request.pathname.includes('/rules/branches/') ? 'RULES' :
          request.pathname.endsWith('/statuses') ? 'STATUSES' :
          request.pathname.endsWith('/protection/required_status_checks') ? 'PROTECTION' : 'CHECK_RUNS');
        expect(new Set(expectedEndpoints)).toEqual(new Set(['PR_FIND', 'PR_CREATE', 'RULES', 'STATUSES', 'PROTECTION', 'CHECK_RUNS']));
        github.requests.forEach((request, index) => {
          const before = defined(boundaries[index * 2]);
          const after = defined(boundaries[index * 2 + 1]);
          expect(request.authorized).toBe(true);
          expect(before).toMatchObject({ boundary: 'BEFORE', endpoint: expectedEndpoints[index], method: request.method, dbPresent: false, filePresent: false });
          expect(after).toMatchObject({ boundary: 'AFTER', endpoint: expectedEndpoints[index], method: request.method, requestId: before.requestId,
            outcome: 'RESPONSE', status: request.method === 'POST' ? 201 : 200, dbPresent: false, filePresent: false });
          for (const sample of [before, after]) {
            expect(Date.parse(sample.dbObservedAt)).toBeGreaterThanOrEqual(Date.parse(defined(auditRows[1]).createdAt));
            expect(Date.parse(sample.fileObservedAt)).toBeGreaterThanOrEqual(Date.parse(defined(auditRows[1]).createdAt));
            expect(sample.pullRequestId).toBe(request.pathname.endsWith('/pulls') ? null : defined(pr).id);
          }
          expect(Date.parse(before.observedAt)).toBeLessThanOrEqual(Date.parse(after.observedAt));
        });
        const bindings = observations.filter(sample => sample.kind === 'PR_BINDING');
        expect(bindings).toHaveLength(1);
        expect(bindings[0]).toMatchObject({ pullRequestId: defined(pr).id, correlationId: defined(boundaries[0]).correlationId });
        const bindingIndex = observations.indexOf(defined(bindings[0]));
        expect(observations[bindingIndex - 1]).toMatchObject({ kind: 'BOUNDARY', endpoint: 'PR_CREATE', boundary: 'AFTER' });
        expect(observations[bindingIndex + 1]).toMatchObject({ kind: 'BOUNDARY', endpoint: 'RULES', boundary: 'BEFORE' });
        expect(Date.parse(defined(bindings[0]).observedAt)).toBeGreaterThanOrEqual(Date.parse(defined(pr).createdAt));
      }

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
        .map((run) => JSON.parse(defined(run.argsJson)) as string[]);
      expect(gitArgs.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(true);
      expect(gitArgs.some((args) => args[0] === 'push' && args[2] === `${published?.sha}:refs/heads/${published?.branch}`)).toBe(true);
      expect(gitArgs.some((args) => args[0] === 'ls-remote')).toBe(true);
    } finally {
      if (scheduler !== undefined) await scheduler.stop();
      observer?.close();
      if (database !== undefined && database.open) database.close();
      if (github !== undefined) await github.close();
      fixture?.cleanup();
    }
  });
});
