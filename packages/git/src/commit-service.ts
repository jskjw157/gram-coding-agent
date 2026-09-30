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

    // Already-staged rm/mv sources are absent from the index, so git add
    // rejects them. Keep every approved path for commit --only; stage only
    // the explicitly approved paths that are not deleted relative to HEAD.
    const deleted = await runGit(this.runner, this.context, worktree, [
      'diff', '--name-only', '--diff-filter=D', '-z', '--no-renames',
      '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...paths,
    ]);
    const deletedPaths = new Set(deleted.stdout.split('\0').filter(Boolean));
    const stagePaths = paths.filter((path) => !deletedPaths.has(path));
    if (stagePaths.length > 0) {
      await runGit(this.runner, this.context, worktree, ['add', '--', ...stagePaths]);
    }
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
