import type { TaskId } from '@gram/domain';
import type { CiPullRequestContext } from '@gram/github';
import type { CompletionEvaluator } from '@gram/verification';
import type {
  BoundVerificationPlan,
  VerificationRepository,
  GitCommitRepository,
  PullRequestRepository,
  RepositoryRepository,
  TaskRepository,
} from '@gram/persistence';
import { TaskRunnerConfigurationError } from './task-runner-composition.js';
import type {
  CompositionCiContext,
  CompositionRepoProfile,
  CompositionRepoProfiles,
  CompositionVerification,
} from './task-runner-composition.js';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Typed failure for a repository selector that matches no registered row.
 * Unknown selectors are never fabricated into a profile.
 */
export class UnknownRepositorySelectorError extends Error {
  readonly selector: string;

  constructor(selector: string) {
    super(`Unknown repository selector: ${selector}`);
    this.name = 'UnknownRepositorySelectorError';
    this.selector = selector;
  }
}

export interface RepositoryProfileDeps {
  repositories: RepositoryRepository;
  tasks: TaskRepository;
}

/**
 * Persistence-backed repository profiles for the composition's
 * repository-resolution port (`CompositionRepoProfiles.resolve`).
 *
 * Lookup is delegated to `RepositoryRepository.findBySelector`, which handles
 * both `owner/name` selectors and bare-name selectors (the latter throws the
 * repository's own `AmbiguousRepositorySelectorError` when ambiguous, which
 * propagates as a typed failure). An selector matching no row throws
 * `UnknownRepositorySelectorError`; no profile is ever synthesized.
 */
export class RegisteredRepositoryProfiles implements CompositionRepoProfiles {
  constructor(private readonly deps: RepositoryProfileDeps) {}

  async resolve(selector: string): Promise<CompositionRepoProfile> {
    const stored = this.deps.repositories.findBySelector(selector);
    if (stored === undefined) {
      throw new UnknownRepositorySelectorError(selector);
    }
    return {
      githubRepositoryId: stored.githubRepositoryId,
      owner: stored.owner,
      name: stored.name,
      defaultBranch: stored.defaultBranch,
      localBasePath: stored.localBasePath,
    };
  }

  /**
   * Resolves the calling task's own `repoSelector` and persists the binding
   * via `TaskRepository.bindRepository` (idempotent for the same repo,
   * conflict-typed for a different one). Must run before lock acquisition:
   * `LockRepository.acquireAndPrepare` only transitions tasks whose stored
   * `repo_id` already equals the locked repo.
   */
  async resolveAndBind(taskId: TaskId): Promise<CompositionRepoProfile> {
    const task = this.deps.tasks.get(taskId);
    if (task === null) {
      throw new TaskRunnerConfigurationError(
        'RegisteredRepositoryProfiles',
        `task not found: ${taskId}`,
      );
    }
    const selector = task.repoSelector;
    if (selector === null || selector.trim().length === 0) {
      throw new TaskRunnerConfigurationError(
        'RegisteredRepositoryProfiles',
        `task ${taskId} has no repository selector`,
      );
    }
    const profile = await this.resolve(selector);
    this.deps.tasks.bindRepository(taskId, profile.githubRepositoryId);
    return profile;
  }
}

/** Reads one sealed plan; unbound historical evidence never authorizes publication. */
export class PersistentVerificationCompletion implements CompositionVerification {
  constructor(
    // Retained for source compatibility with diagnostic callers; not a publish fallback.
    _evaluator: CompletionEvaluator,
    private readonly repository?: Pick<VerificationRepository, 'getBoundPlan'>,
  ) {}

  getVerifiedPlan(taskId: TaskId, headSha: string): BoundVerificationPlan | undefined {
    return this.repository?.getBoundPlan(taskId, headSha);
  }

  requiredChecksPassed(taskId: TaskId, headSha?: string): boolean {
    return headSha !== undefined && this.getVerifiedPlan(taskId, headSha) !== undefined;
  }

  listApprovedPaths(taskId: TaskId, headSha?: string): readonly string[] {
    return headSha === undefined ? [] : this.getVerifiedPlan(taskId, headSha)?.approvedPaths ?? [];
  }
}

/**
 * Typed fail-closed failure for CI context resolution. Every cause (unbound
 * task, missing rows, unconfirmed commit, malformed SHA) carries a reason;
 * the resolver never guesses or synthesizes a value.
 */
export class PersistentCiContextError extends Error {
  readonly taskId: TaskId;
  readonly reason: string;

  constructor(taskId: TaskId, reason: string) {
    super(`Cannot resolve CI context for task ${taskId}: ${reason}`);
    this.name = 'PersistentCiContextError';
    this.taskId = taskId;
    this.reason = reason;
  }
}

export interface CiContextResolverDeps {
  tasks: TaskRepository;
  repositories: RepositoryRepository;
  pullRequests: PullRequestRepository;
  gitCommits: GitCommitRepository;
}

/**
 * Persistence-only CI context for the composition's CI port
 * (`CompositionCiContext.resolve`). Requires ALL of:
 * - the task exists, is bound to a repository (`repoId` non-null), and the
 *   repository row exists,
 * - a pull request is persisted for the task (latest by row id),
 * - a git commit is persisted for the task (latest via
 *   `GitCommitRepository.getLatestForTask`), is remote-confirmed, and carries
 *   a full lowercase 40-hex SHA.
 * Anything missing or unconfirmed throws `PersistentCiContextError`.
 */
export class PersistentCiContextResolver implements CompositionCiContext {
  constructor(private readonly deps: CiContextResolverDeps) {}

  async resolve(taskId: TaskId): Promise<CiPullRequestContext> {
    const task = this.deps.tasks.get(taskId);
    if (task === null) {
      throw new PersistentCiContextError(taskId, 'task not found');
    }
    if (task.repoId === null) {
      throw new PersistentCiContextError(taskId, 'task is not bound to a repository');
    }
    const repository = this.deps.repositories.getById(task.repoId);
    if (repository === undefined) {
      throw new PersistentCiContextError(
        taskId,
        `repository row ${task.repoId} is missing`,
      );
    }
    const pullRequest = this.deps.pullRequests.getLatestForTask(taskId);
    if (pullRequest === undefined) {
      throw new PersistentCiContextError(taskId, 'no pull request persisted for task');
    }
    const commit = this.deps.gitCommits.getLatestForTask(taskId);
    if (commit === undefined) {
      throw new PersistentCiContextError(taskId, 'no git commit persisted for task');
    }
    if (commit.remoteConfirmed !== true) {
      throw new PersistentCiContextError(
        taskId,
        `latest commit ${commit.sha} is not remote-confirmed`,
      );
    }
    if (FULL_SHA_RE.test(commit.sha) === false) {
      throw new PersistentCiContextError(
        taskId,
        `latest commit SHA is not a full lowercase SHA: ${commit.sha}`,
      );
    }
    return {
      taskId,
      pullRequestId: pullRequest.id,
      owner: repository.owner,
      name: repository.name,
      number: pullRequest.number,
      headSha: commit.sha,
      baseBranch: pullRequest.baseBranch,
    };
  }
}
