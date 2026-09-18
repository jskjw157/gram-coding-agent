import { runGit, type GitCommandRunnerPort, type GitTaskContext } from './command.js';

export class RemoteService {
  constructor(
    private readonly runner: GitCommandRunnerPort,
    private readonly context: GitTaskContext,
    private readonly confirmationCwd: string,
  ) {}

  async push(worktree: string, branch: string): Promise<void> {
    await runGit(this.runner, this.context, worktree, [
      'push',
      'origin',
      `HEAD:refs/heads/${branch}`,
    ]);
  }

  async confirmRemoteSha(
    remote: string,
    branch: string,
    expectedSha: string,
  ): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
      throw new Error('expectedSha must be a full lowercase Git SHA');
    }

    const ref = `refs/heads/${branch}`;
    const result = await runGit(this.runner, this.context, this.confirmationCwd, [
      'ls-remote',
      remote,
      ref,
    ]);
    const line = result.stdout
      .split('\n')
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (line === undefined) return false;

    const [actualSha, actualRef] = line.split(/\s+/);
    return actualSha === expectedSha && actualRef === ref;
  }
}
