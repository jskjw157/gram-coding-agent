import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import {
  createTaskBranchName,
  type GitWorktreePort,
  WorktreeService,
} from './worktree-service.js';
import { WorkspaceResolver } from './workspace-resolver.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-workspace-'));
  roots.push(root);
  return root;
}

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
  }).trim();
}

function createCanonicalRepository(root: string) {
  const remotePath = join(root, 'remote.git');
  const localBasePath = join(root, 'workspace', 'github', 'company', 'mamf-web');
  mkdirSync(dirname(localBasePath), { recursive: true });

  git(['init', '--bare', remotePath]);
  git(['init', localBasePath]);
  git(['-C', localBasePath, 'config', 'user.name', 'Gram Test']);
  git(['-C', localBasePath, 'config', 'user.email', 'gram@example.test']);
  writeFileSync(join(localBasePath, 'app.txt'), 'canonical\n');
  git(['-C', localBasePath, 'add', 'app.txt']);
  git(['-C', localBasePath, 'commit', '-m', 'initial']);
  git(['-C', localBasePath, 'branch', '-M', 'main']);
  git(['-C', localBasePath, 'remote', 'add', 'origin', remotePath]);
  git(['-C', localBasePath, 'push', '-u', 'origin', 'main']);
  git(['-C', localBasePath, 'fetch', 'origin']);

  return { remotePath, localBasePath };
}

class GitCliTestPort implements GitWorktreePort {
  async createWorktree(input: {
    repoPath: string;
    worktreePath: string;
    baseRef: string;
    branch: string;
    taskId: string;
  }): Promise<{ headSha: string }> {
    git([
      '-C',
      input.repoPath,
      'worktree',
      'add',
      '-b',
      input.branch,
      input.worktreePath,
      input.baseRef,
    ]);
    return { headSha: git(['-C', input.worktreePath, 'rev-parse', 'HEAD']) };
  }

  async removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    taskId: string;
  }): Promise<void> {
    git(['-C', input.repoPath, 'worktree', 'remove', '--force', input.worktreePath]);
  }

  async pruneWorktrees(input: { repoPath: string; taskId: string }): Promise<void> {
    git(['-C', input.repoPath, 'worktree', 'prune']);
  }
}

