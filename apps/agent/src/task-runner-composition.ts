import type { TaskId, TaskStatus } from '@gram/domain';
import {
  ChecksService,
  type ChecksClientPort,
  type CiPullRequestContext,
  type CiRunPersistencePort,
  type DelayPort,
} from '@gram/github';
import type { AuditRepository } from '@gram/persistence';
import {
  TaskRunner,
  type AnalyzePort,
  type CiObservePort,
  type CompletePort,
  type InstructionsPort,
  type ModifyPort,
  type PrEnsurePort,
  type PublishPort,
  type RepairCycleCiPort,
  type RepairCycleGitPort,
  type RepairCycleLockPort,
  type RepairCycleMutationPort,
  type RepairCycleVerifyPort,
  type RepairCycleWorkspacePort,
  type RepoFetchPort,
  type RepoResolvePort,
  type VerifyPort,
  type WorkspaceCreatePort,
} from '@gram/task-engine';
import { createTaskBranchName } from '@gram/workspace';

/**
 * Typed fail-closed error for composition gaps. Adapters that have no real
 * capability wired yet must throw this instead of faking success or
 * returning empty modifications.
 */
export class TaskRunnerConfigurationError extends Error {
  readonly adapter: string;

  constructor(adapter: string, detail: string) {
    super(`TaskRunner ${adapter} is not configured: ${detail}`);
    this.name = 'TaskRunnerConfigurationError';
    this.adapter = adapter;
  }
}

const ORIGIN_REMOTE = 'origin';

export interface CompositionTaskRecord {
  readonly id: TaskId;
  readonly seq: number;
  readonly goal: string;
  readonly repoSelector: string | null;
  readonly status: TaskStatus;
  readonly taskType: string;
}

export interface CompositionTaskStore {
  get(id: TaskId): CompositionTaskRecord | null;
  transition(id: TaskId, from: TaskStatus, to: TaskStatus): void;
}

export interface CompositionAuditPort {
  append(event: {
    taskId?: TaskId | null;
    eventType: string;
    payload?: unknown;
    createdAt?: string;
  }): unknown;
}

/** Structural subset of RepoResolver.resolve output. */
export interface CompositionRepoProfile {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localBasePath: string;
}

/** Structural subset of RepoResolver.resolve output. */
export interface CompositionRepoProfiles {
  resolve(selector: string): Promise<CompositionRepoProfile>;
}

/** Structural subset of RepoLockService. */
export interface CompositionLocks {
  acquire(repoId: number, taskId: TaskId): Promise<{ release(): Promise<void> }>;
}

/** Structural subset of GitService (fetch + status). */
export interface CompositionGit {
  fetch(repoPath: string): Promise<void>;
  status(worktree: string): Promise<{ entries: readonly { path: string }[] }>;
}

/** Structural subset of WorktreeService.create. */
export interface CompositionWorktrees {
  create(input: {
    taskId: TaskId;
    repo: { githubRepositoryId: number; localBasePath: string };
    baseRef: string;
    branch: string;
  }): Promise<{ linuxPath: string; branch: string }>;
}

/** Structural subset of CompletionEvaluator. */
export interface CompositionVerification {
  requiredChecksPassed(taskId: TaskId): boolean | Promise<boolean>;
}

/** Structural subset of PublishingService.publish. */
export interface CompositionPublishing {
  publish(context: {
    taskId: TaskId;
    repoId: number;
    worktree: string;
    branch: string;
    paths: readonly string[];
    commitMessage: string;
    remote: string;
    lock: { release(): Promise<void> };
  }): Promise<{ sha: string; branch: string; remote: string }>;
}

