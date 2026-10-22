import { canTransitionTaskStatus } from '@gram/domain';
import type { AuditRepository, CommandRunRepository, RepositoryRepository, StoredRepository, TaskRepository, WorkspaceRepository } from '@gram/persistence';

export type LocalCommandName = 'lint' | 'test' | 'build' | 'dev';
export interface LocalCommandInput { repositoryId: number; command: LocalCommandName; timeoutMs: number }
export interface LocalCommandResult {
  taskId: string; commandRunId: number; status: 'SUCCEEDED' | 'FAILED'; exitCode: number;
  stdout: string; stderr: string; truncated: boolean;
}
export interface LocalCommandDispatcherOptions {
  tasks: TaskRepository;
  repositories: Pick<RepositoryRepository, 'getById'>;
  workspaces: Pick<WorkspaceRepository, 'getByTaskId'>;
  commandRuns: Pick<CommandRunRepository, 'get'>;
  audit: Pick<AuditRepository, 'append'>;
  locks: { acquire(repositoryId: number, taskId: string): Promise<{ release(): Promise<void> }> };
  ownsLease(taskId: string, repositoryId: number): boolean;
  prepare(taskId: string, repository: StoredRepository): Promise<void>;
  execute(request: { taskId: string; cwd: string; executable: 'npm' | 'pnpm'; args: readonly string[]; timeoutMs: number }): Promise<{
    commandRunId: number; exitCode: number; stdout: string; stderr: string;
  }>;
}
const denied = () => new Error('Local command denied or failed');
export function declaredLocalCommand(repository: StoredRepository, name: LocalCommandName): { executable: 'npm' | 'pnpm'; args: string[] } {
  if (!['lint', 'test', 'build', 'dev'].includes(name)) throw denied();
  if (repository.packageManager === 'npm' && repository.commands[name] === `npm run ${name}`) return { executable: 'npm', args: ['run', name] };
  if (repository.packageManager === 'pnpm' && repository.commands[name] === `pnpm ${name}`) return { executable: 'pnpm', args: ['run', name] };
  throw denied();
}
/** Explicit dispatcher, separate from the coding scheduler and publication graph.
 * Trusted composition must use a real worktree creator and isolated command
 * runner. Successful receipts are cross-checked against persisted command_runs. */
export class LocalCommandDispatcher {
  constructor(private readonly options: LocalCommandDispatcherOptions) {}
  async run(input: LocalCommandInput): Promise<LocalCommandResult> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 900_000) throw denied();
    const repository = this.options.repositories.getById(input.repositoryId);
    if (!repository) throw denied();
    const command = declaredLocalCommand(repository, input.command);
    const task = this.options.tasks.create({ repoId: input.repositoryId, taskType: 'LOCAL_COMMAND',
      goal: `Run local ${input.command} on clean committed snapshot`, publishMode: 'PULL_REQUEST',
      metadata: { localCommand: input.command, packageManager: command.executable } });
    this.options.tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
    let lease: { release(): Promise<void> } | undefined;
    try {
      lease = await this.options.locks.acquire(input.repositoryId, task.id);
      const current = this.options.repositories.getById(input.repositoryId);
      if (!current || current.localBasePath !== repository.localBasePath ||
          current.owner !== repository.owner || current.name !== repository.name ||
          current.defaultBranch !== repository.defaultBranch ||
          JSON.stringify(declaredLocalCommand(current, input.command)) !== JSON.stringify(command) ||
          !this.options.ownsLease(task.id, input.repositoryId) || this.options.tasks.get(task.id)?.status !== 'PREPARING') throw denied();
      await this.options.prepare(task.id, current);
      const workspace = this.options.workspaces.getByTaskId(task.id);
      if (!workspace || workspace.repoId !== input.repositoryId || workspace.recoveryState !== null ||
          !this.options.ownsLease(task.id, input.repositoryId)) throw denied();
      this.options.tasks.transition(task.id, 'PREPARING', 'RUNNING');
      this.options.audit.append({ taskId: task.id, eventType: 'LOCAL_COMMAND_STARTED',
        payload: { repositoryId: input.repositoryId, command: input.command, timeoutMs: input.timeoutMs, snapshot: 'clean-committed-head' } });
      const result = await this.options.execute({ taskId: task.id, cwd: workspace.linuxPath, ...command, timeoutMs: input.timeoutMs });
      const stored = this.options.commandRuns.get(result.commandRunId);
      const status = result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
      if (!this.options.ownsLease(task.id, input.repositoryId) || !stored ||
          stored.taskId !== task.id || stored.cwd !== workspace.linuxPath || stored.category !== 'DEVELOPMENT' ||
          stored.executable !== command.executable || stored.shellText !== null ||
          JSON.stringify(stored.args) !== JSON.stringify(command.args) || stored.status !== status ||
          stored.exitCode !== result.exitCode || !stored.finishedAt) throw denied();
      if (result.exitCode === 0) this.options.tasks.completeLocalCommand(task.id, result.commandRunId);
      else this.options.tasks.transition(task.id, 'RUNNING', 'FAILED');
      this.options.audit.append({ taskId: task.id, eventType: 'LOCAL_COMMAND_FINISHED',
        payload: { commandRunId: result.commandRunId, status, exitCode: result.exitCode } });
      return { taskId: task.id, commandRunId: result.commandRunId, status, exitCode: result.exitCode,
        stdout: result.stdout, stderr: result.stderr, truncated: stored.truncated };
    } catch {
      const current = this.options.tasks.get(task.id);
      if (current && canTransitionTaskStatus(current.status, 'FAILED')) this.options.tasks.transition(task.id, current.status, 'FAILED');
      this.options.audit.append({ taskId: task.id, eventType: 'LOCAL_COMMAND_FAILED', payload: { command: input.command } });
      throw denied();
    } finally { if (lease) await lease.release(); }
  }
}
