import { runGit, type GitCommandRunnerPort, type GitTaskContext } from './command.js';

export class CommitService {
  constructor(
    private readonly runner: GitCommandRunnerPort,
    private readonly context: GitTaskContext,
  ) {}

  async commitExplicit(
    worktree: string,
    paths: readonly string[],
    message: string,
  ): Promise<string> {
    if (paths.length === 0) {
      throw new Error('commitExplicit requires at least one explicit path');
    }

    await runGit(this.runner, this.context, worktree, ['add', '--', ...paths]);
    await runGit(this.runner, this.context, worktree, [
      'commit',
      '--only',
      '-m',
      message,
      '--',
      ...paths,
    ]);
    const head = await runGit(this.runner, this.context, worktree, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }
}
