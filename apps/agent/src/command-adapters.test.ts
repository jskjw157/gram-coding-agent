import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeExecutableCommand, PolicyEngine } from '@gram/policy';
import {
  ApprovalRequiredError,
  CommandRunner,
  NodeProcessSpawner,
  type ApprovalConsumptionPort,
  type ProcessSpawner,
  type SpawnRequest,
  type SpawnResult,
} from '@gram/shell';
import {
  PolicyGitAdapter,
  PolicyWorktreeAdapter,
  PolicyWslPathRunner,
  type WorktreeRecordStore,
} from './command-adapters.js';

const tempDirs: string[] = [];
const worktrees: Array<{ repoPath: string; path: string }> = [];

function trackRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-command-adapters-'));
  tempDirs.push(root);
  return root;
}

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
  }).trim();
}

function createCanonicalRepository(root: string): { remotePath: string; localBasePath: string } {
  const remotePath = join(root, 'remote.git');
  const localBasePath = join(root, 'canonical');
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
  return { remotePath, localBasePath };
}

interface Harness {
  runner: CommandRunner;
  seen: SpawnRequest[];
  consume: ReturnType<typeof vi.fn<ApprovalConsumptionPort['consume']>>;
  commandRuns: { start: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
}

function harness(options: { approve: boolean; spawner?: ProcessSpawner }): Harness {
  const seen: SpawnRequest[] = [];
  const inner = options.spawner ?? new NodeProcessSpawner();
  const spawner: ProcessSpawner = {
    spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
      seen.push(request);
      return inner.spawn(request);
    },
  };
  const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => options.approve);
  let nextId = 1;
  const commandRuns = {
    start: vi.fn(() => nextId++),
    finish: vi.fn(),
  };
  const runner = new CommandRunner({
    policy: new PolicyEngine(),
    approvals: { consume },
    spawner,
    commandRuns,
    outputCapture: {
      redactText: (text: string) => text,
      capture: async ({
        stdout,
        stderr,
      }: {
        stdout: string;
        stderr: string;
      }): Promise<{
        stdout: string;
        stderr: string;
        stdoutPath: string;
        stderrPath: string;
      }> => ({
        stdout,
        stderr,
        stdoutPath: join(tmpdir(), 'gram-cmd-stdout'),
        stderrPath: join(tmpdir(), 'gram-cmd-stderr'),
      }),
    },
  });
  return { runner, seen, consume, commandRuns };
}

function recordStore(): WorktreeRecordStore & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    create: vi.fn((record: unknown) => {
      records.push(record);
    }) as WorktreeRecordStore['create'],
  };
}

