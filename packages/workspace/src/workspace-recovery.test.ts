import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRecovery } from './workspace-recovery.js';
import { createRecoveryFixture } from './workspace-recovery.fixture.js';

// Observe real metadata reads to prove the authorization check precedes them.
// The spy forwards every call; filesystem results are never manufactured.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});

const fixtures: Array<Awaited<ReturnType<typeof createRecoveryFixture>>> = [];
async function setup(options: Parameters<typeof createRecoveryFixture>[0] = { approved: true }) {
  const fixture = await createRecoveryFixture(options);
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
});

describe('WorkspaceRecovery read-only Git assessment', () => {
  it.each(['linked', 'standalone'] as const)(
    'reports a clean expected branch in a %s workspace',
    async (layout) => {
      const f = await setup({ layout, approved: true });
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({
        state: 'CLEAN',
        exists: true,
        branch: 'fix/task-000001-workspace-recovery',
        headSha: f.initialSha,
        dirty: false,
        unpushed: false,
        indexLockPresent: false,
        expectedBranchMatches: true,
        reasons: [],
      });
      expect(f.snapshot()).toEqual(before);
      expect(f.workspaces.getByTaskId(f.workspace.taskId)).toEqual(f.workspace);
      expect(f.spawned.length).toBeGreaterThan(0);
      expect(
        f.approvals.listForTask(f.workspace.taskId).every((a) => a.status === 'CONSUMED'),
      ).toBe(true);
    },
  );

  it('reports a wrong branch as conflict without changing it back', async () => {
    const f = await setup();
    f.git(['checkout', '-b', 'fix/task-000001-unexpected', 'origin/main'], f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'CONFLICT',
      branch: 'fix/task-000001-unexpected',
      headSha: f.initialSha,
      dirty: false,
      expectedBranchMatches: false,
    });
    expect(result.reasons).toContain('BRANCH_MISMATCH');
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['tracked', 'staged', 'untracked'] as const)(
    'preserves and reports %s changes as dirty',
    async (change) => {
      const f = await setup();
      const file = change === 'untracked' ? 'new\nfile.txt' : 'tracked.txt';
      writeFileSync(join(f.workspace.linuxPath, file), 'interrupted work\n');
      if (change === 'staged') f.git(['add', file], f.workspace.linuxPath);
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({
        state: 'DIRTY',
        dirty: true,
        unpushed: false,
        expectedBranchMatches: true,
      });
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('reports a local commit absent from the cached upstream without pushing it', async () => {
    const f = await setup();
    writeFileSync(join(f.workspace.linuxPath, 'tracked.txt'), 'local commit\n');
    f.git(['add', 'tracked.txt'], f.workspace.linuxPath);
    f.git(['commit', '-m', 'not pushed'], f.workspace.linuxPath);
    const localSha = f.git(['rev-parse', 'HEAD'], f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'UNPUSHED',
      headSha: localSha,
      dirty: false,
      unpushed: true,
      expectedBranchMatches: true,
    });
    expect(result.headSha).not.toBe(f.initialSha);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['linked', 'standalone'] as const)(
    'finds and preserves the actual %s index lock',
    async (layout) => {
      const f = await setup({ layout, approved: true });
      expect(lstatSync(join(f.workspace.linuxPath, '.git')).isFile()).toBe(layout === 'linked');
      const lockPath = join(f.gitDir, 'index.lock');
      writeFileSync(lockPath, 'interrupted owner\n');
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({ state: 'CONFLICT', exists: true, indexLockPresent: true });
      expect(result.reasons).toContain('INDEX_LOCK_PRESENT');
      expect(readFileSync(lockPath, 'utf8')).toBe('interrupted owner\n');
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('reports a missing registered task directory without recreating it', async () => {
    const f = await setup();
    rmSync(f.workspace.linuxPath, { recursive: true });
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'MISSING',
      exists: false,
      branch: null,
      headSha: null,
      dirty: null,
      unpushed: null,
      indexLockPresent: null,
      expectedBranchMatches: null,
    });
    expect(f.spawned).toHaveLength(0);
    expect(f.snapshot()).toEqual(before);
  });

  it('does not refresh the index even when a tracked file stat cache is stale', async () => {
    const f = await setup();
    const tracked = join(f.workspace.linuxPath, 'tracked.txt');
    const previous = statSync(tracked);
    utimesSync(tracked, previous.atime, new Date(previous.mtimeMs - 60_000));
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'CLEAN', dirty: false });
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['linked', 'standalone'] as const)(
    'preserves a %s split index without letting Git renew its shared metadata',
    async (layout) => {
      const f = await setup({ layout, approved: true });
      f.git(['update-index', '--split-index'], f.workspace.linuxPath);
      const sharedIndexes = readdirSync(f.gitDir).filter((name) => name.startsWith('sharedindex.'));
      expect(sharedIndexes.length).toBeGreaterThan(0);
      // Explicitly stale metadata makes a read-side timestamp update observable.
      const old = new Date(1_600_000_000_000);
      for (const name of sharedIndexes) utimesSync(join(f.gitDir, name), old, old);
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect.soft(f.snapshot()).toEqual(before);
      expect(result).toMatchObject({ state: 'UNKNOWN', exists: true, dirty: null, unpushed: null });
      expect(result.reasons).toContain('SPLIT_INDEX_UNSUPPORTED');
      expect(f.spawned).toHaveLength(0);
    },
  );

  it.each(['linked', 'standalone'] as const)(
    'can inspect an unsplit %s index when only core.splitIndex is configured',
    async (layout) => {
      const f = await setup({ layout, approved: true });
      f.git(['config', 'core.splitIndex', 'true'], f.workspace.linuxPath);
      expect(readdirSync(f.gitDir).some((name) => name.startsWith('sharedindex.'))).toBe(false);
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({ state: 'CLEAN', dirty: false, unpushed: false });
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('keeps the pinned policy approval gate and reports UNKNOWN before spawning without approval', async () => {
    const f = await setup({ approved: false });
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'UNKNOWN',
      exists: true,
      dirty: null,
      unpushed: null,
      indexLockPresent: false,
    });
    expect(result.reasons).toContain('POLICY_BLOCKED');
    expect(f.spawned).toHaveLength(0);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM command_runs').get()).toEqual({ count: 0 });
    expect(f.snapshot()).toEqual(before);
  });

  it('does not interpret a missing upstream as having no unpushed commits', async () => {
    const f = await setup();
    f.git(['branch', '--unset-upstream'], f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'UNKNOWN',
      headSha: f.initialSha,
      dirty: false,
      unpushed: null,
      expectedBranchMatches: true,
    });
    expect(result.reasons).toContain('UPSTREAM_UNAVAILABLE');
    expect(f.snapshot()).toEqual(before);
  });

  it('reports a detached HEAD as conflict, never as the expected branch', async () => {
    const f = await setup();
    f.git(['checkout', '--detach'], f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'CONFLICT',
      branch: null,
      headSha: f.initialSha,
      expectedBranchMatches: false,
    });
    expect(result.reasons).toContain('DETACHED_HEAD');
    expect(f.snapshot()).toEqual(before);
  });

  it('reports an unborn HEAD explicitly without inventing a commit', async () => {
    const f = await setup({ layout: 'standalone', approved: true });
    rmSync(f.workspace.linuxPath, { recursive: true });
    f.git(['init', `--initial-branch=${f.workspace.branch}`, f.workspace.linuxPath]);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'UNKNOWN',
      headSha: null,
      dirty: false,
      unpushed: null,
      expectedBranchMatches: true,
    });
    expect(result.reasons).toContain('UNBORN_HEAD');
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['HEAD', 'index'] as const)(
    'reports actual corrupt Git %s failure as UNKNOWN and preserves a known lock',
    async (file) => {
      const f = await setup();
      writeFileSync(join(f.gitDir, file), 'corrupt interrupted metadata\n');
      writeFileSync(join(f.gitDir, 'index.lock'), 'keep owner\n');
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({
        state: 'CONFLICT',
        exists: true,
        dirty: null,
        unpushed: null,
        indexLockPresent: true,
      });
      expect(result.reasons).toContain('GIT_FAILED');
      expect(result.reasons).toContain('INDEX_LOCK_PRESENT');
      expect(f.snapshot()).toEqual(before);
    },
  );

  it.each(['taskId', 'repoId', 'linuxPath', 'branch'] as const)(
    'rejects a forged %s before any Git execution',
    async (field) => {
      const f = await setup();
      const forged = { ...f.workspace, [field]: field === 'repoId' ? 999 : 'another-task-or-path' };
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(forged);
      expect(result).toMatchObject({
        state: 'CONFLICT',
        exists: null,
        branch: null,
        headSha: null,
        dirty: null,
      });
      expect(result.reasons).toContain('WORKSPACE_BINDING_MISMATCH');
      expect(f.spawned).toHaveLength(0);
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('rejects a symlinked task directory instead of inspecting the canonical checkout', async () => {
    const f = await setup();
    rmSync(f.workspace.linuxPath, { recursive: true });
    symlinkSync(f.repoPath, f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result.state).toBe('CONFLICT');
    expect(result.reasons).toContain('WORKSPACE_PATH_INVALID');
    expect(f.spawned).toHaveLength(0);
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects a .git pointer to another task before Git can follow it', async () => {
    const f = await setup();
    const other = f.tasks.create({
      goal: 'Other task',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: f.workspace.repoId,
    });
    const otherPath = join(
      f.homeDir,
      '.gram-agent',
      'worktrees',
      String(f.workspace.repoId),
      other.id,
    );
    f.git(['worktree', 'add', '-b', 'fix/task-000002-other', otherPath, 'origin/main'], f.repoPath);
    writeFileSync(join(f.workspace.linuxPath, '.git'), readFileSync(join(otherPath, '.git')));
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result.state).toBe('CONFLICT');
    expect(result.reasons).toContain('GIT_METADATA_CONFLICT');
    expect(f.spawned).toHaveLength(0);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['commondir', 'gitdir'] as const)(
    'rejects a forged linked-worktree %s binding',
    async (file) => {
      const f = await setup();
      writeFileSync(join(f.gitDir, file), `${f.remotePath}\n`);
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result.state).toBe('CONFLICT');
      expect(result.reasons).toContain('GIT_METADATA_CONFLICT');
      expect(f.spawned).toHaveLength(0);
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('reports missing .git metadata as UNKNOWN without searching an ancestor repository', async () => {
    const f = await setup();
    rmSync(join(f.workspace.linuxPath, '.git'));
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'UNKNOWN', exists: true, dirty: null, unpushed: null });
    expect(result.reasons).toContain('GIT_METADATA_UNAVAILABLE');
    expect(f.spawned).toHaveLength(0);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['', '# branch.oid garbage\0# branch.head task\0', 'unparseable\0'])(
    'rejects malformed successful Git output %#',
    async (stdout) => {
      const f = await setup();
      const before = f.snapshot();
      const runner = {
        run: async (request: Parameters<typeof f.runner.run>[0]) => {
          const result = await f.runner.run(request);
          return request.args.includes('status') ? { ...result, stdout } : result;
        },
      };
      const result = await new WorkspaceRecovery({ ...f.recoveryOptions, runner }).inspect(
        f.workspace,
      );
      expect(result).toMatchObject({ state: 'UNKNOWN', dirty: null, unpushed: null });
      expect(result.reasons).toContain('INVALID_GIT_OUTPUT');
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('disables a configured fsmonitor hook rather than allowing inspection to execute it', async () => {
    const f = await setup();
    const marker = join(f.root, 'fsmonitor-executed');
    const hook = join(f.root, 'fsmonitor-hook');
    writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
    f.git(['config', 'core.fsmonitor', hook], f.repoPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result.state).toBe('CLEAN');
    expect(existsSync(marker)).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });

  it('refuses content filters before status can execute a configured clean process', async () => {
    const f = await setup();
    const marker = join(f.root, 'filter-executed');
    f.git(['config', 'filter.unsafe.clean', `touch '${marker}'; cat`], f.repoPath);
    writeFileSync(join(f.workspace.linuxPath, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    writeFileSync(join(f.workspace.linuxPath, 'tracked.txt'), 'requires hashing\n');
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'UNKNOWN', dirty: null, unpushed: null });
    expect(result.reasons).toContain('UNSUPPORTED_GIT_CONFIG');
    expect(existsSync(marker)).toBe(false);
    expect(f.spawned.some((request) => request.args.includes('status'))).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });

  it('reports submodules as unassessed and does not recurse into their worktrees', async () => {
    const f = await setup();
    f.git(
      ['update-index', '--add', '--cacheinfo', `160000,${f.initialSha},nested`],
      f.workspace.linuxPath,
    );
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'UNKNOWN', dirty: null, unpushed: null });
    expect(result.reasons).toContain('SUBMODULES_UNASSESSED');
    expect(f.spawned.some((request) => request.args.includes('status'))).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });

  it('does not call truncated shallow history a complete upstream comparison', async () => {
    const f = await setup();
    writeFileSync(join(f.repoPath, '.git', 'shallow'), `${f.initialSha}\n`);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'UNKNOWN', unpushed: null });
    expect(result.reasons).toContain('SHALLOW_REPOSITORY');
    expect(f.snapshot()).toEqual(before);
  });

  it.each([false, true])(
    'preserves a real unmerged conflict (upstream approval missing: %s)',
    async (missingApproval) => {
      const f = await setup();
      f.git(['checkout', '-b', 'conflicting-side'], f.repoPath);
      writeFileSync(join(f.repoPath, 'tracked.txt'), 'other side\n');
      f.git(['add', 'tracked.txt'], f.repoPath);
      f.git(['commit', '-m', 'other side'], f.repoPath);
      writeFileSync(join(f.workspace.linuxPath, 'tracked.txt'), 'task side\n');
      f.git(['add', 'tracked.txt'], f.workspace.linuxPath);
      f.git(['commit', '-m', 'task side'], f.workspace.linuxPath);
      expect(() => f.git(['merge', 'conflicting-side'], f.workspace.linuxPath)).toThrow();
      if (missingApproval) {
        // The fixture's final fixed grant is the symbolic upstream query.
        const grant = f.approvals.listForTask(f.workspace.taskId).at(-1);
        if (grant === undefined) throw new Error('Missing fixture upstream approval');
        expect(f.approvals.consume(f.workspace.taskId, grant.operationHash)).toBe(true);
      }
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result.reasons).toContain('UNMERGED_CHANGES');
      expect(result).toMatchObject({ state: 'CONFLICT', dirty: true, expectedBranchMatches: true });
      if (missingApproval) {
        expect(result.reasons).toContain('POLICY_BLOCKED');
        expect(result.unpushed).toBeNull();
      }
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('reports an unfinished merge even when its index and working files are clean', async () => {
    const f = await setup();
    f.git(['checkout', '-b', 'empty-merge-side'], f.repoPath);
    f.git(['commit', '--allow-empty', '-m', 'empty side'], f.repoPath);
    f.git(['merge', '--no-ff', '--no-commit', 'empty-merge-side'], f.workspace.linuxPath);
    expect(existsSync(join(f.gitDir, 'MERGE_HEAD'))).toBe(true);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({
      state: 'CONFLICT',
      dirty: false,
      unpushed: false,
      expectedBranchMatches: true,
    });
    expect(result.reasons).toContain('GIT_OPERATION_IN_PROGRESS');
    expect(f.snapshot()).toEqual(before);
  });

  it('does not accept an exit-zero Git warning about unreadable attributes as clean evidence', async () => {
    const f = await setup();
    const attributes = join(f.homeDir, 'attributes-loop');
    symlinkSync('attributes-loop', attributes);
    f.git(['config', 'core.attributesFile', attributes], f.repoPath);
    const diagnostics: Array<{ exitCode: number; stderr: string }> = [];
    const runner = {
      run: async (request: Parameters<typeof f.runner.run>[0]) => {
        const result = await f.runner.run(request);
        if (result.stderr !== '') diagnostics.push(result);
        return result;
      },
    };
    const before = f.snapshot();
    const result = await new WorkspaceRecovery({ ...f.recoveryOptions, runner }).inspect(
      f.workspace,
    );
    expect(
      diagnostics.some(
        (entry) => entry.exitCode === 0 && entry.stderr.includes('Too many levels of symbolic links'),
      ),
    ).toBe(true);
    expect(result).toMatchObject({ state: 'UNKNOWN', unpushed: null });
    expect(result.reasons).toContain('GIT_DIAGNOSTIC');
    expect(JSON.stringify(result)).not.toContain(attributes);
    expect(f.snapshot()).toEqual(before);
  });

  it('reports index changes observed during inspection instead of returning a stable CLEAN assessment', async () => {
    const f = await setup();
    const runner = {
      run: async (request: Parameters<typeof f.runner.run>[0]) => {
        const result = await f.runner.run(request);
        if (request.args.includes('status')) {
          const path = join(f.gitDir, 'index');
          const before = statSync(path);
          // Simulates a concurrent writer, independently of the inspector.
          utimesSync(path, before.atime, new Date(before.mtimeMs + 60_000));
        }
        return result;
      },
    };
    const result = await new WorkspaceRecovery({ ...f.recoveryOptions, runner }).inspect(
      f.workspace,
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain('GIT_STATE_CHANGED');
  });

  it('checks canonical parent containment before reading the task directory metadata', async () => {
    const f = await setup();
    const parent = dirname(f.workspace.linuxPath);
    const foreignParent = join(f.root, 'foreign-tasks');
    renameSync(parent, foreignParent);
    symlinkSync(foreignParent, parent);
    vi.mocked(lstatSync).mockClear();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result.state).toBe('CONFLICT');
    expect(result.reasons).toContain('WORKSPACE_PATH_INVALID');
    expect(vi.mocked(lstatSync).mock.calls.some((call) => call[0] === f.workspace.linuxPath)).toBe(
      false,
    );
    expect(f.spawned).toHaveLength(0);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'does not call hidden changes CLEAN with the %s index flag',
    async (flag) => {
      const f = await setup();
      f.git(['update-index', flag, 'tracked.txt'], f.workspace.linuxPath);
      writeFileSync(join(f.workspace.linuxPath, 'tracked.txt'), 'hidden interrupted edit\n');
      const before = f.snapshot();
      const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
      expect(result).toMatchObject({ state: 'UNKNOWN', dirty: null });
      expect(result.reasons).toContain('UNSUPPORTED_INDEX_FLAGS');
      expect(f.snapshot()).toEqual(before);
    },
  );

  it('does not treat a local-only upstream as evidence that a local commit was pushed', async () => {
    const f = await setup();
    writeFileSync(join(f.workspace.linuxPath, 'tracked.txt'), 'not on any remote\n');
    f.git(['add', 'tracked.txt'], f.workspace.linuxPath);
    f.git(['commit', '-m', 'local only'], f.workspace.linuxPath);
    f.git(['branch', 'local-only'], f.workspace.linuxPath);
    f.git(['branch', '--set-upstream-to=local-only'], f.workspace.linuxPath);
    const before = f.snapshot();
    const result = await new WorkspaceRecovery(f.recoveryOptions).inspect(f.workspace);
    expect(result).toMatchObject({ state: 'UNKNOWN', dirty: false, unpushed: null });
    expect(result.reasons).toContain('UPSTREAM_UNAVAILABLE');
    expect(f.snapshot()).toEqual(before);
  });
});
