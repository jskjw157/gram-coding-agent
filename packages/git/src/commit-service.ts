import { runGit, type GitCommandRunnerPort, type GitTaskContext } from './command.js';

export class CommitService {
  constructor(
    private readonly runner: GitCommandRunnerPort,
    private readonly context: GitTaskContext,
  ) {}

  async commitExplicit(
    worktree: string,
    _paths: readonly string[],
    message: string,
  ): Promise<string> {
    await runGit(this.runner, this.context, worktree, ['add', '--', '.']);
    await runGit(this.runner, this.context, worktree, ['commit', '-m', message]);
    const head = await runGit(this.runner, this.context, worktree, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }
}
