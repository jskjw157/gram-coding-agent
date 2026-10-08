import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { TaskId } from '@gram/domain';
import { CommitService, GitService, RemoteService, type GitCommandRunnerPort } from '@gram/git';
import {
  AuditRepository,
  GitCommitRepository,
  LockRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  VerificationRepository,
} from '@gram/persistence';
import { PublishingService } from '@gram/publishing';
import { RepoLockService, type RepoLockLease } from '@gram/repo-lock';
import { TaskRunner } from '@gram/task-engine';
import { CompletionEvaluator } from '@gram/verification';
import { TaskScheduler } from '../../apps/agent/src/task-scheduler.js';
import { Barrier, Checkpoint, deferred } from './synchronization.js';

const execute = promisify(execFile);
const FIXED_NOW = new Date('2026-10-08T00:00:00.000Z');

interface RepositoryFixture {
  repoId: number;
  canonical: string;
  remote: string;
  initialSha: string;
}

export class ControlledTask {
  readonly mutation = new Checkpoint();
  readonly confirmation = new Checkpoint();
  readonly recording = new Checkpoint();
  readonly pr = new Checkpoint();
  readonly ci = new Checkpoint();
  readonly compared = deferred<boolean>();

  constructor(
    readonly id: TaskId,
    readonly repoId: number,
    readonly branch: string,
    readonly worktree: string,
  ) {}

  openAll(): void {
    for (const gate of [this.mutation, this.confirmation, this.recording, this.pr, this.ci]) gate.open();
  }
}

interface Attempt {
  taskId: TaskId;
  pending: Promise<void>;
}

function outsideRepairScope(): never {
  throw new Error('The concurrency fixture does not implement CI repair');
}

/**
 * Linux/local-Git integration fixture, NOT Windows/WSL or authenticated GitHub acceptance.
 * Scheduler, TaskRunner, locks (SQLite + wx files), publishing, commits and remote SHA
 * comparison are production code. Mutation/verification/PR/CI inputs are controlled.
 * No policy/tunnel/service installation or real remote repository is exercised here.
 */
