import { canTransitionTaskStatus, type TaskId, type TaskStatus } from '@gram/domain';
import { isRepoLockedError } from '@gram/repo-lock';
import type { CompositionAuditPort } from './task-runner-composition.js';

/** Minimal runnable-task snapshot the scheduler may claim or dispatch. */
export interface RunnableTaskSnapshot {
  readonly id: TaskId;
  readonly status: TaskStatus;
}

/** Structural subset of TaskRepository used by the scheduler. */
export interface RunnableTaskStore {
  listRunnable(perStatusLimit: number): readonly RunnableTaskSnapshot[];
  get(id: TaskId): RunnableTaskSnapshot | null;
  transition(id: TaskId, from: TaskStatus, to: TaskStatus): void;
}

/** Downstream phase work. Faked in tests to control concurrency deterministically. */
export interface TaskSchedulerRunner {
  run(taskId: TaskId): Promise<void>;
}

/** Minimal logger surface used by the scheduler (compatible with StructuredLogger). */
export interface TaskSchedulerLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface TaskSchedulerInterval {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TaskSchedulerOptions {
  readonly tasks: RunnableTaskStore;
  readonly runner: TaskSchedulerRunner;
  readonly audit: CompositionAuditPort;
  readonly logger: TaskSchedulerLogger;
  readonly interval?: TaskSchedulerInterval;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly perStatusLimit?: number;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_PER_STATUS_LIMIT = 32;
const FAILURE_EVENT_TYPE = 'TASK_RUN_FAILED';

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}

/**
 * RepoLock-driven dispatcher. Concurrency between different repositories is
 * intended: there is deliberately NO global task queue and NO global run
 * mutex. Same-repo serialization comes from RepoLockService exclusively
 * (a second contender fails with RepoLockedError and stays queued). The only
 * module state is the per-task-id in-flight set (prevents double dispatch
 * across overlapping ticks) and the stopping/stopped flags.
 */
export class TaskScheduler {
  private readonly tasks: RunnableTaskStore;
  private readonly runner: TaskSchedulerRunner;
  private readonly audit: CompositionAuditPort;
  private readonly logger: TaskSchedulerLogger;
  private readonly clock: TaskSchedulerInterval;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly perStatusLimit: number;
  private readonly inFlight = new Set<TaskId>();
  private started = false;
  private stopping = false;
  private stopped = false;
  private handle: unknown = undefined;
  private drain: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(options: TaskSchedulerOptions) {
    this.tasks = options.tasks;
    this.runner = options.runner;
    this.audit = options.audit;
    this.logger = options.logger;
    this.clock = options.interval ?? {
      setInterval: (callback: () => void, ms: number): unknown =>
        globalThis.setInterval(callback, ms),
      clearInterval: (handle: unknown): void => {
        globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
      },
    };
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.perStatusLimit = options.perStatusLimit ?? DEFAULT_PER_STATUS_LIMIT;
  }

  start(): void {
    if (this.started || this.stopping || this.stopped) return;
    this.started = true;
    this.tick();
    if (this.stopping || this.stopped) return;
    this.handle = this.clock.setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  tick(): void {
    if (this.stopping || this.stopped) return;
    const candidates = this.tasks.listRunnable(this.perStatusLimit);
    for (const candidate of candidates) {
      if (this.stopping || this.stopped) return;
      const taskId = candidate.id;
      if (this.inFlight.has(taskId)) continue;
      if (candidate.status === 'QUEUED') {
        try {
          this.tasks.transition(taskId, 'QUEUED', 'WAITING_REPO_LOCK');
        } catch {
          continue;
        }
      } else if (candidate.status !== 'WAITING_REPO_LOCK') {
        continue;
      }
      this.inFlight.add(taskId);
      let pending: Promise<void>;
      try {
        pending = this.runner.run(taskId);
      } catch (error) {
        this.failTask(taskId, error);
        this.finish(taskId);
        continue;
      }
      pending.then(
        () => {
          this.finish(taskId);
        },
        (error: unknown) => {
          try {
            this.failTask(taskId, error);
          } finally {
            this.finish(taskId);
          }
        },
      );
    }
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.handle !== undefined) {
      this.clock.clearInterval(this.handle);
      this.handle = undefined;
    }
    if (this.drain === null) {
      if (this.inFlight.size === 0) {
        this.stopped = true;
        this.drain = Promise.resolve();
      } else {
        this.drain = new Promise<void>((resolve) => {
          this.drainResolve = resolve;
        });
      }
    }
    return this.drain;
  }

  private failTask(taskId: TaskId, error: unknown): void {
    if (isRepoLockedError(error)) return;
    const { name, message } = describeError(error);
    let current: RunnableTaskSnapshot | null;
    try {
      current = this.tasks.get(taskId);
    } catch {
      current = null;
    }
    const status = current?.status ?? null;
    if (current !== null && canTransitionTaskStatus(current.status, 'FAILED')) {
      try {
        this.tasks.transition(taskId, current.status, 'FAILED');
      } catch {
        // Lost a concurrent durable transition; still record the failure once.
      }
    }
    try {
      this.audit.append({
        taskId,
        eventType: FAILURE_EVENT_TYPE,
        payload: { errorName: name, errorMessage: message, status },
        createdAt: this.now().toISOString(),
      });
    } catch (appendError) {
      const described = describeError(appendError);
      this.logger.error(`task scheduler audit failed for ${taskId}`, {
        taskId,
        errorName: described.name,
        errorMessage: described.message,
      });
      return;
    }
    this.logger.error(`task run failed for ${taskId}`, {
      taskId,
      errorName: name,
      errorMessage: message,
      status,
    });
  }

  private finish(taskId: TaskId): void {
    this.inFlight.delete(taskId);
    if (this.stopping && this.inFlight.size === 0) {
      this.stopped = true;
      const resolve = this.drainResolve;
      this.drainResolve = null;
      if (resolve !== null) resolve();
    }
  }
}
