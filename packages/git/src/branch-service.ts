import { runGit, type GitCommandRunnerPort, type GitTaskContext } from './command.js';

export class BranchService {
  constructor(
    private readonly runner: GitCommandRunnerPort,
    private readonly context: GitTaskContext,
  ) {}

  async current(worktree: string): Promise<string> {
    const result = await runGit(this.runner, this.context, worktree, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    return result.stdout.trim();
  }

  async listLocal(worktree: string): Promise<string[]> {
    const result = await runGit(this.runner, this.context, worktree, [
      'branch',
      '--format=%(refname:short)',
    ]);
    return result.stdout
      .split('\n')
      .map((branch) => branch.trim())
      .filter((branch) => branch.length > 0);
  }
}
