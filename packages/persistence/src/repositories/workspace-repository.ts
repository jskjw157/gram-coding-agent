import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface CreateWorkspaceInput {
  taskId: TaskId;
  repoId: number;
  linuxPath: string;
  windowsPath?: string | null;
  branch: string;
  headSha?: string | null;
}

export interface StoredWorkspace {
  id: number;
  taskId: TaskId;
  repoId: number;
  linuxPath: string;
  windowsPath: string | null;
  branch: string;
  headSha: string | null;
  dirty: boolean;
  unpushed: boolean;
  recoveryState: string | null;
  cleanupAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: number;
  task_id: TaskId;
  repo_id: number;
  linux_path: string;
  windows_path: string | null;
  branch: string;
  head_sha: string | null;
  dirty: number;
  unpushed: number;
  recovery_state: string | null;
  cleanup_after: string | null;
  created_at: string;
  updated_at: string;
}

function decode(row: WorkspaceRow): StoredWorkspace {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    linuxPath: row.linux_path,
    windowsPath: row.windows_path,
    branch: row.branch,
    headSha: row.head_sha,
    dirty: row.dirty === 1,
    unpushed: row.unpushed === 1,
    recoveryState: row.recovery_state,
    cleanupAfter: row.cleanup_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateWorkspaceInput): StoredWorkspace {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO workspaces(
          task_id, repo_id, linux_path, windows_path, branch, head_sha,
          dirty, unpushed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `)
      .run(
        input.taskId,
        input.repoId,
        input.linuxPath,
        input.windowsPath ?? null,
        input.branch,
        input.headSha ?? null,
        now,
        now,
      );

    const stored = this.getByTaskId(input.taskId);
    if (stored === undefined) throw new Error('Workspace row was not persisted');
    return stored;
  }

  getByTaskId(taskId: TaskId): StoredWorkspace | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE task_id = ?')
      .get(taskId) as WorkspaceRow | undefined;
    return row === undefined ? undefined : decode(row);
  }
}
