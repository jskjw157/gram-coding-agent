import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRequest } from '@gram/shell';
import { CommitService } from './commit-service.js';
import { RemoteService } from './remote-service.js';
import type { GitCommandResult, GitCommandRunnerPort } from './command.js';

const roots: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

class LocalGitRunner implements GitCommandRunnerPort {
  run(request: CommandRequest): Promise<GitCommandResult> {
    if (!('executable' in request) || request.executable !== 'git') {
      throw new Error('expected executable git request');
    }
    const stdout = execFileSync(request.executable, [...(request.args ?? [])], {
      cwd: request.cwd,
      encoding: 'utf8',
    });
    return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
  }
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-git-explicit-'));
  roots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Gram Test']);
  git(root, ['config', 'user.email', 'gram@example.test']);
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(root, ['add', 'baseline.txt']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

afterEach(() => {
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CommitService.commitExplicit', () => {
  it('commits only explicitly named paths and leaves unrelated files outside the commit', async () => {
    const worktree = createRepository();
    writeFileSync(join(worktree, 'intended.ts'), 'export const intended = true;\n');
    writeFileSync(join(worktree, 'unrelated.tmp'), 'do not publish\n');

    const service = new CommitService(new LocalGitRunner(), { taskId: 'task-56-red' });
    const sha = await service.commitExplicit(worktree, ['intended.ts'], 'feat: intended change');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(worktree, ['show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean))
      .toEqual(['intended.ts']);
    expect(git(worktree, ['status', '--porcelain'])).toContain('?? unrelated.tmp');
  });
});


describe('RemoteService.confirmRemoteSha', () => {
  it('matches the exact branch SHA from a local bare remote and rejects mismatches', async () => {
    const worktree = createRepository();
    const remote = mkdtempSync(join(tmpdir(), 'gram-git-remote-'));
    roots.push(remote);
    git(remote, ['init', '--bare']);

    git(worktree, ['remote', 'add', 'origin', remote]);
    writeFileSync(join(worktree, 'publish.txt'), 'publish me\n');
    git(worktree, ['add', 'publish.txt']);
    git(worktree, ['commit', '-m', 'feat: publish fixture']);

    const runner = new LocalGitRunner();
    const service = new RemoteService(runner, { taskId: 'task-57-red' }, worktree);
    const branch = 'feat/task-000057-remote-confirm';
    const expectedSha = git(worktree, ['rev-parse', 'HEAD']);

    await service.push(worktree, branch);

    expect(await service.confirmRemoteSha('origin', branch, expectedSha)).toBe(true);
    expect(await service.confirmRemoteSha('origin', branch, '0'.repeat(40))).toBe(false);
  });
});
