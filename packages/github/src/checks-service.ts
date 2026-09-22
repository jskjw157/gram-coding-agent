import type { TaskId } from '@gram/domain';
import type { TaskRepository } from '@gram/persistence';

export type RequiredCheckStatus = 'queued' | 'in_progress' | 'completed';

export interface RequiredCheckSnapshot {
  providerRunId?: string | null;
  providerCheckId: string;
  workflowName?: string | null;
  checkName: string;
  status: RequiredCheckStatus;
  conclusion?: string | null;
  url?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface CiPullRequestContext {
  taskId: TaskId;
  pullRequestId: number;
  owner: string;
  name: string;
  number: number;
  headSha: string;
  baseBranch: string;
}

export interface ChecksClientPort {
  listRequiredChecks(
    pullRequest: CiPullRequestContext,
  ): Promise<RequiredCheckSnapshot[]>;
}

export interface CiRunPersistencePort {
  upsertCheck(input: {
    taskId: TaskId;
    pullRequestId: number;
    providerRunId?: string | null;
    providerCheckId: string;
    workflowName?: string | null;
    checkName: string;
    status: string;
    conclusion?: string | null;
    url?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): unknown;
}

export interface CiCompletionPort {
  complete(taskId: TaskId): void | Promise<void>;
}

export interface DelayPort {
  wait(milliseconds: number): Promise<void>;
}

export interface CiSummary {
  outcome: 'SUCCESS' | 'FAILURE' | 'PENDING';
  attempts: number;
  checks: RequiredCheckSnapshot[];
}

export interface ChecksServiceOptions {
  client: ChecksClientPort;
  persistence: CiRunPersistencePort;
  completion: CiCompletionPort;
  delay?: DelayPort;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

const nativeDelay: DelayPort = {
  wait(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

function isSuccess(check: RequiredCheckSnapshot): boolean {
  return check.status === 'completed' && check.conclusion === 'success';
}

function isFailure(check: RequiredCheckSnapshot): boolean {
  return (
    check.status === 'completed' &&
    check.conclusion !== null &&
    check.conclusion !== undefined &&
    FAILURE_CONCLUSIONS.has(check.conclusion)
  );
}

export class ChecksService {
  private readonly delay: DelayPort;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: ChecksServiceOptions) {
    this.delay = options.delay ?? nativeDelay;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error('pollIntervalMs must be non-negative');
    }
  }

  async observeRequiredChecks(
    pullRequest: CiPullRequestContext,
  ): Promise<CiSummary> {
    if (!/^[0-9a-f]{40}$/.test(pullRequest.headSha)) {
      throw new Error('CI observation requires a full lowercase head SHA');
    }

    let latest: RequiredCheckSnapshot[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      latest = await this.options.client.listRequiredChecks(pullRequest);
      for (const check of latest) {
        this.options.persistence.upsertCheck({
          taskId: pullRequest.taskId,
          pullRequestId: pullRequest.pullRequestId,
          ...(check.providerRunId === undefined
            ? {}
            : { providerRunId: check.providerRunId }),
          providerCheckId: check.providerCheckId,
          ...(check.workflowName === undefined
            ? {}
            : { workflowName: check.workflowName }),
          checkName: check.checkName,
          status: check.status,
          ...(check.conclusion === undefined
            ? {}
            : { conclusion: check.conclusion }),
          ...(check.url === undefined ? {} : { url: check.url }),
          ...(check.startedAt === undefined
            ? {}
            : { startedAt: check.startedAt }),
          ...(check.finishedAt === undefined
            ? {}
            : { finishedAt: check.finishedAt }),
        });
      }

      if (latest.some(isFailure)) {
        return { outcome: 'FAILURE', attempts: attempt, checks: latest };
      }

      if (latest.length > 0 && latest.every(isSuccess)) {
        await this.options.completion.complete(pullRequest.taskId);
        return { outcome: 'SUCCESS', attempts: attempt, checks: latest };
      }

      if (attempt < this.maxAttempts) {
        await this.delay.wait(this.pollIntervalMs);
      }
    }

    return {
      outcome: 'PENDING',
      attempts: this.maxAttempts,
      checks: latest,
    };
  }
}

export class PersistentCiCompletion implements CiCompletionPort {
  constructor(private readonly tasks: TaskRepository) {}

  complete(taskId: TaskId): void {
    const task = this.tasks.get(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'COMPLETED') return;
    if (task.status !== 'PUBLISHING') {
      throw new Error(
        `CI completion requires PUBLISHING task state; got ${task.status}`,
      );
    }
    this.tasks.transition(taskId, 'PUBLISHING', 'COMPLETED');
  }
}
