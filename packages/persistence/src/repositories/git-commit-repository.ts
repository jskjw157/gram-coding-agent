import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface RecordGitCommitInput {
  taskId: TaskId;
  repoId: number;
  sha: string;
  branch: string;
  remoteName?: string;
  createdAt?: string;
}

export interface StoredGitCommit {
  id: number;
  taskId: TaskId;
  repoId: number;
  sha: string;
  branch: string;
  remoteName: string;
  remoteConfirmed: boolean;
  remoteConfirmedAt: string | null;
  createdAt: string;
}

interface GitCommitRow {
  id: number;
  task_id: TaskId;
  repo_id: number;
  sha: string;
  branch: string;
  remote_name: string;
  remote_confirmed: number;
  remote_confirmed_at: string | null;
  created_at: string;
}

function decode(row: GitCommitRow): StoredGitCommit {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    sha: row.sha,
    branch: row.branch,
    remoteName: row.remote_name,
    remoteConfirmed: row.remote_confirmed === 1,
    remoteConfirmedAt: row.remote_confirmed_at,
    createdAt: row.created_at,
  };
}

export class GitCommitRepository {
  constructor(private readonly db: Database.Database) {}

  recordCreated(input: RecordGitCommitInput): number {
    if (!/^[0-9a-f]{40}$/.test(input.sha)) {
      throw new Error('Git commit SHA must be a full lowercase SHA');
    }
    if (input.branch.trim().length === 0) {
      throw new Error('Git commit branch must not be empty');
    }

    const result = this.db
      .prepare(`
        INSERT INTO git_commits(
          task_id, repo_id, sha, branch, remote_name, remote_confirmed, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
      `)
      .run(
        input.taskId,
        input.repoId,
        input.sha,
        input.branch,
        input.remoteName ?? 'origin',
        input.createdAt ?? new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  markRemoteConfirmed(id: number, confirmedAt = new Date().toISOString()): void {
    const result = this.db
      .prepare(`
        UPDATE git_commits
        SET remote_confirmed = 1,
            remote_confirmed_at = ?
        WHERE id = ? AND remote_confirmed = 0
      `)
      .run(confirmedAt, id);
    if (result.changes !== 1) {
      throw new Error(`Git commit ${id} is missing or already remote-confirmed`);
    }
  }

  get(id: number): StoredGitCommit | undefined {
    const row = this.db
      .prepare('SELECT * FROM git_commits WHERE id = ?')
      .get(id) as GitCommitRow | undefined;
    return row === undefined ? undefined : decode(row);
  }
}
