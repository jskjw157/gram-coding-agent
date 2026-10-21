import { runGit, type GitCommandRunnerPort, type GitTaskContext } from './command.js';

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

export interface GitStatus {
  clean: boolean;
  entries: GitStatusEntry[];
}

function parsePorcelainV1Z(output: string): GitStatusEntry[] {
  const chunks = output.split('\0').filter((chunk) => chunk.length > 0);
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk.length < 4) continue;

    const indexStatus = chunk[0] ?? ' ';
    const worktreeStatus = chunk[1] ?? ' ';
    const path = chunk.slice(3);
    const renamedOrCopied = indexStatus === 'R' || indexStatus === 'C';
    const originalPath = renamedOrCopied ? chunks[index + 1] : undefined;
    if (renamedOrCopied && originalPath !== undefined) index += 1;

    entries.push({
      index: indexStatus,
      worktree: worktreeStatus,
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }

  return entries;
}

export class GitService {
  constructor(
    private readonly runner: GitCommandRunnerPort,
    private readonly context: GitTaskContext,
  ) {}

  async fetch(repoPath: string): Promise<void> {
    await runGit(this.runner, this.context, repoPath, ['fetch', '--prune', 'origin']);
  }

  async status(worktree: string): Promise<GitStatus> {
    const result = await runGit(this.runner, this.context, worktree, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const entries = parsePorcelainV1Z(result.stdout);
    return { clean: entries.length === 0, entries };
  }

  async diff(worktree: string, baseRef?: string): Promise<string> {
    const result = await runGit(this.runner, this.context, worktree, [
      'diff',
      ...(baseRef === undefined ? [] : [baseRef]),
      '--',
    ]);
    return result.stdout;
  }
}
