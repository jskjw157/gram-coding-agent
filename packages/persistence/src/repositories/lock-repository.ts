import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface AcquireRepoLeaseInput {
  repoId: number;
  taskId: TaskId;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseUntil: string;
  ownerPid: number;
  ownerBootId: string;
}

export interface StoredRepoLease {
  repoId: number;
  ownerTaskId: TaskId;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseUntil: string;
  ownerPid: number;
  ownerBootId: string;
}

export class RepoLeaseConflictError extends Error {
  constructor(repoId: number) {
    super(`Repository ${repoId} already has an active lease`);
    this.name = 'RepoLeaseConflictError';
  }
}

export class TaskNotWaitingForRepoLockError extends Error {
  constructor(taskId: TaskId) {
    super(`Task ${taskId} is not waiting for the repository lock`);
    this.name = 'TaskNotWaitingForRepoLockError';
  }
}

interface RepoLeaseRow {
  repo_id: number;
  owner_task_id: TaskId;
  lease_token: string;
  acquired_at: string;
  heartbeat_at: string;
  lease_until: string;
  owner_pid: number;
  owner_boot_id: string;
}

function decode(row: RepoLeaseRow): StoredRepoLease {
  return {
    repoId: row.repo_id,
    ownerTaskId: row.owner_task_id,
    leaseToken: row.lease_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    leaseUntil: row.lease_until,
    ownerPid: row.owner_pid,
    ownerBootId: row.owner_boot_id,
  };
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

export class LockRepository {
  constructor(private readonly db: Database.Database) {}

  acquireAndPrepare(input: AcquireRepoLeaseInput): StoredRepoLease {
    const transaction = this.db.transaction((value: AcquireRepoLeaseInput) => {
      this.db
        .prepare(`
          INSERT INTO repo_locks(
            repo_id, owner_task_id, lease_token, acquired_at, heartbeat_at,
            lease_until, owner_pid, owner_boot_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          value.repoId,
          value.taskId,
          value.leaseToken,
          value.acquiredAt,
          value.heartbeatAt,
          value.leaseUntil,
          value.ownerPid,
          value.ownerBootId,
        );

      const transitioned = this.db
        .prepare(`
          UPDATE tasks
          SET status = 'PREPARING', updated_at = ?
          WHERE id = ? AND repo_id = ? AND status = 'WAITING_REPO_LOCK'
        `)
        .run(value.acquiredAt, value.taskId, value.repoId);

      if (transitioned.changes !== 1) {
        throw new TaskNotWaitingForRepoLockError(value.taskId);
      }

      const stored = this.get(value.repoId);
      if (stored === undefined) throw new Error('repo lease was not persisted');
      return stored;
    });

    try {
      return transaction.immediate(input);
    } catch (error) {
      if (error instanceof TaskNotWaitingForRepoLockError) throw error;
      if (isConstraintError(error)) throw new RepoLeaseConflictError(input.repoId);
      throw error;
    }
  }

  get(repoId: number): StoredRepoLease | undefined {
    const row = this.db
      .prepare('SELECT * FROM repo_locks WHERE repo_id = ?')
      .get(repoId) as RepoLeaseRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  heartbeat(repoId: number, leaseToken: string, heartbeatAt: string, leaseUntil: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE repo_locks
        SET heartbeat_at = ?, lease_until = ?
        WHERE repo_id = ? AND lease_token = ?
      `)
      .run(heartbeatAt, leaseUntil, repoId, leaseToken);
    return result.changes === 1;
  }

  release(repoId: number, leaseToken: string): boolean {
    const result = this.db
      .prepare('DELETE FROM repo_locks WHERE repo_id = ? AND lease_token = ?')
      .run(repoId, leaseToken);
    return result.changes === 1;
  }
}
