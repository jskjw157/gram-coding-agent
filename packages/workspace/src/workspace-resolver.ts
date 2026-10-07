import type { TaskId } from '@gram/domain';
import { WorkspaceRepository, type StoredWorkspace } from '@gram/persistence';

export class WorkspaceNotFoundError extends Error {
  constructor(taskId: TaskId) {
    super(`Workspace not found for task ${taskId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceResolver {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  resolve(taskId: TaskId): StoredWorkspace {
    const workspace = this.workspaces.getByTaskId(taskId);
    if (workspace === undefined) throw new WorkspaceNotFoundError(taskId);
    return workspace;
  }
}
