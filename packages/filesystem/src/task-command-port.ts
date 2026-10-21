import type { TaskId } from '@gram/domain';

export interface TaskCommandRequest {
  taskId: TaskId;
  cwd: string;
  category: 'FILESYSTEM' | 'GIT';
  executable: string;
  args: readonly string[];
}

export interface TaskCommandResult {
  stdout: string;
}

export interface TaskCommandPort {
  run(request: TaskCommandRequest): Promise<TaskCommandResult>;
}
