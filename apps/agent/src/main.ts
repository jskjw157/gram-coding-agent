import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskId } from '@gram/domain';
import { CommitService, RemoteService } from '@gram/git';
import { createMcpHttpServer } from '@gram/mcp';
import { HealthService, StructuredLogger, type AgentHealthStatus } from '@gram/observability';
import {
  AuditRepository,
  CommandRunRepository,
  GitCommitRepository,
  LockRepository,
  openDatabase,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  VerificationRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { PublishingService } from '@gram/publishing';
import { RepoLockService, type RepoLockLease } from '@gram/repo-lock';
import { FileSecretProvider, SecretRedactor } from '@gram/secrets';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';
import { TaskService } from '@gram/task-engine';
import { CompletionEvaluator } from '@gram/verification';
import { PathMapper, WorktreeService } from '@gram/workspace';
import { PolicyGitAdapter, PolicyWorktreeAdapter, PolicyWslPathRunner } from './command-adapters.js';
import {
  PersistentCiContextResolver,
  PersistentVerificationCompletion,
  RegisteredRepositoryProfiles,
} from './persistence-adapters.js';
import { createTaskRunner, type CompositionLocks } from './task-runner-composition.js';
import { TaskScheduler } from './task-scheduler.js';

export interface StartAgentOptions {
  stateDirectory: string;
  secretDirectory: string;
  host?: '127.0.0.1' | '::1';
  port?: number;
  installSignalHandlers?: boolean;
  exit?: (code: number) => void;
}

export interface RunningAgent {
  host: string;
  port: number;
  url: string;
  health(): AgentHealthStatus;
  close(): Promise<void>;
}

export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3847;
  mkdirSync(options.stateDirectory, { recursive: true });

  const database = openDatabase(join(options.stateDirectory, 'agent.sqlite'));
  runMigrations(database);

  let mcpReady = false;
  let closed = false;
  const healthService = new HealthService({
    databaseReady: () => database.open,
    mcpReady: () => mcpReady,
  });

  const taskRepository = new TaskRepository(database);
  const auditRepository = new AuditRepository(database);
  const repositoryRepository = new RepositoryRepository(database);
  const lockRepository = new LockRepository(database);
  const workspaceRepository = new WorkspaceRepository(database);
  const commandRunRepository = new CommandRunRepository(database);
  const verificationRepository = new VerificationRepository(database);
  const gitCommitRepository = new GitCommitRepository(database);
  const pullRequestRepository = new PullRequestRepository(database);
  const taskService = new TaskService(taskRepository, auditRepository);
  const policyEngine = new PolicyEngine();

  const repoProfiles = new RegisteredRepositoryProfiles({
    repositories: repositoryRepository,
    tasks: taskRepository,
  });
  const lockService = new RepoLockService({
    locks: lockRepository,
    tasks: taskRepository,
    lockDirectory: join(options.stateDirectory, 'locks'),
  });
  // Tracks every lease this process acquires so shutdown can stop the
  // background heartbeat without releasing the lock. AGENTS.md forbids
  // releasing the repository lock before a confirmed remote push, so a lease
  // held by a failed run stays held on purpose: the lock file and the
  // repo_locks row are left intact. Only the interval is stopped, so it can
  // never touch SQLite after the database is closed.
  const heldLeases = new Map<TaskId, RepoLockLease>();
  const trackedLocks: CompositionLocks = {
    acquire: async (repoId, taskId) => {
      const lease = await lockService.acquire(repoId, taskId);
      heldLeases.set(taskId, lease);
      return {
        release: async () => {
          heldLeases.delete(taskId);
          await lease.release();
        },
      };
    },
  };
  const quiesceHeldLeases = async (): Promise<void> => {
    for (const lease of heldLeases.values()) {
      await lease.quiesce();
    }
    heldLeases.clear();
  };
  const completionEvaluator = new CompletionEvaluator(verificationRepository);
  const verification = new PersistentVerificationCompletion(completionEvaluator);
  const ciContext = new PersistentCiContextResolver({
    tasks: taskRepository,
    repositories: repositoryRepository,
    pullRequests: pullRequestRepository,
    gitCommits: gitCommitRepository,
  });

  const secretProvider = new FileSecretProvider(options.secretDirectory);
  const secretLease = await secretProvider.getForUse('mcp-internal-secret');

  try {
    const composed = await secretLease.withValue(async (internalSecret) => {
      const redactor = new SecretRedactor([internalSecret]);
      const logger = new StructuredLogger({ redactor });
      const commandRunner = new CommandRunner({
        policy: policyEngine,
        // No approval facility exists in this slice (there is an approvals
        // table but no repository or UI backing it), so every
        // NEEDS_APPROVAL command fails closed until approvals are wired.
        approvals: { consume: async () => false },
        spawner: new NodeProcessSpawner(),
        commandRuns: commandRunRepository,
        outputCapture: new OutputCapture({ homeDir: homedir(), redactor }),
      });
      const worktreeService = new WorktreeService({
        homeDir: homedir(),
        git: new PolicyWorktreeAdapter({ runner: commandRunner }),
        workspaces: workspaceRepository,
        pathMapper: new PathMapper(new PolicyWslPathRunner({ runner: commandRunner })),
      });
      const taskRunner = createTaskRunner({
        audit: auditRepository,
        tasks: taskRepository,
        repos: repoProfiles,
        locks: trackedLocks,
        git: new PolicyGitAdapter({ runner: commandRunner }),
        worktrees: worktreeService,
        verification,
        publishing: {
          publish: async (context) => {
            // Per-call task attribution: CommitService and RemoteService
            // bind one task at construction, and the publish context carries
            // the running task id, so fresh instances are built per call.
            const publishing = new PublishingService({
              verification: {
                assertPassed: (taskId) => {
                  if (completionEvaluator.requiredChecksPassed(taskId) === false) {
                    throw new Error(`verification has not passed for task ${taskId}`);
                  }
                },
              },
              commits: new CommitService(commandRunner, { taskId: context.taskId }),
              remote: new RemoteService(
                commandRunner,
                { taskId: context.taskId },
                context.worktree,
              ),
              persistence: gitCommitRepository,
              audit: auditRepository,
            });
            const published = await publishing.publish({
              taskId: context.taskId,
              repoId: context.repoId,
              worktree: context.worktree,
              branch: context.branch,
              paths: [...context.paths],
              commitMessage: context.commitMessage,
              remote: context.remote,
              lock: context.lock,
            });
            return {
              sha: published.sha,
              branch: published.branch,
              remote: published.remote,
            };
          },
        },
        ciContext,
        workspaces: workspaceRepository,
      });
      const scheduler = new TaskScheduler({
        tasks: taskRepository,
        runner: taskRunner,
        audit: auditRepository,
        logger,
      });
      const mcp = await createMcpHttpServer({
        host,
        port,
        internalSecret,
        health: () => healthService.status(),
        taskCreate: taskService,
      });
      mcpReady = true;
      logger.info('agent started', { host: mcp.host, port: mcp.port });
      // The scheduler starts only after MCP is ready, so no QUEUED task is
      // dispatched before the agent can accept submissions. If startup fails
      // here the MCP server is closed before the database cleanup below.
      try {
        scheduler.start();
      } catch (error) {
        await mcp.close();
        throw error;
      }
      return { logger, mcp, scheduler };
    });

    const exit = options.exit ?? ((code: number) => process.exit(code));
    let signalHandler: (() => void) | undefined;

    const removeSignalHandlers = () => {
      if (signalHandler === undefined) return;
      process.off('SIGTERM', signalHandler);
      process.off('SIGINT', signalHandler);
      signalHandler = undefined;
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      removeSignalHandlers();
      // Safety-critical order: stop() synchronously blocks any further
      // dispatch, then stop accepting submissions, then wait for
      // already-registered runs (no cancellation, no deadline), then stop the
      // heartbeat of any lease those runs deliberately left held, and only
      // then close SQLite. Quiescing never releases: a lease whose push was
      // not confirmed stays held for explicit recovery.
      const drained = composed.scheduler.stop();
      mcpReady = false;
      await composed.mcp.close();
      await drained;
      await quiesceHeldLeases();
      database.close();
      composed.logger.info('agent stopped');
    };

    if (options.installSignalHandlers !== false) {
      signalHandler = () => {
        void close().then(
          () => exit(0),
          () => exit(1),
        );
      };
      process.once('SIGTERM', signalHandler);
      process.once('SIGINT', signalHandler);
    }

    return {
      host: composed.mcp.host,
      port: composed.mcp.port,
      url: composed.mcp.url,
      health: () => healthService.status(),
      close,
    };
  } catch (error) {
    database.close();
    throw error;
  } finally {
    secretLease.dispose();
  }
}

function requiredRuntimePath(name: 'GRAM_AGENT_STATE_DIR' | 'GRAM_AGENT_SECRET_DIR'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured for the agent service`);
  }
  return value;
}

const entryPath = process.argv[1];
const isDirectExecution = entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath);

if (isDirectExecution) {
  void startAgent({
    stateDirectory: requiredRuntimePath('GRAM_AGENT_STATE_DIR'),
    secretDirectory: requiredRuntimePath('GRAM_AGENT_SECRET_DIR'),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown startup error';
    process.stderr.write(`[gram-coding-agent] startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