/** Structural subset of PullRequestService.ensureForTask. */
export interface CompositionPullRequests {
  ensureForTask(task: {
    taskId: string;
    repoId: number;
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<{ number: number; url: string }>;
}

export interface CompositionChecks {
  client: ChecksClientPort;
  persistence: CiRunPersistencePort;
  delay?: DelayPort;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

/** Resolves the CI pull-request context for a task from recorded state. */
export interface CompositionCiContext {
  resolve(taskId: TaskId): Promise<CiPullRequestContext>;
}

/** Structural subset of WorkspaceRepository. */
export interface CompositionWorkspaces {
  getByTaskId(
    taskId: TaskId,
  ):
    | { linuxPath: string; branch: string }
    | undefined
    | Promise<{ linuxPath: string; branch: string } | undefined>;
}

/**
 * Remote push port for the repair cycle. Unlike RemoteService.push (void),
 * this resolves the pushed SHA so the cycle can confirm it remotely.
 */
export interface CompositionRemote {
  push(worktree: string, branch: string): Promise<string>;
  confirmRemoteSha(remote: string, branch: string, expectedSha: string): Promise<boolean>;
}

export interface CompositionCapabilities {
  instructions?: InstructionsPort;
  analyze?: AnalyzePort;
  modify?: ModifyPort;
  repairMutations?: RepairCycleMutationPort;
}

export interface TaskRunnerCompositionOptions {
  audit: CompositionAuditPort;
  tasks: CompositionTaskStore;
  repos?: CompositionRepoProfiles;
  locks?: CompositionLocks;
  git?: CompositionGit;
  worktrees?: CompositionWorktrees;
  verification?: CompositionVerification;
  publishing?: CompositionPublishing;
  pullRequests?: CompositionPullRequests;
  checks?: CompositionChecks;
  ciContext?: CompositionCiContext;
  workspaces?: CompositionWorkspaces;
  remote?: CompositionRemote;
  capabilities?: CompositionCapabilities;
  complete?: CompletePort;
}

function taskBranchFor(task: { seq: number; goal: string; taskType: string }): string {
  const taskType =
    task.taskType === 'FEATURE' ? 'FEATURE' : task.taskType === 'CHORE' ? 'CHORE' : 'FIX';
  return createTaskBranchName({
    taskType,
    displaySequence: task.seq,
    goal: task.goal,
  });
}

/**
 * Builds a TaskRunner from the agent's real services. Every run() and
 * repair-cycle port is supplied: thin adapters delegate to the injected
 * service, while capabilities with no real implementation yet
 * (instruction loading, analysis, modification, repair mutations) fail
 * closed with TaskRunnerConfigurationError.
 *
 * The ChecksService observer is always constructed with a no-op completion
 * port: final success is delegated to CompletePort exactly once by
 * TaskRunner.run, never completed internally by CI observation.
 * PublishingService remains the sole lock-release owner: the publish
 * adapter hands the acquired lease straight through and never releases it.
 */
export function createTaskRunner(options: TaskRunnerCompositionOptions): TaskRunner {
  const { audit, tasks } = options;
  const profileCache = new Map<TaskId, CompositionRepoProfile>();

  const requireTask = (taskId: TaskId, adapter: string): CompositionTaskRecord => {
    const stored = tasks.get(taskId);
    if (stored === null) {
      throw new TaskRunnerConfigurationError(adapter, `task not found: ${taskId}`);
    }
    return stored;
  };

  const resolveProfile = async (taskId: TaskId, adapter: string) => {
    const stored = requireTask(taskId, adapter);
    const cached = profileCache.get(taskId);
    // One underlying discovery per task: run() resolves once, and the
    // workspace/PR adapters reuse the same profile so the exact
    // TaskRunner event order is preserved.
    if (cached !== undefined) return { stored, profile: cached };
    if (options.repos === undefined) {
      throw new TaskRunnerConfigurationError(
        adapter,
        'repository discovery (RepoResolver) is not wired in the agent composition root',
      );
    }
    const selector = stored.repoSelector;
    if (selector === null || selector.trim().length === 0) {
      throw new TaskRunnerConfigurationError(
        adapter,
        `task ${taskId} has no repository selector`,
      );
    }
    const profile = await options.repos.resolve(selector);
    profileCache.set(taskId, profile);
    return { stored, profile };
  };

  const repoResolve: RepoResolvePort = {
    resolve: async (taskId) => {
      const { stored, profile } = await resolveProfile(taskId, 'RepoResolve');
      return {
        taskId,
        repoId: profile.githubRepositoryId,
        branch: taskBranchFor(stored),
        remote: ORIGIN_REMOTE,
        localBasePath: profile.localBasePath,
      };
    },
  };

  const locks: RepairCycleLockPort = {
    acquire: async (repoId, taskId) => {
      if (options.locks === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepoLocks',
          'repository locking (RepoLockService) is not wired in the agent composition root',
        );
      }
      return options.locks.acquire(repoId, taskId);
    },
  };

  const repoFetch: RepoFetchPort = {
    fetch: async (task) => {
      if (options.git === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepoFetch',
          'git fetch (GitService) is not wired in the agent composition root',
        );
      }
      if (typeof task.localBasePath !== 'string' || task.localBasePath.trim().length === 0) {
        throw new TaskRunnerConfigurationError(
          'RepoFetch',
          `resolved task ${task.taskId} has no local base path`,
        );
      }
      await options.git.fetch(task.localBasePath);
    },
  };

  const workspaceCreate: WorkspaceCreatePort = {
    create: async (taskId) => {
      const { stored, profile } = await resolveProfile(taskId, 'WorkspaceCreate');
      if (options.worktrees === undefined) {
        throw new TaskRunnerConfigurationError(
          'WorkspaceCreate',
          'worktree provisioning (WorktreeService) is not wired in the agent composition root',
        );
      }
      const branch = taskBranchFor(stored);
      const workspace = await options.worktrees.create({
        taskId,
        repo: {
          githubRepositoryId: profile.githubRepositoryId,
          localBasePath: profile.localBasePath,
        },
        baseRef: profile.defaultBranch,
        branch,
      });
      return { linuxPath: workspace.linuxPath, branch: workspace.branch };
    },
  };

  const instructions: InstructionsPort =
    options.capabilities?.instructions ?? {
      load: async () => {
        throw new TaskRunnerConfigurationError(
          'Instructions',
          'repository instruction loading is not wired in the agent composition root',
        );
      },
    };

  const analyze: AnalyzePort =
    options.capabilities?.analyze ?? {
      analyze: async () => {
        throw new TaskRunnerConfigurationError(
          'Analyze',
          'task analysis is not wired in the agent composition root',
        );
      },
    };

  const modify: ModifyPort =
    options.capabilities?.modify ?? {
      modify: async () => {
        throw new TaskRunnerConfigurationError(
          'Modify',
          'mutation facilities are not wired in the agent composition root',
        );
      },
    };

  const verify: VerifyPort = {
    verify: async (taskId) => {
      if (options.verification === undefined) {
        throw new TaskRunnerConfigurationError(
          'Verify',
          'verification (CompletionEvaluator/VerificationRunner) is not wired in the agent composition root',
        );
      }
      const passed = await options.verification.requiredChecksPassed(taskId);
      return {
        passed,
        output: passed
          ? `required verification checks passed for task ${taskId}`
          : `required verification checks did not pass for task ${taskId}`,
      };
    },
  };

  const publish: PublishPort = {
    publish: async (task, workspace, verification, lease) => {
      // The verification result is informational here: PublishingService
      // re-asserts verification through its own completion port before
      // committing, so a stale pass can never publish.
      void verification;
      if (options.publishing === undefined) {
        throw new TaskRunnerConfigurationError(
          'Publish',
          'publication (PublishingService) is not wired in the agent composition root',
        );
      }
      if (options.git === undefined) {
        throw new TaskRunnerConfigurationError(
          'Publish',
          'git status (GitService) is not wired in the agent composition root',
        );
      }
      const stored = requireTask(task.taskId, 'Publish');
      const status = await options.git.status(workspace.linuxPath);
      const published = await options.publishing.publish({
        taskId: task.taskId,
        repoId: task.repoId,
        worktree: workspace.linuxPath,
        branch: task.branch,
        paths: status.entries.map((entry) => entry.path),
        commitMessage: `task ${task.taskId}: ${stored.goal}`,
        remote: task.remote,
        // Sole lock-release owner: the lease passes straight through to
        // PublishingService, which releases it only after confirming the
        // remote push. This adapter never releases the lease itself.
        lock: lease,
      });
      return {
        taskId: task.taskId,
        sha: published.sha,
        branch: published.branch,
        remote: published.remote,
      };
    },
  };

  const prEnsure: PrEnsurePort = {
    ensure: async (task, published) => {
      if (options.pullRequests === undefined) {
        throw new TaskRunnerConfigurationError(
          'PrEnsure',
          'pull-request management (PullRequestService) is not wired in the agent composition root',
        );
      }
      const { profile } = await resolveProfile(task.taskId, 'PrEnsure');
      const view = await options.pullRequests.ensureForTask({
        taskId: task.taskId,
        repoId: task.repoId,
        owner: profile.owner,
        name: profile.name,
        headBranch: published.branch,
        baseBranch: profile.defaultBranch,
      });
      return { number: view.number, url: view.url };
    },
  };

  // The observer must never complete the task internally: final success is
  // delegated to CompletePort exactly once by TaskRunner.run.
  const checksService =
    options.checks === undefined
      ? undefined
      : new ChecksService({
          client: options.checks.client,
          persistence: options.checks.persistence,
          completion: { complete: () => undefined },
          ...(options.checks.delay === undefined ? {} : { delay: options.checks.delay }),
          ...(options.checks.maxAttempts === undefined
            ? {}
            : { maxAttempts: options.checks.maxAttempts }),
          ...(options.checks.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: options.checks.pollIntervalMs }),
        });

