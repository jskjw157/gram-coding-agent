import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  ApprovalRepository,
  CommandRunRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  WorkspaceRepository,
  type StoredWorkspace,
} from '@gram/persistence';
import { normalizeExecutableCommand, PolicyEngine } from '@gram/policy';
import type {
  WorkspaceRecoveryGitResult,
  WorkspaceRecoveryGitRunner,
  WorkspaceRecoveryOptions,
} from './workspace-recovery.js';

// Only fixture setup uses direct Git. Inspection always goes through the real
// CommandRunner, PolicyEngine, exact-hash ApprovalRepository, and process spawner.
interface FixtureSpawnRequest {
  taskId: string;
  cwd: string;
  category: string;
  executable: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

interface ExistingShellModule {
  NodeProcessSpawner: new () => {
    spawn(request: FixtureSpawnRequest): Promise<WorkspaceRecoveryGitResult>;
  };
  CommandRunner: new (options: {
    policy: PolicyEngine;
    approvals: { consume(taskId: string, hash: string): Promise<boolean> };
    spawner: InstanceType<ExistingShellModule['NodeProcessSpawner']>;
    commandRuns: CommandRunRepository;
    outputCapture: {
      redactText(text: string): string;
      capture(input: {
        taskId: string;
        commandRunId: number;
        stdout: string;
        stderr: string;
      }): Promise<{ stdout: string; stderr: string; stdoutPath: string; stderrPath: string }>;
    };
    environment: NodeJS.ProcessEnv;
    homeDir: string;
  }) => WorkspaceRecoveryGitRunner;
}

// A test-only source load keeps the new production module free of undeclared
// package dependencies and works before build. No shell implementation is copied.
const shellSource = new URL('../../shell/src/command-runner.ts', import.meta.url).href;

interface RecoveryFixture {
  root: string;
  homeDir: string;
  repoPath: string;
  remotePath: string;
  workspace: StoredWorkspace;
  gitDir: string;
  initialSha: string;
  git(args: readonly string[], cwd?: string): string;
  db: ReturnType<typeof openDatabase>;
  tasks: TaskRepository;
  workspaces: WorkspaceRepository;
  repositories: RepositoryRepository;
  approvals: ApprovalRepository;
  spawned: FixtureSpawnRequest[];
  runner: WorkspaceRecoveryGitRunner;
  recoveryOptions: WorkspaceRecoveryOptions;
  approveInspection(): void;
  snapshot(): ReturnType<typeof snapshotPaths>;
  close(): void;
}

export async function createRecoveryFixture(
  options: {
    layout?: 'linked' | 'standalone';
    approved?: boolean;
  } = {},
): Promise<RecoveryFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gram-recovery-')));
  const homeDir = join(root, 'home');
  const repoPath = join(root, 'canonical');
  const remotePath = join(root, 'remote.git');
  mkdirSync(homeDir);
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: homeDir,
    LANG: 'C',
    LC_ALL: 'C',
  };
  const git = (args: readonly string[], cwd = root): string =>
    execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: 'file',
      },
    }).trim();
  const db = openDatabase(join(root, 'state.db'));

  try {
    runMigrations(db);
    git(['init', '--bare', '--initial-branch=main', remotePath]);
    git(['init', '--initial-branch=main', repoPath]);
    git(['config', 'user.name', 'Recovery Fixture'], repoPath);
    git(['config', 'user.email', 'recovery@example.test'], repoPath);
    git(['config', 'commit.gpgSign', 'false'], repoPath);
    git(['config', 'core.hooksPath', '/dev/null'], repoPath);
    writeFileSync(join(repoPath, 'tracked.txt'), 'original\n');
    git(['add', 'tracked.txt'], repoPath);
    git(['commit', '-m', 'initial'], repoPath);
    const initialSha = git(['rev-parse', 'HEAD'], repoPath);
    git(['remote', 'add', 'origin', remotePath], repoPath);
    git(['push', '-u', 'origin', 'main'], repoPath);

    const repoId = 84722133;
    const repositories = new RepositoryRepository(db);
    repositories.upsert({
      githubRepositoryId: repoId,
      owner: 'fixture',
      name: 'recovery',
      defaultBranch: 'main',
      localBasePath: repoPath,
    });
    const tasks = new TaskRepository(db);
    const task = tasks.create({
      goal: 'Inspect interrupted workspace',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId,
    });
    const workspaces = new WorkspaceRepository(db);
    const branch = 'fix/task-000001-workspace-recovery';
    const workspacePath = join(homeDir, '.gram-agent', 'worktrees', String(repoId), task.id);
    mkdirSync(dirname(workspacePath), { recursive: true });
    if (options.layout === 'standalone') {
      git(['clone', remotePath, workspacePath]);
      git(['checkout', '-b', branch, 'origin/main'], workspacePath);
    } else {
      git(['worktree', 'add', '-b', branch, workspacePath, 'origin/main'], repoPath);
    }
    const workspace = workspaces.create({
      taskId: task.id,
      repoId,
      linuxPath: workspacePath,
      branch,
      headSha: initialSha,
    });
    const gitDir = git(['rev-parse', '--absolute-git-dir'], workspacePath);
    const approvals = new ApprovalRepository(db);
    const commandRuns = new CommandRunRepository(db);
    const policy = new PolicyEngine();

    // Independent, fixed read-only allowlist for this fixture's explicit grants.
    // Do not derive it from the inspector: a new/changed command needs a new grant.
    const prefix = [
      '--no-optional-locks',
      '--no-lazy-fetch',
      '--no-replace-objects',
      '--no-pager',
      `--git-dir=${gitDir}`,
      `--work-tree=${workspacePath}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.hooksPath=/dev/null',
    ];
    const queries = [
      [
        'config',
        '--name-only',
        '--get-regexp',
        '^(filter\\..*\\.(clean|process)|extensions\\.partialclone|core\\.sparsecheckout)$',
      ],
      ['ls-files', '-v', '--stage', '-z', '--abbrev=64'],
      ['rev-parse', '--is-shallow-repository'],
      [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
        '--no-renames',
        '--ahead-behind',
      ],
      ['rev-parse', '--symbolic-full-name', '@{upstream}'],
    ];
    function approveInspection(): void {
      for (const query of queries) {
        const operation = normalizeExecutableCommand('git', [...prefix, ...query], workspacePath);
        const decision = policy.evaluate(operation, { taskId: task.id });
        if (decision.kind !== 'NEEDS_APPROVAL')
          throw new Error('Fixture expected the pinned policy approval gate');
        const record = approvals.request({
          taskId: task.id,
          operationHash: decision.operationHash,
        });
        approvals.approve(record.id, decision.operationHash);
      }
    }
    if (options.approved === true) approveInspection();

    const { CommandRunner, NodeProcessSpawner } = (await import(
      shellSource
    )) as ExistingShellModule;
    const spawner = new NodeProcessSpawner();
    const spawned: FixtureSpawnRequest[] = [];
    const runner = new CommandRunner({
      policy,
      approvals: { consume: async (id, hash) => approvals.consume(id, hash) },
      spawner: {
        spawn: async (request) => {
          // Fixture-host isolation only: the system may install LFS filters.
          // HOME is already disposable; repository/global fixture config is read
          // normally. Exact approved argv is passed unchanged to the real spawner.
          const isolated = { ...request, env: { ...request.env, GIT_CONFIG_NOSYSTEM: '1' } };
          spawned.push(isolated);
          return spawner.spawn(isolated);
        },
      },
      commandRuns,
      environment,
      homeDir,
      outputCapture: {
        redactText: (text) => text,
        capture: async (input) => {
          const logDir = join(root, 'command-logs');
          mkdirSync(logDir, { recursive: true });
          const stdoutPath = join(logDir, `${input.commandRunId}.stdout`);
          const stderrPath = join(logDir, `${input.commandRunId}.stderr`);
          writeFileSync(stdoutPath, input.stdout);
          writeFileSync(stderrPath, input.stderr);
          return { stdout: input.stdout, stderr: input.stderr, stdoutPath, stderrPath };
        },
      },
    });
    const recoveryOptions: WorkspaceRecoveryOptions = {
      taskId: task.id,
      homeDir,
      workspaces,
      repositories,
      runner,
    };

    return {
      root,
      homeDir,
      repoPath,
      remotePath,
      workspace,
      gitDir,
      initialSha,
      git,
      db,
      tasks,
      workspaces,
      repositories,
      approvals,
      spawned,
      runner,
      recoveryOptions,
      approveInspection,
      snapshot: () => snapshotPaths(root, [repoPath, remotePath, homeDir]),
      close: () => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function snapshotPaths(root: string, paths: readonly string[]) {
  const entries: Record<string, { mode: string; mtime: string; content?: string; link?: string }> =
    {};
  const visit = (path: string): void => {
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
    entries[relative(root, path)] = {
      mode: String(stat.mode),
      mtime: String(stat.mtimeNs),
      ...(stat.isFile()
        ? { content: createHash('sha256').update(readFileSync(path)).digest('hex') }
        : {}),
      ...(stat.isSymbolicLink() ? { link: readlinkSync(path) } : {}),
    };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  for (const path of paths) visit(path);
  return entries;
}
