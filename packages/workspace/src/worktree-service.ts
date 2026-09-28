import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskId } from '@gram/domain';
import { WorkspaceRepository } from '@gram/persistence';

export type TaskBranchType = 'FIX' | 'FEATURE' | 'CHORE';

export interface CreateTaskBranchNameInput {
  taskType: TaskBranchType;
  displaySequence: number;
  goal: string;
}

export function createTaskBranchName(input: CreateTaskBranchNameInput): string {
  if (!Number.isSafeInteger(input.displaySequence) || input.displaySequence <= 0) {
    throw new Error('displaySequence must be a positive safe integer');
  }

  const prefix: Record<TaskBranchType, 'fix' | 'feat' | 'chore'> = {
    FIX: 'fix',
    FEATURE: 'feat',
    CHORE: 'chore',
  };
  const slug =
    input.goal
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task';
  const display = String(input.displaySequence).padStart(6, '0');
  return `${prefix[input.taskType]}/task-${display}-${slug}`;
}

export interface GitWorktreePort {
  createWorktree(input: {
    repoPath: string;
    worktreePath: string;
    baseRef: string;
    branch: string;
    taskId: TaskId;
  }): Promise<{ headSha: string }>;
  removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    taskId: TaskId;
  }): Promise<void>;
  pruneWorktrees(input: { repoPath: string; taskId: TaskId }): Promise<void>;
}

export interface WorkspacePathMapper {
  toWindows(linuxPath: string, taskId: TaskId): Promise<string>;
}

export interface WorktreeRepositoryRef {
  githubRepositoryId: number;
  localBasePath: string;
}

export interface CreateWorktreeInput {
  taskId: TaskId;
  repo: WorktreeRepositoryRef;
  baseRef: string;
  branch: string;
}

export interface Workspace {
  taskId: TaskId;
  repoId: number;
  linuxPath: string;
  windowsPath: string;
  branch: string;
  headSha: string;
}

export interface WorktreeServiceOptions {
  homeDir: string;
  git: GitWorktreePort;
  workspaces: WorkspaceRepository;
  pathMapper: WorkspacePathMapper;
}

export class WorktreeService {
  constructor(private readonly options: WorktreeServiceOptions) {}

  async create(input: CreateWorktreeInput): Promise<Workspace> {
    const linuxPath = join(
      this.options.homeDir,
      '.gram-agent',
      'worktrees',
      String(input.repo.githubRepositoryId),
      input.taskId,
    );
    const windowsPath = await this.options.pathMapper.toWindows(linuxPath, input.taskId);

    mkdirSync(dirname(linuxPath), { recursive: true, mode: 0o700 });
    const created = await this.options.git.createWorktree({
      repoPath: input.repo.localBasePath,
      worktreePath: linuxPath,
      baseRef: input.baseRef,
      branch: input.branch,
      taskId: input.taskId,
    });

    try {
      this.options.workspaces.create({
        taskId: input.taskId,
        repoId: input.repo.githubRepositoryId,
        linuxPath,
        windowsPath,
        branch: input.branch,
        headSha: created.headSha,
      });
    } catch (error) {
      try {
        await this.options.git.removeWorktree({
          repoPath: input.repo.localBasePath,
          worktreePath: linuxPath,
          taskId: input.taskId,
        });
      } catch {
        // Never mask the original persistence error with a rollback failure.
      }
      try {
        await this.options.git.pruneWorktrees({
          repoPath: input.repo.localBasePath,
          taskId: input.taskId,
        });
      } catch {
        // Never mask the original persistence error with a rollback failure.
      }
      throw error;
    }

    return {
      taskId: input.taskId,
      repoId: input.repo.githubRepositoryId,
      linuxPath,
      windowsPath,
      branch: input.branch,
      headSha: created.headSha,
    };
  }
}