afterEach(() => {
  for (const entry of worktrees.splice(0)) {
    try {
      git(['-C', entry.repoPath, 'worktree', 'remove', '--force', entry.path]);
    } catch {
      // Best-effort teardown: the temp root removal below is the backstop.
    }
  }
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('policy-gated git and worktree command adapters', () => {
  it('fetches and creates a worktree through CommandRunner with the owning task id', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000006';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);

    const denying = harness({ approve: false });
    const denyingWorktrees = new PolicyWorktreeAdapter({ runner: denying.runner });
    const deniedPath = join(root, 'wt-denied');
    const denyingCreated = await denyingWorktrees.createWorktree({
      repoPath: localBasePath,
      worktreePath: deniedPath,
      baseRef: 'origin/main',
      branch: 'feat/task-000006-denied',
      taskId: taskId,
    });
    expect(denyingCreated.headSha).toMatch(/^[0-9a-f]{40}$/);
    worktrees.push({ repoPath: localBasePath, path: deniedPath });
    expect(denying.consume).not.toHaveBeenCalled();

    const { runner, seen } = harness({ approve: true });
    const gitAdapter = new PolicyGitAdapter({ runner });
    await gitAdapter.fetch(localBasePath, taskId);

    const store = recordStore();
    const worktreesAdapter = new PolicyWorktreeAdapter({ runner, records: store });
    const worktreePath = join(root, 'wt-1');
    const created = await worktreesAdapter.createWorktree({
      repoPath: localBasePath,
      worktreePath,
      baseRef: 'origin/main',
      branch: 'feat/task-000001-canonical',
      taskId,
    });
    worktrees.push({ repoPath: localBasePath, path: worktreePath });

    expect(created.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(created.headSha).toBe(git(['-C', worktreePath, 'rev-parse', 'HEAD']));
    expect(git(['-C', localBasePath, 'worktree', 'list', '--porcelain'])).toContain(worktreePath);

    const status = await gitAdapter.status(worktreePath, taskId);
    expect(status.entries).toEqual([]);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request.taskId).toBe(taskId);
  });

  it('returns a full worktree head and never persists before Git succeeds', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000007';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const { runner } = harness({ approve: true });

    const store = recordStore();
    const worktreesAdapter = new PolicyWorktreeAdapter({ runner, records: store });
    const worktreePath = join(root, 'wt-ok');
    const created = await worktreesAdapter.createWorktree({
      repoPath: localBasePath,
      worktreePath,
      baseRef: 'origin/main',
      branch: 'feat/task-000002-ok',
      taskId,
    });
    worktrees.push({ repoPath: localBasePath, path: worktreePath });

    expect(created.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(store.records).toHaveLength(1);

    const failingPath = join(root, 'wt-bad');
    await expect(
      worktreesAdapter.createWorktree({
        repoPath: localBasePath,
        worktreePath: failingPath,
        baseRef: 'origin/does-not-exist',
        branch: 'feat/task-000002-bad',
        taskId,
      }),
    ).rejects.toThrow();
    expect(store.records).toHaveLength(1);
    expect(git(['-C', localBasePath, 'worktree', 'list', '--porcelain'])).not.toContain(failingPath);
  });

  it('issues git fetch with the subcommand in args[0] and the repo path in cwd', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000011';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const { runner } = harness({ approve: true, spawner: stub });
    const gitAdapter = new PolicyGitAdapter({ runner });
    await gitAdapter.fetch(localBasePath, taskId);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.executable).toBe('git');
    expect(seen[0] === undefined ? undefined : [...(seen[0].args ?? [])][0]).toBe('fetch');
    expect(seen[0] === undefined ? [] : [...(seen[0].args ?? [])]).toEqual(['fetch', 'origin']);
    expect(seen[0] === undefined ? [] : [...(seen[0].args ?? [])]).not.toContain('-C');
    expect(seen[0]?.cwd).toBe(localBasePath);
  });

  it('attributes commands to the task id supplied at call time on one shared adapter', async () => {
    const taskA = '0191a2b3-c4d5-7000-8000-000000000012';
    const taskB = '0191a2b3-c4d5-7000-8000-000000000013';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const { runner } = harness({ approve: true, spawner: stub });
    const gitAdapter = new PolicyGitAdapter({ runner });
    await gitAdapter.fetch(localBasePath, taskA);
    await gitAdapter.fetch(localBasePath, taskB);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.taskId).toBe(taskA);
    expect(seen[1]?.taskId).toBe(taskB);
  });

  it('classifies the issued fetch command as not-approval-required by the real PolicyEngine', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000014';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const { runner } = harness({ approve: true, spawner: stub });
    const gitAdapter = new PolicyGitAdapter({ runner });
    await gitAdapter.fetch(localBasePath, taskId);
    const request = seen[0];
    expect(request).toBeDefined();
    if (request === undefined) throw new Error('expected one fetch command');
    if (!('executable' in request) || request.executable !== 'git') {
      throw new Error('expected a git executable command');
    }
    const policy = new PolicyEngine();
    const operation = normalizeExecutableCommand('git', [...request.args], request.cwd);
    const decision = policy.evaluate(operation, { taskId });
    expect(decision.kind).toBe('ALLOW');

    const denyingSeen: SpawnRequest[] = [];
    const denyingStub: ProcessSpawner = {
      spawn: async (deniedRequest: SpawnRequest): Promise<SpawnResult> => {
        denyingSeen.push(deniedRequest);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const denying = harness({ approve: false, spawner: denyingStub });
    const denyingGit = new PolicyGitAdapter({ runner: denying.runner });
    await denyingGit.fetch(localBasePath, taskId);
    expect(denyingSeen).toHaveLength(1);
    expect(denying.consume).not.toHaveBeenCalled();
  });

  it('routes wslpath conversion through the policy-gated command runner', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000008';
    const linuxPath = '/home/gram/.gram-agent/worktrees/7/0191a2b3';
    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        return { exitCode: 0, stdout: 'C:\\gram\\worktrees\\7\\0191a2b3\n', stderr: '' };
      },
    };
    const policy = new PolicyEngine();
    const evaluate = vi.spyOn(policy, 'evaluate');
    const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => true);
    const runner = new CommandRunner({
      policy,
      approvals: { consume },
      spawner: stub,
      commandRuns: { start: () => 1, finish: () => undefined },
      outputCapture: {
        redactText: (text: string) => text,
        capture: async ({ stdout, stderr }: { stdout: string; stderr: string }) => ({
          stdout,
          stderr,
          stdoutPath: join(tmpdir(), 'gram-wslpath-stdout'),
          stderrPath: join(tmpdir(), 'gram-wslpath-stderr'),
        }),
      },
    });

    const pathRunner = new PolicyWslPathRunner({ runner });
    const windowsPath = await pathRunner.run(['-w', linuxPath], taskId);

    expect(windowsPath).toBe('C:\\gram\\worktrees\\7\\0191a2b3');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.executable).toBe('wslpath');
    expect(seen[0] === undefined ? [] : [...(seen[0]?.args ?? [])]).toEqual(['-w', linuxPath]);
    expect(seen[0]?.taskId).toBe(taskId);
    expect(evaluate).toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('classifies the issued worktree add as ALLOW and spawns without consuming approval', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000015';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const branch = 'feat/task-000015-worktree';
    const worktreePath = '/home/agent/.gram-agent/worktrees/7/0191a2b3-c4d5-7000-8000-000000000015';
    const baseRef = 'origin/main';
    const headSha = '0123456789abcdef0123456789abcdef01234567';

    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        if ((request.args ?? []).includes('rev-parse')) {
          return { exitCode: 0, stdout: `${headSha}\n`, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const { runner } = harness({ approve: true, spawner: stub });
    const adapter = new PolicyWorktreeAdapter({ runner });
    const created = await adapter.createWorktree({
      repoPath: localBasePath,
      worktreePath,
      baseRef,
      branch,
      taskId,
    });
    expect(created.headSha).toBe(headSha);
    const request = seen[0];
    expect(request).toBeDefined();
    if (request === undefined) throw new Error('expected one worktree add command');
    if (!('executable' in request) || request.executable !== 'git') {
      throw new Error('expected a git executable command');
    }
    expect([...(request.args ?? [])]).toEqual(['worktree', 'add', '-b', branch, worktreePath, baseRef]);
    expect([...(request.args ?? [])]).not.toContain('-C');
    expect(request.cwd).toBe(localBasePath);
    const policy = new PolicyEngine();
    const operation = normalizeExecutableCommand('git', [...(request.args ?? [])], request.cwd);
    expect(policy.evaluate(operation, { taskId }).kind).toBe('ALLOW');

    const denyingSeen: SpawnRequest[] = [];
    const denyingStub: ProcessSpawner = {
      spawn: async (deniedRequest: SpawnRequest): Promise<SpawnResult> => {
        denyingSeen.push(deniedRequest);
        if ((deniedRequest.args ?? []).includes('rev-parse')) {
          return { exitCode: 0, stdout: `${headSha}\n`, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const denying = harness({ approve: false, spawner: denyingStub });
    const denyingAdapter = new PolicyWorktreeAdapter({ runner: denying.runner });
    const denyingCreated = await denyingAdapter.createWorktree({
      repoPath: localBasePath,
      worktreePath,
      baseRef,
      branch,
      taskId,
    });
    expect(denyingCreated.headSha).toBe(headSha);
    expect(denyingSeen).toHaveLength(2);
    expect(denying.consume).not.toHaveBeenCalled();
  });

  it('allows the issued wslpath -w without consuming approval', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000016';
    const linuxPath = '/home/agent/.gram-agent/worktrees/7/0191a2b3-c4d5-7000-8000-000000000016';
    const windowsPath = 'C:\\gram\\worktrees\\7\\0191a2b3-c4d5-7000-8000-000000000016';
    const seen: SpawnRequest[] = [];
    const stub: ProcessSpawner = {
      spawn: async (request: SpawnRequest): Promise<SpawnResult> => {
        seen.push(request);
        return { exitCode: 0, stdout: `${windowsPath}\n`, stderr: '' };
      },
    };
    const denying = harness({ approve: false, spawner: stub });
    const pathRunner = new PolicyWslPathRunner({ runner: denying.runner });
    const result = await pathRunner.run(['-w', linuxPath], taskId);
    expect(result).toBe(windowsPath);
    expect(seen).toHaveLength(1);
    expect(seen[0] === undefined ? [] : [...(seen[0]?.args ?? [])]).toEqual(['-w', linuxPath]);
    expect(denying.consume).not.toHaveBeenCalled();
  });

  it('keeps approval denial for an unsupported worktree command', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000017';
    const root = trackRoot();
    const { localBasePath } = createCanonicalRepository(root);
    const denying = harness({ approve: false });
    await expect(
      denying.runner.run({
        taskId,
        cwd: localBasePath,
        category: 'GIT',
        executable: 'git',
        args: ['worktree', 'list'],
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(denying.consume).toHaveBeenCalledTimes(1);
    expect(denying.seen).toHaveLength(0);
  });
});
