import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRequest } from '@gram/shell';
import { BranchService } from './branch-service.js';
import { CommitService } from './commit-service.js';
import { GitService } from './git-service.js';
import { RemoteService } from './remote-service.js';
import type { GitCommandResult, GitCommandRunnerPort } from './command.js';

const roots: string[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

class LocalGitRunner implements GitCommandRunnerPort {
  readonly requests: CommandRequest[] = [];

  run(request: CommandRequest): Promise<GitCommandResult> {
    this.requests.push(request);
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
  git(root, ['branch', '-M', 'main']);
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


class RecordingRunner implements GitCommandRunnerPort {
  readonly requests: CommandRequest[] = [];

  run(request: CommandRequest): Promise<GitCommandResult> {
    this.requests.push(request);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
}

describe('GitService and BranchService', () => {
  it('reports task-worktree status and diff through the command runner', async () => {
    const worktree = createRepository();
    writeFileSync(join(worktree, 'baseline.txt'), 'changed\n');
    writeFileSync(join(worktree, 'extra.txt'), 'untracked\n');

    const runner = new LocalGitRunner();
    const service = new GitService(runner, { taskId: 'task-git-service' });

    const status = await service.status(worktree);
    expect(status.clean).toBe(false);
    expect(status.entries.map((entry) => entry.path).sort()).toEqual([
      'baseline.txt',
      'extra.txt',
    ]);
    expect(await service.diff(worktree)).toContain('+changed');
    expect(runner.requests.every((request) => request.category === 'GIT')).toBe(true);
  });

  it('uses explicit safe fetch arguments and reads local branches through the runner', async () => {
    const recording = new RecordingRunner();
    const service = new GitService(recording, { taskId: 'task-fetch' });
    await service.fetch('/repo');

    expect(recording.requests[0]).toMatchObject({
      executable: 'git',
      args: ['fetch', '--prune', 'origin'],
      cwd: '/repo',
      category: 'GIT',
    });

    const worktree = createRepository();
    const branches = new BranchService(new LocalGitRunner(), { taskId: 'task-branch' });
    expect(await branches.current(worktree)).toBe('main');
    expect(await branches.listLocal(worktree)).toEqual(['main']);
  });
});

describe('RemoteService publishing policy context', () => {
  it('passes target branch and publish mode into CommandRunner policy context', async () => {
    const runner = new RecordingRunner();
    const service = new RemoteService(
      runner,
      {
        taskId: 'task-protected-main',
        protectedBranches: ['main'],
        directMainGranted: false,
        publishMode: 'PULL_REQUEST',
      },
      '/repo',
    );

    await service.push('/repo', 'main');

    expect(runner.requests[0]).toMatchObject({
      taskId: 'task-protected-main',
      cwd: '/repo',
      category: 'GIT',
      executable: 'git',
      args: ['push', 'origin', 'HEAD:refs/heads/main'],
      protectedBranches: ['main'],
      directMainGranted: false,
      targetBranch: 'main',
      publishMode: 'PULL_REQUEST',
    });
  });
});

describe('@gram/git architecture', () => {
  it('routes production Git execution through CommandRunner instead of child_process', async () => {
    const { readFile } = await import('node:fs/promises');
    const productionFiles = [
      './command.ts',
      './git-service.ts',
      './branch-service.ts',
      './commit-service.ts',
      './remote-service.ts',
    ];

    for (const relativePath of productionFiles) {
      const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).not.toContain('node:child_process');
      expect(source).not.toContain('execFile');
      expect(source).not.toContain('spawn(');
    }
  });
});
