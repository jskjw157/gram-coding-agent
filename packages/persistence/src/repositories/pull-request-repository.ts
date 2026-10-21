import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface UpsertPullRequestInput {
  taskId: TaskId;
  repoId: number;
  providerId?: string | null;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  now?: string;
}

export interface StoredPullRequest {
  id: number;
  taskId: TaskId;
  repoId: number;
  providerId: string | null;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

interface PullRequestRow {
  id: number;
  task_id: TaskId;
  repo_id: number;
  provider_id: string | null;
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  state: string;
  created_at: string;
  updated_at: string;
}

function decode(row: PullRequestRow): StoredPullRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    providerId: row.provider_id,
    number: row.number,
    url: row.url,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PullRequestRepository {
  constructor(private readonly db: Database.Database) {}

  upsertForTask(input: UpsertPullRequestInput): StoredPullRequest {
    const now = input.now ?? new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO pull_requests(
          task_id, repo_id, provider_id, number, url, head_branch,
          base_branch, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, number) DO UPDATE SET
          task_id = excluded.task_id,
          provider_id = excluded.provider_id,
          url = excluded.url,
          head_branch = excluded.head_branch,
          base_branch = excluded.base_branch,
          state = excluded.state,
          updated_at = excluded.updated_at
      `)
      .run(
        input.taskId,
        input.repoId,
        input.providerId ?? null,
        input.number,
        input.url,
        input.headBranch,
        input.baseBranch,
        input.state,
        now,
        now,
      );

    const stored = this.getByRepoAndNumber(input.repoId, input.number);
    if (stored === undefined) throw new Error('Pull request row was not persisted');
    return stored;
  }

  getByRepoAndNumber(repoId: number, number: number): StoredPullRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, number) as PullRequestRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  getLatestForTask(taskId: TaskId): StoredPullRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM pull_requests WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as PullRequestRow | undefined;
    return row === undefined ? undefined : decode(row);
  }
}