  const resolveCiContext = async (taskId: TaskId, adapter: string) => {
    if (checksService === undefined) {
      throw new TaskRunnerConfigurationError(
        adapter,
        'CI observation (ChecksService) is not wired in the agent composition root',
      );
    }
    if (options.ciContext === undefined) {
      throw new TaskRunnerConfigurationError(
        adapter,
        'CI pull-request context resolution is not wired in the agent composition root',
      );
    }
    return { checksService, context: await options.ciContext.resolve(taskId) };
  };

  const ciObserve: CiObservePort = {
    observe: async (taskId) => {
      const { checksService: observer, context } = await resolveCiContext(taskId, 'CiObserve');
      const summary = await observer.observeRequiredChecks(context);
      return summary.outcome;
    },
  };

  const complete: CompletePort =
    options.complete ?? {
      complete: async (taskId) => {
        const stored = requireTask(taskId, 'Complete');
        if (stored.status === 'COMPLETED') return;
        tasks.transition(taskId, stored.status, 'COMPLETED');
      },
    };

  const workspaces: RepairCycleWorkspacePort = {
    reuse: async (taskId) => {
      if (options.workspaces === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepairWorkspaces',
          'workspace reuse (WorkspaceRepository) is not wired in the agent composition root',
        );
      }
      const stored = await options.workspaces.getByTaskId(taskId);
      if (stored === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepairWorkspaces',
          `no workspace recorded for task ${taskId}`,
        );
      }
      return { linuxPath: stored.linuxPath, branch: stored.branch };
    },
  };

  const mutations: RepairCycleMutationPort =
    options.capabilities?.repairMutations ?? {
      repair: async () => {
        throw new TaskRunnerConfigurationError(
          'RepairMutations',
          'repair mutation facilities are not wired in the agent composition root',
        );
      },
    };

  const repairVerification: RepairCycleVerifyPort = {
    verify: async (taskId) => {
      if (options.verification === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepairVerify',
          'verification (CompletionEvaluator/VerificationRunner) is not wired in the agent composition root',
        );
      }
      const passed = await options.verification.requiredChecksPassed(taskId);
      if (!passed) {
        throw new Error(`verification did not pass for task ${taskId}`);
      }
    },
  };

  const repairGit: RepairCycleGitPort = {
    push: async (worktree, branch) => {
      if (options.remote === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepairGit',
          'remote push (RemoteService) is not wired in the agent composition root',
        );
      }
      return options.remote.push(worktree, branch);
    },
    confirmRemoteSha: async (remote, branch, expectedSha) => {
      if (options.remote === undefined) {
        throw new TaskRunnerConfigurationError(
          'RepairGit',
          'remote confirmation (RemoteService) is not wired in the agent composition root',
        );
      }
      return options.remote.confirmRemoteSha(remote, branch, expectedSha);
    },
  };

  const repairCi: RepairCycleCiPort = {
    observe: async (taskId) => {
      const { checksService: observer, context } = await resolveCiContext(taskId, 'RepairCi');
      const summary = await observer.observeRequiredChecks(context);
      return summary.outcome;
    },
  };

  return new TaskRunner({
    audit: audit as AuditRepository,
    locks,
    workspaces,
    mutations,
    verification: repairVerification,
    git: repairGit,
    ci: repairCi,
    repoResolve,
    repoFetch,
    workspaceCreate,
    instructions,
    analyze,
    modify,
    verify,
    publish,
    prEnsure,
    ciObserve,
    complete,
  });
}
