import type { TaskId } from '@gram/domain';
import type { CommandRunner } from '@gram/shell';
import type { GitWorktreePort } from '@gram/workspace';
import type { CompositionGit } from './task-runner-composition.js';

/**
 * Policy-gated git and worktree command adapters for the agent.
 *
 * Every command shells out exclusively through the injected
 * policy-gated `CommandRunner` (executable form): git and wslpath are
 * never spawned directly, so policy evaluation and approval consumption
 * always happen before any child process starts.
 */

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}

export interface PolicyGitAdapterOptions {
  runner: CommandRunner;
}

export interface PolicyWorktreeAdapterOptions {
  runner: CommandRunner;
  records?: WorktreeRecordStore;
}

export interface PolicyWslPathRunnerOptions {
  runner: CommandRunner;
  cwd?: string;
}

export interface CreatedWorktreeRecord {
  taskId: TaskId;
  repoPath: string;
  worktreePath: string;
  baseRef: string;
  branch: string;
  headSha: string;
}

/**
 * Domain-level persistence for created worktrees. The adapter records
 * only after `worktree add` AND `rev-parse HEAD` have both succeeded and
 * the HEAD validated as a full SHA: nothing is ever persisted before git
 * has actually succeeded.
 */
export interface WorktreeRecordStore {
  create(record: CreatedWorktreeRecord): void;
}

/** Policy-gated task-attributed Git operations. */
export class PolicyGitAdapter implements CompositionGit {
  constructor(private readonly options: PolicyGitAdapterOptions) {}

  async headSha(worktree: string, taskId: TaskId): Promise<string> {
    requireNonEmpty('worktree', worktree);
    requireNonEmpty('taskId', taskId);
    const result = await this.options.runner.run({
      taskId,
      cwd: worktree,
      category: 'GIT',
      executable: 'git',
      args: ['rev-parse', 'HEAD'],
    });
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !FULL_SHA_RE.test(sha)) {
      throw new Error('git rev-parse HEAD failed to resolve a full HEAD SHA');
    }
    return sha;
  }

  /** Runs `git fetch origin` (in `repoPath`) through the policy gate. */
  async fetch(repoPath: string, taskId: TaskId): Promise<void> {
    requireNonEmpty('repoPath', repoPath);
    const result = await this.options.runner.run({
      taskId,
      cwd: repoPath,
      category: 'GIT',
      executable: 'git',
      args: ['fetch', 'origin'],
    });
    if (result.exitCode !== 0) {
      throw new Error(`git fetch failed for ${repoPath} (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  /**
   * Runs `git status --porcelain=v1 -z` (in `worktree`) through the policy
   * gate and returns one entry per reported path.
   */
  async status(worktree: string, taskId: TaskId): Promise<{ entries: readonly { path: string }[] }> {
    requireNonEmpty('worktree', worktree);
    const result = await this.options.runner.run({
      taskId,
      cwd: worktree,
      category: 'GIT',
      executable: 'git',
      args: ['status', '--porcelain=v1', '-z'],
    });
    if (result.exitCode !== 0) {
      throw new Error(`git status failed for ${worktree} (exit ${result.exitCode}): ${result.stderr}`);
    }
    const entries: { path: string }[] = [];
    for (const record of result.stdout.split('\0')) {
      if (record.length === 0) continue;
      entries.push({ path: record.slice(3) });
    }
    return { entries };
  }
}

/** `GitWorktreePort` over the policy-gated runner (new task-scoped signatures). */
export class PolicyWorktreeAdapter implements GitWorktreePort {
  constructor(private readonly options: PolicyWorktreeAdapterOptions) {}

  /**
   * Runs `git worktree add -b <branch> <path> <baseRef>` (in `repoPath`)
   * followed by `git rev-parse HEAD` (in the new worktree). Returns the
   * full worktree HEAD and records it only after git has succeeded; any
   * git failure (or a non-SHA HEAD) rejects without persisting anything.
   */
  async createWorktree(input: {
    repoPath: string;
    worktreePath: string;
    baseRef: string;
    branch: string;
    taskId: TaskId;
  }): Promise<{ headSha: string }> {
    requireNonEmpty('repoPath', input.repoPath);
    requireNonEmpty('worktreePath', input.worktreePath);
    requireNonEmpty('baseRef', input.baseRef);
    requireNonEmpty('branch', input.branch);

    const add = await this.options.runner.run({
      taskId: input.taskId,
      cwd: input.repoPath,
      category: 'GIT',
      executable: 'git',
      args: ['worktree', 'add', '-b', input.branch, input.worktreePath, input.baseRef],
    });
    if (add.exitCode !== 0) {
      throw new Error(
        `git worktree add failed for ${input.worktreePath} (exit ${add.exitCode}): ${add.stderr}`,
      );
    }

    const head = await this.options.runner.run({
      taskId: input.taskId,
      cwd: input.worktreePath,
      category: 'GIT',
      executable: 'git',
      args: ['rev-parse', 'HEAD'],
    });
    if (head.exitCode !== 0) {
      throw new Error(
        `git rev-parse HEAD failed for ${input.worktreePath} (exit ${head.exitCode}): ${head.stderr}`,
      );
    }
    const headSha = head.stdout.trim();
    if (FULL_SHA_RE.test(headSha) === false) {
      throw new Error(`git rev-parse HEAD returned an invalid HEAD SHA for ${input.worktreePath}: ${headSha}`);
    }

    this.options.records?.create({
      taskId: input.taskId,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      baseRef: input.baseRef,
      branch: input.branch,
      headSha,
    });
    return { headSha };
  }

  /** Runs `git worktree remove --force <path>` (in `repoPath`) through the policy gate. */
  async removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    taskId: TaskId;
  }): Promise<void> {
    requireNonEmpty('repoPath', input.repoPath);
    requireNonEmpty('worktreePath', input.worktreePath);
    const result = await this.options.runner.run({
      taskId: input.taskId,
      cwd: input.repoPath,
      category: 'GIT',
      executable: 'git',
      args: ['worktree', 'remove', '--force', input.worktreePath],
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree remove failed for ${input.worktreePath} (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }

  /** Runs `git worktree prune` (in `repoPath`) through the policy gate. */
  async pruneWorktrees(input: { repoPath: string; taskId: TaskId }): Promise<void> {
    requireNonEmpty('repoPath', input.repoPath);
    const result = await this.options.runner.run({
      taskId: input.taskId,
      cwd: input.repoPath,
      category: 'GIT',
      executable: 'git',
      args: ['worktree', 'prune'],
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree prune failed for ${input.repoPath} (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }
}

/**
 * `WslPathRunner` over the policy-gated runner: runs
 * `wslpath -w <linuxPath>` (plus any caller-supplied args verbatim) and
 * returns the trimmed Windows path.
 */
export class PolicyWslPathRunner {
  constructor(private readonly options: PolicyWslPathRunnerOptions) {}

  async run(args: readonly string[], taskId: TaskId): Promise<string> {
    const result = await this.options.runner.run({
      taskId,
      cwd: this.options.cwd ?? process.cwd(),
      category: 'WINDOWS',
      executable: 'wslpath',
      args: [...args],
    });
    if (result.exitCode !== 0) {
      throw new Error(`wslpath failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    const windowsPath = result.stdout.trim();
    if (windowsPath.length === 0) throw new Error('wslpath returned an empty Windows path');
    return windowsPath;
  }
}
