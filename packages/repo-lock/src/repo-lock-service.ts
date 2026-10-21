import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TaskId, TaskStatus } from '@gram/domain';
import {
  LockRepository,
  RepoLeaseConflictError,
  TaskRepository,
} from '@gram/persistence';
import {
  LeaseHeartbeat,
  nativeIntervalScheduler,
  type IntervalScheduler,
} from './lease-heartbeat.js';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export class RepoLockedError extends Error {
  readonly code = 'REPO_LOCKED';
  readonly repoId: number;
  constructor(repoId: number) {
    super(`Repository ${repoId} is locked by another task`);
    this.name = 'RepoLockedError';
    this.repoId = repoId;
  }
}

export function isRepoLockedError(error: unknown): boolean {
  if (error instanceof RepoLockedError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if (!('code' in error)) return false;
  if (error.code !== 'REPO_LOCKED') return false;
  if (!('repoId' in error)) return false;
  if (typeof error.repoId !== 'number') return false;
  return true;
}

export class RepoLockLostError extends Error {
  constructor(repoId: number) {
    super(`Repository ${repoId} lease is no longer owned by this task`);
    this.name = 'RepoLockLostError';
  }
}

export interface RepoLockServiceOptions {
  locks: LockRepository;
  tasks: TaskRepository;
  lockDirectory: string;
  now?: () => Date;
  pid?: () => number;
  bootId?: () => string;
  scheduler?: IntervalScheduler;
  ttlMs?: number;
  heartbeatIntervalMs?: number;
}

export interface RepoLockLease {
  readonly repoId: number;
  readonly taskId: TaskId;
  readonly leaseToken: string;
  heartbeat(): Promise<void>;
  /**
   * Stop the background heartbeat while keeping the lease held.
   *
   * Quiescing is idempotent: calling it twice is a no-op. It touches
   * neither the lock file nor the SQLite lease row, so the lease remains
   * held and a later {@link release} still cleans up both. It never awaits
   * an in-flight heartbeat, so a beat already running cannot throw to the
   * quiesce caller.
   */
  quiesce(): Promise<void>;
  release(): Promise<void>;
}

function readBootId(): string {
  const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (value.length === 0) throw new Error('Linux boot ID is unavailable');
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}

function canMoveToRecovery(status: TaskStatus): boolean {
  return ['WAITING_REPO_LOCK', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING'].includes(status);
}

export class RepoLockService {
  private readonly now: () => Date;
  private readonly pid: () => number;
  private readonly bootId: () => string;
  private readonly scheduler: IntervalScheduler;
  private readonly ttlMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly options: RepoLockServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? (() => process.pid);
    this.bootId = options.bootId ?? readBootId;
    this.scheduler = options.scheduler ?? nativeIntervalScheduler;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  async acquire(repoId: number, taskId: TaskId): Promise<RepoLockLease> {
    mkdirSync(this.options.lockDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.options.lockDirectory, `${repoId}.lock`);
    const leaseToken = randomUUID();
    const acquired = this.now();
    const acquiredAt = acquired.toISOString();
    const ownerPid = this.pid();
    const ownerBootId = this.bootId();

    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(
        descriptor,
        JSON.stringify({
          taskId,
          leaseToken,
          pid: ownerPid,
          bootId: ownerBootId,
          acquiredAt,
        }),
        'utf8',
      );
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (isAlreadyExists(error)) throw new RepoLockedError(repoId);
      throw error;
    }
    if (descriptor !== undefined) closeSync(descriptor);

    try {
      this.options.locks.acquireAndPrepare({
        repoId,
        taskId,
        leaseToken,
        acquiredAt,
        heartbeatAt: acquiredAt,
        leaseUntil: new Date(acquired.getTime() + this.ttlMs).toISOString(),
        ownerPid,
        ownerBootId,
      });
    } catch (error) {
      rmSync(lockPath, { force: true });
      if (error instanceof RepoLeaseConflictError) throw new RepoLockedError(repoId);
      throw error;
    }

    let released = false;
    let quiesced = false;

    const moveTaskTowardRecovery = async (): Promise<void> => {
      const current = this.options.tasks.get(taskId);
      if (current === null || !canMoveToRecovery(current.status)) return;
      try {
        this.options.tasks.transition(taskId, current.status, 'NEEDS_RECOVERY');
      } catch {
        // Another durable transition won the race; recovery coordinator will inspect current state.
      }
    };

    const heartbeat = async (): Promise<void> => {
      try {
        const beatAt = this.now();
        const owned = this.options.locks.heartbeat(
          repoId,
          leaseToken,
          beatAt.toISOString(),
          new Date(beatAt.getTime() + this.ttlMs).toISOString(),
        );
        if (!owned) throw new RepoLockLostError(repoId);
      } catch (error) {
        await moveTaskTowardRecovery();
        throw error;
      }
    };

    const heartbeatTimer = new LeaseHeartbeat(
      this.scheduler,
      this.heartbeatIntervalMs,
      heartbeat,
      moveTaskTowardRecovery,
    );
    heartbeatTimer.start();

    return {
      repoId,
      taskId,
      leaseToken,
      heartbeat,
      quiesce: async () => {
        if (quiesced) return;
        quiesced = true;
        heartbeatTimer.stop();
        // The lease stays held, but no heartbeat may still be running once this
        // resolves: the caller may close SQLite immediately afterwards, and an
        // in-flight beat would otherwise touch the closed database.
        await heartbeatTimer.drain();
      },
      release: async () => {
        if (released) return;
        released = true;
        heartbeatTimer.stop();
        this.options.locks.release(repoId, leaseToken);

        try {
          const metadata = JSON.parse(readFileSync(lockPath, 'utf8')) as { leaseToken?: unknown };
          if (metadata.leaseToken === leaseToken) rmSync(lockPath, { force: true });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
            throw error;
          }
        }
      },
    };
  }
}