function setupPersistence(root: string, localBasePath: string) {
  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);

  const repositories = new RepositoryRepository(db);
  repositories.upsert({
    githubRepositoryId: 84722133,
    owner: 'company',
    name: 'mamf-web',
    defaultBranch: 'main',
    localBasePath,
  });

  const tasks = new TaskRepository(db);
  const task = tasks.create({
    goal: 'Fix Excel download URL',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 84722133,
  });

  return { db, task, workspaces: new WorkspaceRepository(db) };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('WorktreeService', () => {
  it('creates an isolated task worktree outside the canonical checkout and persists only after Git confirms it', async () => {
    const root = tempRoot();
    const homeDir = join(root, 'home');
    const { localBasePath } = createCanonicalRepository(root);
    const { task, workspaces } = setupPersistence(root, localBasePath);
    const pathMapper = {
      toWindows: vi.fn(async (linuxPath: string) => `W:\\mapped${linuxPath.replaceAll('/', '\\')}`),
    };
    const service = new WorktreeService({
      homeDir,
      git: new GitCliTestPort(),
      workspaces,
      pathMapper,
    });

    const workspace = await service.create({
      taskId: task.id,
      repo: {
        githubRepositoryId: 84722133,
        localBasePath,
      },
      baseRef: 'origin/main',
      branch: 'fix/task-000001-excel-download-url',
    });

    expect(workspace.linuxPath).toBe(
      join(homeDir, '.gram-agent', 'worktrees', '84722133', task.id),
    );
    expect(workspace.linuxPath).not.toContain(join(localBasePath, '.git', 'worktrees'));
    expect(workspace.branch).toBe('fix/task-000001-excel-download-url');
    expect(workspace.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(workspaces.getByTaskId(task.id)?.headSha).toBe(workspace.headSha);

    writeFileSync(join(workspace.linuxPath, 'app.txt'), 'worktree-only\n');
    expect(readFileSync(join(workspace.linuxPath, 'app.txt'), 'utf8')).toBe('worktree-only\n');
    expect(readFileSync(join(localBasePath, 'app.txt'), 'utf8')).toBe('canonical\n');

    const resolved = new WorkspaceResolver(workspaces).resolve(task.id);
    expect(resolved.linuxPath).toBe(workspace.linuxPath);
    expect(resolved.windowsPath).toBe(workspace.windowsPath);
  });

  it('does not persist workspace metadata when Git worktree creation fails', async () => {
    const root = tempRoot();
    const homeDir = join(root, 'home');
    const { localBasePath } = createCanonicalRepository(root);
    const { task, workspaces } = setupPersistence(root, localBasePath);
    const failingGit: GitWorktreePort = {
      createWorktree: vi.fn(async () => {
        throw new Error('git worktree add failed');
      }),
      removeWorktree: vi.fn(async () => {}),
      pruneWorktrees: vi.fn(async () => {}),
    };
    const service = new WorktreeService({
      homeDir,
      git: failingGit,
      workspaces,
      pathMapper: { toWindows: async () => 'C:\\mapped' },
    });

    await expect(
      service.create({
        taskId: task.id,
        repo: { githubRepositoryId: 84722133, localBasePath },
        baseRef: 'origin/main',
        branch: 'fix/task-000001-excel-download-url',
      }),
    ).rejects.toThrow('git worktree add failed');

    expect(workspaces.getByTaskId(task.id)).toBeUndefined();
  });

  it('builds human-readable task branches without using UUID as branch identity', () => {
    expect(
      createTaskBranchName({
        taskType: 'FIX',
        displaySequence: 201,
        goal: 'Fix Excel download URL',
      }),
    ).toBe('fix/task-000201-fix-excel-download-url');

    expect(
      createTaskBranchName({
        taskType: 'FEATURE',
        displaySequence: 202,
        goal: 'Add CSV export',
      }),
    ).toBe('feat/task-000202-add-csv-export');

    expect(
      createTaskBranchName({
        taskType: 'CHORE',
        displaySequence: 203,
        goal: 'Refresh dependencies',
      }),
    ).toBe('chore/task-000203-refresh-dependencies');
  });

  it('passes task identity into Git worktree creation and path conversion', async () => {
    const root = tempRoot();
    const homeDir = join(root, 'home');
    const { localBasePath } = createCanonicalRepository(root);
    const { task, workspaces } = setupPersistence(root, localBasePath);
    const headSha = 'a'.repeat(40);
    const createWorktree = vi.fn(
      async (input: {
        repoPath: string;
        worktreePath: string;
        baseRef: string;
        branch: string;
        taskId: string;
      }) => {
        void input;
        return { headSha };
      },
    );
    const removeWorktree = vi.fn(async () => {});
    const pruneWorktrees = vi.fn(async () => {});
    const fakeGit = { createWorktree, removeWorktree, pruneWorktrees };
    const toWindows = vi.fn(async (linuxPath: string, taskId: string) => {
      void linuxPath;
      void taskId;
      return 'C:\\mapped';
    });
    const service = new WorktreeService({
      homeDir,
      git: fakeGit,
      workspaces,
      pathMapper: { toWindows },
    });

    await service.create({
      taskId: task.id,
      repo: { githubRepositoryId: 84722133, localBasePath },
      baseRef: 'origin/main',
      branch: 'fix/task-000001-excel-download-url',
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({ taskId: task.id });
    expect(toWindows).toHaveBeenCalledTimes(1);
    expect(toWindows.mock.calls[0]?.[1]).toBe(task.id);
  });

  it('removes and prunes a created worktree when workspace persistence fails', async () => {
    const root = tempRoot();
    const homeDir = join(root, 'home');
    const { localBasePath } = createCanonicalRepository(root);
    const { task, workspaces } = setupPersistence(root, localBasePath);
    const headSha = 'b'.repeat(40);
    const createWorktree = vi.fn(async () => ({ headSha }));
    const removeWorktree = vi.fn(async () => {
      throw new Error('rollback failed');
    });
    const pruneWorktrees = vi.fn(async () => {});
    const fakeGit = { createWorktree, removeWorktree, pruneWorktrees };
    const service = new WorktreeService({
      homeDir,
      git: fakeGit,
      workspaces,
      pathMapper: { toWindows: async () => 'C:\\mapped' },
    });
    vi.spyOn(workspaces, 'create').mockImplementation(() => {
      throw new Error('workspace persist failed');
    });

    await expect(
      service.create({
        taskId: task.id,
        repo: { githubRepositoryId: 84722133, localBasePath },
        baseRef: 'origin/main',
        branch: 'fix/task-000001-excel-download-url',
      }),
    ).rejects.toThrow('workspace persist failed');

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(pruneWorktrees).toHaveBeenCalledTimes(1);
  });

  it('rejects an escaping task or repository id before mapping or creating directories', async () => {
    const root = tempRoot();
    const homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });
    const { localBasePath } = createCanonicalRepository(root);
    const { task, workspaces } = setupPersistence(root, localBasePath);
    const toWindows = vi.fn(async () => 'C:\\mapped');
    const createWorktree = vi.fn(async () => ({ headSha: 'a'.repeat(40) }));
    const service = new WorktreeService({
      homeDir,
      git: {
        createWorktree,
        removeWorktree: vi.fn(async () => {}),
        pruneWorktrees: vi.fn(async () => {}),
      },
      workspaces,
      pathMapper: { toWindows },
    });

    await expect(
      service.create({
        taskId: '../../escape',
        repo: { githubRepositoryId: 84722133, localBasePath },
        baseRef: 'origin/main',
        branch: 'fix/escape',
      }),
    ).rejects.toThrow('worktree target must be within the agent task-worktree layout');
    expect(toWindows).toHaveBeenCalledTimes(0);
    expect(createWorktree).toHaveBeenCalledTimes(0);
    expect(existsSync(join(root, 'escape'))).toBe(false);
    expect(existsSync(join(homeDir, '.gram-agent', 'worktrees', '84722133', '..', '..', 'escape'))).toBe(false);

    await expect(
      service.create({
        taskId: task.id,
        repo: { githubRepositoryId: Number.NaN, localBasePath },
        baseRef: 'origin/main',
        branch: 'fix/escape',
      }),
    ).rejects.toThrow('worktree target must be within the agent task-worktree layout');
    expect(toWindows).toHaveBeenCalledTimes(0);
    expect(createWorktree).toHaveBeenCalledTimes(0);
  });
});