export class ConcurrencyFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'gram-m3-concurrency-'));
  readonly db = openDatabase(join(this.root, 'state.db'));
  readonly tasks = new TaskRepository(this.db);
  readonly locks = new LockRepository(this.db);
  readonly commits = new GitCommitRepository(this.db);
  readonly attempts: Attempt[] = [];
  readonly errors: string[] = [];
  readonly scheduler: TaskScheduler;
  private readonly audit = new AuditRepository(this.db);
  private readonly verification = new VerificationRepository(this.db);
  private readonly evaluator = new CompletionEvaluator(this.verification);
  private readonly repos = new Map<number, RepositoryFixture>();
  private readonly controls = new Map<TaskId, ControlledTask>();
  private readonly leases: RepoLockLease[] = [];
  private readonly lockDirectory = join(this.root, 'locks');
  private readonly gitEnvironment: NodeJS.ProcessEnv;

  constructor(private readonly barrier?: Barrier) {
    runMigrations(this.db);
    const emptyConfig = join(this.root, 'empty-git-config');
    writeFileSync(emptyConfig, '');
    mkdirSync(join(this.root, 'empty-hooks'));
    // Do not inherit machine Git overrides, credentials, hooks or network transports.
    this.gitEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].includes(key),
        ),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Gram concurrency fixture',
      GIT_COMMITTER_NAME: 'Gram concurrency fixture',
      GIT_AUTHOR_EMAIL: 'concurrency@example.test',
      GIT_COMMITTER_EMAIL: 'concurrency@example.test',
      GIT_AUTHOR_DATE: FIXED_NOW.toISOString(),
      GIT_COMMITTER_DATE: FIXED_NOW.toISOString(),
    };
    const lockService = new RepoLockService({
      locks: this.locks,
      tasks: this.tasks,
      lockDirectory: this.lockDirectory,
      now: () => FIXED_NOW,
      pid: () => 4242,
      bootId: () => 'm3-controlled-boot',
      // Heartbeat scheduling is deliberately controlled, never a real-time test dependency.
      scheduler: { setInterval: () => 0, clearInterval: () => undefined },
    });
    const commandRunner: GitCommandRunnerPort = {
      run: async (request) => {
        if (request.executable !== 'git' || request.category !== 'GIT' || request.args === undefined) {
          throw new Error('This fixture accepts Git commands only');
        }
        return { exitCode: 0, stdout: await this.git(request.cwd, request.args), stderr: '' };
      },
    };
    const runner = new TaskRunner({
      audit: this.audit,
      locks: {
        acquire: async (repoId, taskId) => {
          const lease = await lockService.acquire(repoId, taskId);
          this.leases.push(lease);
          return lease;
        },
      },
      workspaces: { reuse: outsideRepairScope },
      mutations: { repair: outsideRepairScope },
      verification: { verify: outsideRepairScope },
      git: { push: outsideRepairScope, confirmRemoteSha: outsideRepairScope },
      ci: { observe: outsideRepairScope },
      repoResolve: {
        resolve: async (taskId) => {
          const task = this.control(taskId);
          return {
            taskId,
            repoId: task.repoId,
            branch: task.branch,
            remote: 'origin',
            localBasePath: this.repository(task.repoId).canonical,
          };
        },
      },
      repoFetch: {
        fetch: async (task) => new GitService(commandRunner, { taskId: task.taskId }).fetch(task.localBasePath),
      },
      workspaceCreate: {
        create: async (taskId) => {
          const task = this.control(taskId);
          await this.git(this.repository(task.repoId).canonical, [
            'worktree',
            'add',
            '-b',
            task.branch,
            task.worktree,
            'origin/main',
          ]);
          return { linuxPath: task.worktree, branch: task.branch };
        },
      },
      instructions: { load: async () => ({ content: 'Change the fixture file only.', source: 'fixture' }) },
      analyze: { analyze: async () => ({ summary: 'Controlled one-file mutation', files: ['change.txt'] }) },
      modify: {
        modify: async ({ task, workspace }) => {
          const control = this.control(task.taskId);
          // TaskRunner has already performed the real PREPARING -> RUNNING transition.
          const permission = control.mutation.wait();
          await this.barrier?.arriveAndWait(task.taskId);
          await permission;
          writeFileSync(join(workspace.linuxPath, 'change.txt'), `mutation:${task.taskId}\n`);
          return { sha: await this.git(workspace.linuxPath, ['rev-parse', 'HEAD']) };
        },
      },
      progress: this.tasks,
      verify: {
        verify: async (taskId) => {
          const task = this.control(taskId);
          if (readFileSync(join(task.worktree, 'change.txt'), 'utf8') !== `mutation:${taskId}\n`) {
            throw new Error('Controlled mutation content was not written');
          }
          const headSha = await this.git(task.worktree, ['rev-parse', 'HEAD']);
          const planId = this.verification.createPlan({
            taskId,
            headSha,
            changeClass: 'TEST_ONLY',
            plan: { scope: 'local concurrency fixture' },
          });
          const check = this.verification.createCheck({ planId, taskId, name: 'fixture-content', required: true });
          this.verification.finishCheck(check, { status: 'PASS', evidenceRef: `fixture-content:${taskId}` });
          return {
            passed: this.evaluator.requiredChecksPassed(taskId, headSha),
            output: 'fixture content checked',
            headSha,
          };
        },
      },
      publish: {
        publish: async (task, workspace, verification, lease) => {
          const control = this.control(task.taskId);
          const context = { taskId: task.taskId, publishMode: 'PULL_REQUEST' as const };
          const remote = new RemoteService(commandRunner, context, workspace.linuxPath);
          const publishing = new PublishingService({
            verification: {
              assertPassed: (taskId) => {
                if (!this.evaluator.requiredChecksPassed(taskId, verification.headSha)) {
                  throw new Error('Fixture verification evidence is missing');
                }
              },
              assertCommitted: async (_taskId, sha) => {
                const content = await this.git(workspace.linuxPath, ['show', `${sha}:change.txt`]);
                if (content !== `mutation:${task.taskId}`) throw new Error('Committed fixture content differs');
              },
            },
            commits: new CommitService(commandRunner, context),
            remote: {
              push: (path, branch, sha) => remote.push(path, branch, sha),
              confirmRemoteSha: async (name, branch, sha) => {
                await control.confirmation.wait();
                const confirmed = await remote.confirmRemoteSha(name, branch, sha);
                control.compared.resolve(confirmed);
                return confirmed;
              },
            },
            persistence: {
              recordCommit: (input) => this.commits.recordCommit(input),
              markRemoteConfirmed: async (id, at) => {
                await control.recording.wait();
                this.commits.markRemoteConfirmed(id, at);
              },
            },
            audit: this.audit,
            now: () => FIXED_NOW,
          });
          return publishing.publish({
            taskId: task.taskId,
            repoId: task.repoId,
            worktree: workspace.linuxPath,
            branch: task.branch,
            paths: ['change.txt'],
            commitMessage: 'test: controlled mutation',
            remote: task.remote,
            lock: lease,
          });
        },
      },
      prEnsure: {
        ensure: async (task) => {
          await this.control(task.taskId).pr.wait();
          return { number: 1, url: 'https://example.test/fixture/pull/1' };
        },
      },
      ciObserve: {
        observe: async (taskId) => {
          await this.control(taskId).ci.wait();
          return 'SUCCESS';
        },
      },
      complete: {
        complete: async (taskId) => {
          this.tasks.transition(taskId, 'PUBLISHING', 'COMPLETED');
        },
      },
    });
    this.scheduler = new TaskScheduler({
      tasks: this.tasks,
      runner: {
        // Return the same promise: scheduler subscription precedes test observers.
        run: (taskId) => {
          const pending = runner.run(taskId);
          this.attempts.push({ taskId, pending });
          return pending;
        },
      },
      audit: this.audit,
      logger: {
        error: (message) => {
          this.errors.push(message);
        },
      },
      now: () => FIXED_NOW,
    });
  }

  async addRepository(repoId: number): Promise<void> {
    const remote = join(this.root, `${repoId}.git`);
    const canonical = join(this.root, `repo-${repoId}`);
    await this.git(this.root, [
      'init',
      '--bare',
      '--template=',
      '--object-format=sha1',
      '--initial-branch=main',
      remote,
    ]);
    await this.git(this.root, ['init', '--template=', '--object-format=sha1', '--initial-branch=main', canonical]);
    writeFileSync(join(canonical, 'change.txt'), 'seed\n');
    await this.git(canonical, ['add', '--', 'change.txt']);
    await this.git(canonical, ['commit', '-m', 'test: seed local repository']);
    await this.git(canonical, ['remote', 'add', 'origin', remote]);
    await this.git(canonical, ['push', 'origin', 'main']);
    const initialSha = await this.git(canonical, ['rev-parse', 'HEAD']);
    this.repos.set(repoId, { repoId, canonical, remote, initialSha });
    new RepositoryRepository(this.db).upsert({
      githubRepositoryId: repoId,
      owner: 'acme',
      name: `repo-${repoId}`,
      defaultBranch: 'main',
      localBasePath: canonical,
    });
  }

  createTask(repoId: number, selector = `acme/repo-${repoId}`): ControlledTask {
    this.repository(repoId);
    const task = this.tasks.create({
      repoId,
      repoSelector: selector,
      goal: 'Controlled mutation',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const control = new ControlledTask(task.id, repoId, `test/task-${task.id}`, join(this.root, `worktree-${task.id}`));
    this.controls.set(task.id, control);
    return control;
  }

  latestAttempt(task: ControlledTask): Attempt {
    const attempt = this.attempts.findLast((candidate) => candidate.taskId === task.id);
    if (attempt === undefined) throw new Error('Task was not dispatched');
    return attempt;
  }

  lockFile(repoId: number): unknown {
    const path = join(this.lockDirectory, `${repoId}.lock`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
  }

  remoteSha(task: ControlledTask): Promise<string> {
    return this.git(this.repository(task.repoId).remote, ['rev-parse', `refs/heads/${task.branch}`]);
  }

  async rewindRemote(task: ControlledTask): Promise<void> {
    const repo = this.repository(task.repoId);
    await this.git(repo.remote, ['update-ref', `refs/heads/${task.branch}`, repo.initialSha]);
  }

  publishingEvents(task: ControlledTask): string[] {
    const rows = this.db
      .prepare(
        "SELECT event_type AS eventType FROM audit_events WHERE task_id = ? AND event_type != 'TASK_RUN_FAILED' ORDER BY id",
      )
      .all(task.id) as Array<{ eventType: string }>;
    return rows.map((row) => row.eventType);
  }

  failures(): Array<{ taskId: string; errorName: string }> {
    return this.db
      .prepare(
        "SELECT task_id AS taskId, json_extract(payload_json, '$.errorName') AS errorName FROM audit_events WHERE event_type = 'TASK_RUN_FAILED' ORDER BY id",
      )
      .all() as Array<{ taskId: string; errorName: string }>;
  }

  async close(): Promise<void> {
    const drained = this.scheduler.stop();
    this.barrier?.open();
    for (const task of this.controls.values()) task.openAll();
    await drained;
    try {
      // Failed publication intentionally keeps its production lease until fixture teardown.
      for (const lease of this.leases) await lease.release();
    } finally {
      this.db.close();
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  private control(taskId: TaskId): ControlledTask {
    const task = this.controls.get(taskId);
    if (task === undefined) throw new Error('Unknown fixture task');
    return task;
  }

  private repository(repoId: number): RepositoryFixture {
    const repo = this.repos.get(repoId);
    if (repo === undefined) throw new Error('Unknown fixture repository');
    return repo;
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const path = relative(this.root, cwd);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('Git cwd escaped disposable fixture');
    const result = await execute(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        `core.hooksPath=${join(this.root, 'empty-hooks')}`,
        ...args,
      ],
      { cwd, env: this.gitEnvironment, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim();
  }
}
