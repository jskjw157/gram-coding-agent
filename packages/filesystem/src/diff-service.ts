import type { TaskId } from '@gram/domain';
import type { TaskCommandPort } from './task-command-port.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

export interface DiffServiceOptions {
  guard: WorkspacePathGuard;
  commands: TaskCommandPort;
}

export class DiffService {
  constructor(private readonly options: DiffServiceOptions) {}

  async diff(taskId: TaskId, relativePath: string): Promise<string> {
    const workspaceRoot = this.options.guard.resolveExisting(taskId, '.');
    this.options.guard.resolveExisting(taskId, relativePath);

    const result = await this.options.commands.run({
      taskId,
      cwd: workspaceRoot,
      category: 'GIT',
      executable: 'git',
      args: ['diff', '--', relativePath],
    });
    return result.stdout;
  }
}
