import type { TaskId } from "@gram/domain";

// Typed orchestration DTOs (all readonly) for the task runner vertical slice.
// These types carry identifiers, paths, and results only. They never carry
// secrets, tokens, or credentials of any kind.

export type TaskCiOutcome = "SUCCESS" | "FAILURE" | "PENDING";

export interface ResolvedTask {
  readonly taskId: TaskId;
  readonly repoId: number;
  readonly branch: string;
  readonly remote: string;
  readonly localBasePath: string;
}

export interface TaskWorkspace {
  readonly linuxPath: string;
  readonly branch: string;
}

export interface RepositoryInstructions {
  readonly content: string;
  readonly source: string;
}

export interface TaskAnalysis {
  readonly summary: string;
  readonly files: readonly string[];
}

export interface ModificationResult {
  readonly sha: string;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly output: string;
  readonly headSha?: string;
  readonly approvedPaths?: readonly string[];
}

export interface PublishedTask {
  readonly taskId: TaskId;
  readonly sha: string;
  readonly branch: string;
  readonly remote: string;
}

export interface TaskPullRequest {
  readonly number: number;
  readonly url: string;
}

export interface TaskPublishLease {
  release(): Promise<void>;
}

export interface RepoResolvePort {
  resolve(taskId: TaskId): Promise<ResolvedTask>;
}

export interface RepoFetchPort {
  fetch(task: ResolvedTask): Promise<void>;
}

export interface WorkspaceCreatePort {
  create(taskId: TaskId): Promise<TaskWorkspace>;
}

export interface InstructionsPort {
  load(workspace: TaskWorkspace): Promise<RepositoryInstructions>;
}

export interface AnalyzePort {
  analyze(input: {
    readonly task: ResolvedTask;
    readonly workspace: TaskWorkspace;
    readonly instructions: RepositoryInstructions;
  }): Promise<TaskAnalysis>;
}

export interface ModifyPort {
  modify(input: {
    readonly task: ResolvedTask;
    readonly workspace: TaskWorkspace;
    readonly analysis: TaskAnalysis;
  }): Promise<ModificationResult>;
}

export interface VerifyPort {
  verify(taskId: TaskId): Promise<VerificationResult>;
}

// Publication owns lock release: the implementation confirms the remote push
// before releasing the lease, mirroring RepairCycle lock release ordering.
export interface PublishPort {
  publish(
    task: ResolvedTask,
    workspace: TaskWorkspace,
    verification: VerificationResult,
    lease: TaskPublishLease,
  ): Promise<PublishedTask>;
}

// Runs after the repository mutation lock is released. Never hold the
// mutation lock while ensuring the pull request.
export interface PrEnsurePort {
  ensure(task: ResolvedTask, published: PublishedTask): Promise<TaskPullRequest>;
}

// Runs after the repository mutation lock is released. Never hold the
// mutation lock while observing CI.
export interface CiObservePort {
  observe(taskId: TaskId): Promise<TaskCiOutcome>;
}

export interface CompletePort {
  complete(taskId: TaskId): Promise<void>;
}
