import { describe, expect, it } from 'vitest';
import type { TaskId, TaskStatus } from '@gram/domain';
import {
  createTaskRunner,
  TaskRunnerConfigurationError,
} from './task-runner-composition.js';

const TASK_ID = 'task-3f6a1c9e-0b1a-4d2e-8f3a-9c4d5e6f7a8b' as TaskId;
const REPO_ID = 84722133;
const SHA = 'a91c34f0a91c34f0a91c34f0a91c34f0a91c34f0';

type RunEvent =
  | 'repo.resolve'
  | 'lock.acquire'
  | 'repo.fetch'
  | 'workspace.create'
  | 'instructions.load'
  | 'analyze'
  | 'modify'
  | 'verify'
  | 'commit'
  | 'push'
  | 'remote.confirm'
  | 'lock.release'
  | 'pr.ensure'
  | 'ci.observe'
  | 'complete';

// No shared profile cache (FV2-1): every adapter step resolves fresh,
// so repo.resolve recurs before workspace.create and before pr.ensure.
const EXPECTED_HAPPY_ORDER: RunEvent[] = [
  'repo.resolve',
  'lock.acquire',
  'repo.fetch',
  'repo.resolve',
  'workspace.create',
  'instructions.load',
  'analyze',
  'modify',
  'verify',
  'commit',
  'push',
  'remote.confirm',
  'lock.release',
  'repo.resolve',
  'pr.ensure',
  'ci.observe',
  'complete',
];

interface Controls {
  verifyError?: Error;
  publishError?: Error;
  confirmResult?: boolean;
  prError?: Error;
  ciOutcome?: 'SUCCESS' | 'FAILURE' | 'PENDING';
  omitInstructions?: boolean;
  useDefaultComplete?: boolean;
  initialStatus?: TaskStatus;
  currentHeadSha?: string;
  planHeadSha?: string | null;
  headShaSequence?: string[];
  approvedPaths?: readonly string[];
  statusEntries?: ReadonlyArray<{ path: string }>;
}

function successSnapshots() {
  return [
    {
      providerCheckId: 'check-1',
      checkName: 'ci',
      status: 'completed' as const,
      conclusion: 'success',
    },
  ];
}

function snapshotsFor(outcome: 'SUCCESS' | 'FAILURE' | 'PENDING') {
  if (outcome === 'SUCCESS') return successSnapshots();
  if (outcome === 'FAILURE') {
    return [
      {
        providerCheckId: 'check-1',
        checkName: 'ci',
        status: 'completed' as const,
        conclusion: 'failure',
      },
    ];
  }
  return [
    {
      providerCheckId: 'check-1',
      checkName: 'ci',
      status: 'in_progress' as const,
      conclusion: null,
    },
  ];
}

function createHarness(controls: Controls = {}) {
  const events: RunEvent[] = [];
  const repairEvents: string[] = [];
  const transitions: Array<{ from: TaskStatus; to: TaskStatus }> = [];
  const auditEvents: string[] = [];
  let status: TaskStatus = controls.initialStatus ?? 'QUEUED';

  const seen = {
    resolvedBranch: '',
    createdBranch: '',
    baseRef: '',
    publishedBranch: '',
    prHeadBranch: '',
  };

  const tasks = {
    get: (id: TaskId) =>
      id === TASK_ID
        ? {
            id: TASK_ID,
            seq: 201,
            goal: 'Fix Excel download URL',
            repoSelector: 'mamf-web',
            status,
            taskType: 'CODING',
          }
        : null,
    transition: (id: TaskId, from: TaskStatus, to: TaskStatus) => {
      if (id !== TASK_ID) throw new Error(`unknown task: ${id}`);
      if (status !== from) {
        throw new Error(`unexpected transition ${status} -> ${to}`);
      }
      transitions.push({ from, to });
      status = to;
    },
  };

  const audit = {
    append: (event: { eventType: string }) => {
      auditEvents.push(event.eventType);
      return undefined;
    },
  };

  const repos = {
    resolve: async (selector: string) => {
      events.push('repo.resolve');
      expect(selector).toBe('mamf-web');
      return {
        githubRepositoryId: REPO_ID,
        owner: 'acme',
        name: 'mamf-web',
        defaultBranch: 'main',
        localBasePath: '/base/mamf-web',
      };
    },
  };

  const locks = {
    acquire: async (repoId: number, taskId: TaskId) => {
      expect(repoId).toBe(REPO_ID);
      expect(taskId).toBe(TASK_ID);
      events.push('lock.acquire');
      return {
        release: async () => {
          events.push('lock.release');
        },
      };
    },
  };

  const headShaCalls: string[] = [];
  let headShaIndex = 0;
  const publishCalls: string[] = [];
  const publishedPaths: Array<readonly string[]> = [];
  let statusCalls = 0;
  const git = {
    fetch: async () => {
      events.push('repo.fetch');
    },
    status: async () => {
      statusCalls += 1;
      return { entries: controls.statusEntries ?? [{ path: 'src/app.ts' }] };
    },
    headSha: async (worktree: string) => {
      expect(worktree).toBe('/wt/mamf-web');
      if (controls.headShaSequence !== undefined && controls.headShaSequence.length > 0) {
        const sha =
          controls.headShaSequence[
            Math.min(headShaIndex, controls.headShaSequence.length - 1)
          ] ?? SHA;
        headShaIndex += 1;
        headShaCalls.push(sha);
        return sha;
      }
      const sha = controls.currentHeadSha ?? SHA;
      headShaCalls.push(sha);
      return sha;
    },
  };

  const worktrees = {
    create: async (input: { taskId: TaskId; branch: string; baseRef: string }) => {
      events.push('workspace.create');
      seen.createdBranch = input.branch;
      seen.baseRef = input.baseRef;
      return { linuxPath: '/wt/mamf-web', branch: input.branch };
    },
  };

  const capabilities: Record<string, unknown> = {
    analyze: {
      analyze: async () => {
        events.push('analyze');
        return { summary: 'fix excel url', files: ['src/app.ts'] };
      },
    },
    modify: {
      modify: async () => {
        events.push('modify');
        return { sha: SHA };
      },
    },
    repairMutations: {
      repair: async () => undefined,
    },
  };
  if (controls.omitInstructions !== true) {
    capabilities['instructions'] = {
      load: async () => {
        events.push('instructions.load');
        return { content: '# instructions', source: 'AGENTS.md' };
      },
    };
  }

  const verification = {
    requiredChecksPassed: (taskId: TaskId, headSha?: string) => {
      expect(taskId).toBe(TASK_ID);
      events.push('verify');
      if (controls.verifyError !== undefined) throw controls.verifyError;
      // F2C HEAD binding: stale unbound reads pass (pre-fix behavior), but
      // bound reads only pass when a plan exists for that exact HEAD.
      if (controls.planHeadSha !== undefined) {
        if (controls.planHeadSha === null) {
          if (headSha === undefined) return true;
          return false;
        }
        if (headSha === undefined) return true;
        return headSha === controls.planHeadSha;
      }
      return true;
    },
    listApprovedPaths: async (taskId: TaskId, headSha?: string) => {
      expect(taskId).toBe(TASK_ID);
      void headSha;
      // Pre-existing happy-path harnesses predate approved-path scoping:
      // default to the single reviewed path unless a test overrides it.
      return controls.approvedPaths ?? ['src/app.ts'];
    },
  };

  const publishing = {
    publish: async (context: {
      taskId: TaskId;
      branch: string;
      remote: string;
      paths: readonly string[];
      lock: { release(): Promise<void> };
    }) => {
      publishCalls.push(context.taskId);
      publishedPaths.push([...context.paths]);
      events.push('commit');
      if (controls.publishError !== undefined) throw controls.publishError;
      events.push('push');
      events.push('remote.confirm');
      if (controls.confirmResult === false) {
        throw new Error('remote confirm failed');
      }
      // PublishingService remains the sole lock-release owner.
      await context.lock.release();
      seen.publishedBranch = context.branch;
      return { sha: SHA, branch: context.branch, remote: context.remote };
    },
  };

  const pullRequests = {
    ensureForTask: async (task: { headBranch: string }) => {
      events.push('pr.ensure');
      if (controls.prError !== undefined) throw controls.prError;
      seen.prHeadBranch = task.headBranch;
      return { number: 7, url: 'https://example.com/pr/7' };
    },
  };

  const checks = {
    client: {
      listRequiredChecks: async () => {
        events.push('ci.observe');
        return snapshotsFor(controls.ciOutcome ?? 'SUCCESS');
      },
    },
    persistence: {
      upsertCheck: () => undefined,
    },
    delay: {
      wait: async () => undefined,
    },
  };

  const ciContext = {
    resolve: async (taskId: TaskId) => ({
      taskId,
      pullRequestId: 1,
      owner: 'acme',
      name: 'mamf-web',
      number: 7,
      headSha: SHA,
      baseBranch: 'main',
    }),
  };

  const workspaces = {
    getByTaskId: (taskId: TaskId) => {
      if (taskId !== TASK_ID) return undefined;
      return { linuxPath: '/wt/mamf-web', branch: 'fix/task-000201-fix-excel-download-url' };
    },
  };

  const remote = {
    push: async () => SHA,
    confirmRemoteSha: async () => controls.confirmResult !== false,
  };

  const options: Record<string, unknown> = {
    audit,
    tasks,
    repos,
    locks,
    git,
    worktrees,
    verification,
    publishing,
    pullRequests,
    checks,
    ciContext,
    capabilities,
    workspaces,
    remote,
  };
  if (controls.useDefaultComplete !== true) {
    options['complete'] = {
      complete: async (taskId: TaskId) => {
        events.push('complete');
        const current = tasks.get(taskId);
        if (current === null) throw new Error(`unknown task: ${taskId}`);
        if (current.status === 'COMPLETED') return;
        tasks.transition(taskId, current.status, 'COMPLETED');
      },
    };
  }

  const runner = createTaskRunner(options as never);
  return { runner, events, repairEvents, transitions, auditEvents, tasks, seen, publishCalls, headShaCalls, publishedPaths, getStatusCalls: () => statusCalls };
}

describe('task-runner composition', () => {
  it('runs the exact happy-path order and completes exactly once on success', async () => {
    const { runner, events, transitions, seen } = createHarness();

    await runner.run(TASK_ID);

    expect(events).toEqual(EXPECTED_HAPPY_ORDER);
    const completions = transitions.filter((t) => t.to === 'COMPLETED');
    expect(completions).toHaveLength(1);
    // Branch consistency across resolve -> workspace -> publish -> PR.
    expect(seen.createdBranch.length).toBeGreaterThan(0);
    expect(seen.publishedBranch).toBe(seen.createdBranch);
    expect(seen.prHeadBranch).toBe(seen.createdBranch);
    // W4-F4 RED: worktree adapter must receive remote-tracking origin/main, never bare local branch.
    expect(seen.baseRef).toBe('origin/main');
    expect(seen.baseRef).not.toBe('main');
    // PublishingService remains the sole lock-release owner: release precedes PR.
    expect(events.indexOf('lock.release')).toBeLessThan(events.indexOf('pr.ensure'));
  });

  it('rejects default completion from QUEUED as an illegal transition with state unchanged', async () => {
    const { runner, transitions, tasks } = createHarness({ useDefaultComplete: true });

    await expect(runner.run(TASK_ID)).rejects.toThrow(/not allowed|illegal-transition/i);
    expect(transitions.filter((t) => t.to === 'COMPLETED')).toHaveLength(0);
    expect(tasks.get(TASK_ID)?.status).toBe('QUEUED');
  });

  it('completes via the default CompletePort from PUBLISHING exactly once', async () => {
    const { runner, transitions } = createHarness({
      useDefaultComplete: true,
      initialStatus: 'PUBLISHING',
    });

    await runner.run(TASK_ID);

    expect(transitions).toEqual([{ from: 'PUBLISHING', to: 'COMPLETED' }]);
  });

  it('prevents publication when verification rejects', async () => {
    const { runner, events } = createHarness({
      verifyError: new Error('verification failed'),
    });

    await expect(runner.run(TASK_ID)).rejects.toThrow('verification failed');
    expect(events).toEqual([
      'repo.resolve',
      'lock.acquire',
      'repo.fetch',
      'repo.resolve',
      'workspace.create',
      'instructions.load',
      'analyze',
      'modify',
      'verify',
    ]);
  });

  it('prevents PR and CI when publication rejects and leaves the lease held', async () => {
    const { runner, events } = createHarness({
      publishError: new Error('publish failed'),
    });

    await expect(runner.run(TASK_ID)).rejects.toThrow('publish failed');
    expect(events).not.toContain('lock.release');
    expect(events).not.toContain('pr.ensure');
    expect(events).not.toContain('ci.observe');
    expect(events).not.toContain('complete');
  });

  it('leaves the lease held when remote confirmation fails', async () => {
    const { runner, events } = createHarness({ confirmResult: false });

    await expect(runner.run(TASK_ID)).rejects.toThrow('remote confirm failed');
    expect(events).not.toContain('lock.release');
    expect(events).not.toContain('pr.ensure');
    expect(events).not.toContain('complete');
  });

  it('does not complete on CI PENDING', async () => {
    const { runner, events, transitions } = createHarness({ ciOutcome: 'PENDING' });

    await runner.run(TASK_ID);

    expect(events).toContain('lock.release');
    expect(events).toContain('pr.ensure');
    expect(events).toContain('ci.observe');
    expect(events).not.toContain('complete');
    expect(transitions.filter((t) => t.to === 'COMPLETED')).toHaveLength(0);
  });

  it('does not complete on CI FAILURE', async () => {
    const { runner, events, transitions } = createHarness({ ciOutcome: 'FAILURE' });

    await runner.run(TASK_ID);

    expect(events).toContain('ci.observe');
    expect(events).not.toContain('complete');
    expect(transitions.filter((t) => t.to === 'COMPLETED')).toHaveLength(0);
  });

  it('preserves the repair-cycle order and lifecycle', async () => {
    const { runner, repairEvents, auditEvents } = createHarness();

    const result = await runner.runRepairCycle(
      {
        taskId: TASK_ID,
        repoId: REPO_ID,
        branch: 'fix/task-000201-fix-excel-download-url',
        remote: 'origin',
        ciOutcome: 'FAILURE',
      },
      (event) => {
        repairEvents.push(event);
      },
    );

    expect(repairEvents).toEqual([
      'ci.failed',
      'lock.acquire',
      'workspace.reuse',
      'repair',
      'verify',
      'push',
      'remote.confirm',
      'lock.release',
      'ci.observe',
    ]);
    expect(result.sha).toBe(SHA);
    expect(result.ciOutcome).toBe('SUCCESS');
    expect(auditEvents).toContain('REPAIR_CYCLE_STARTED');
    expect(auditEvents).toContain('REPAIR_CYCLE_COMPLETED');
  });

  it('isolates concurrent repository fetches per task with no shared resolution state', async () => {
    const TASK_A = 'task-aaaaaaaa-0b1a-4d2e-8f3a-9c4d5e6f7a8b' as TaskId;
    const TASK_B = 'task-bbbbbbbb-0b1a-4d2e-8f3a-9c4d5e6f7a8b' as TaskId;
    const REPO_A = 11111111;
    const REPO_B = 22222222;
    const PATH_A = '/base/repo-a';
    const PATH_B = '/base/repo-b';

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }
    const aResolveDone = deferred();
    const bResolveDone = deferred();

    const statuses = new Map<TaskId, TaskStatus>([
      [TASK_A, 'QUEUED'],
      [TASK_B, 'QUEUED'],
    ]);
    const records = new Map<TaskId, { seq: number; goal: string; repoSelector: string }>([
      [TASK_A, { seq: 301, goal: 'Task A goal', repoSelector: 'repo-a' }],
      [TASK_B, { seq: 302, goal: 'Task B goal', repoSelector: 'repo-b' }],
    ]);
    const tasksStore = {
      get: (id: TaskId) => {
        const rec = records.get(id);
        const status = statuses.get(id);
        if (rec === undefined || status === undefined) return null;
        return { id, seq: rec.seq, goal: rec.goal, repoSelector: rec.repoSelector, status, taskType: 'CODING' };
      },
      transition: (id: TaskId, from: TaskStatus, to: TaskStatus) => {
        const current = statuses.get(id);
        if (current !== from) throw new Error(`unexpected transition ${current} -> ${to} for ${id}`);
        statuses.set(id, to);
      },
    };
    const auditStub = { append: () => undefined };

    const reposAB = {
      resolve: async (selector: string) => {
        if (selector === 'repo-a') {
          const profile = {
            githubRepositoryId: REPO_A,
            owner: 'acme',
            name: 'repo-a',
            defaultBranch: 'main',
            localBasePath: PATH_A,
          };
          aResolveDone.resolve();
          return profile;
        }
        // Force deterministic A resolve -> B resolve ordering.
        await aResolveDone.promise;
        const profile = {
          githubRepositoryId: REPO_B,
          owner: 'acme',
          name: 'repo-b',
          defaultBranch: 'main',
          localBasePath: PATH_B,
        };
        bResolveDone.resolve();
        return profile;
      },
    };

    const locksAB = {
      acquire: async (repoId: number, taskId: TaskId) => {
        if (taskId === TASK_A) {
          // Pause A past B's resolve so both fetches happen after both resolves.
          await bResolveDone.promise;
        }
        return { release: async () => undefined };
      },
    };

    const fetchedPaths: string[] = [];
    const gitAB = {
      fetch: async (repoPath: string) => {
        fetchedPaths.push(repoPath);
      },
      status: async () => ({ entries: [{ path: 'src/app.ts' }] }),
      headSha: async () => SHA,
    };

    const worktreesAB = {
      create: async (input: { taskId: TaskId; branch: string }) => ({
        linuxPath: `/wt/${input.taskId}`,
        branch: input.branch,
      }),
    };

    const verificationAB = { requiredChecksPassed: () => true, listApprovedPaths: () => ['src/app.ts'] };
    const publishingAB = {
      publish: async (context: { taskId: TaskId; branch: string; remote: string; lock: { release(): Promise<void> } }) => {
        await context.lock.release();
        return { sha: SHA, branch: context.branch, remote: context.remote };
      },
    };
    const pullRequestsAB = {
      ensureForTask: async () => ({ number: 7, url: 'https://example.com/pr/7' }),
    };
    const checksAB = {
      client: { listRequiredChecks: async () => successSnapshots() },
      persistence: { upsertCheck: () => undefined },
      delay: { wait: async () => undefined },
    };
    const ciContextAB = {
      resolve: async (taskId: TaskId) => ({
        taskId,
        pullRequestId: 1,
        owner: 'acme',
        name: 'repo',
        number: 7,
        headSha: SHA,
        baseBranch: 'main',
      }),
    };
    const capabilitiesAB: Record<string, unknown> = {
      instructions: { load: async () => ({ content: '# instructions', source: 'AGENTS.md' }) },
      analyze: { analyze: async () => ({ summary: 's', files: ['src/app.ts'] }) },
      modify: { modify: async () => ({ sha: SHA }) },
      repairMutations: { repair: async () => undefined },
    };
    const workspacesAB = {
      getByTaskId: (taskId: TaskId) => ({ linuxPath: `/wt/${taskId}`, branch: 'b' }),
    };
    const remoteAB = { push: async () => SHA, confirmRemoteSha: async () => true };
    const completeAB = {
      complete: async (taskId: TaskId) => {
        const current = tasksStore.get(taskId);
        if (current === null) throw new Error(`unknown task: ${taskId}`);
        if (current.status === 'COMPLETED') return;
        tasksStore.transition(taskId, current.status, 'COMPLETED');
      },
    };

    const runnerAB = createTaskRunner({
      audit: auditStub,
      tasks: tasksStore,
      repos: reposAB,
      locks: locksAB,
      git: gitAB,
      worktrees: worktreesAB,
      verification: verificationAB,
      publishing: publishingAB,
      pullRequests: pullRequestsAB,
      checks: checksAB,
      ciContext: ciContextAB,
      capabilities: capabilitiesAB,
      workspaces: workspacesAB,
      remote: remoteAB,
      complete: completeAB,
    } as never);

    await Promise.all([runnerAB.run(TASK_A), runnerAB.run(TASK_B)]);

    // Each fetch must receive its own task identity: one fetch per localBasePath.
    expect(fetchedPaths).toHaveLength(2);
    expect(fetchedPaths.filter((p) => p === PATH_A)).toHaveLength(1);
    expect(fetchedPaths.filter((p) => p === PATH_B)).toHaveLength(1);
  });

  it('fails closed with a typed configuration error when repo resolution is unwired', async () => {
    const { tasks } = createHarness();
    const audit = { append: () => undefined };
    const runner = createTaskRunner({ audit, tasks } as never);

    const error = await runner.run(TASK_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskRunnerConfigurationError);
    expect((error as Error).message).toMatch(/RepoResolve/);
  });

  it('fails closed with a named adapter error when instruction loading is unwired', async () => {
    const { runner } = createHarness({ omitInstructions: true });

    const error = await runner.run(TASK_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskRunnerConfigurationError);
    expect((error as Error).message).toMatch(/Instructions/);
    expect((error as TaskRunnerConfigurationError).adapter).toBe('Instructions');
  });

  it('blocks publish when no verification plan exists for the current HEAD', async () => {
    const OTHER_SHA = 'b2c34f0ab2c34f0ab2c34f0ab2c34f0ab2c34f0a';
    const { runner, events, publishCalls } = createHarness({
      currentHeadSha: OTHER_SHA,
      planHeadSha: null,
    });

    await expect(runner.run(TASK_ID)).rejects.toThrow();
    expect(publishCalls).toHaveLength(0);
    expect(events).not.toContain('commit');
    expect(events).not.toContain('push');
    expect(events).not.toContain('pr.ensure');
    expect(events).not.toContain('complete');
  });

  it('blocks publish when verification HEAD differs from current HEAD', async () => {
    const OTHER_SHA = 'c3d45f1bc3d45f1bc3d45f1bc3d45f1bc3d45f1b';
    const { runner, events, publishCalls } = createHarness({
      headShaSequence: [SHA, OTHER_SHA],
    });

    await expect(runner.run(TASK_ID)).rejects.toThrow(/HEAD|verification|stale/i);
    expect(publishCalls).toHaveLength(0);
    expect(events).not.toContain('pr.ensure');
    expect(events).not.toContain('complete');
  });

  it('publishes only diff-review-approved paths and excludes unrelated modified + untracked entries', async () => {
    const APPROVED = 'src/app.ts';
    const { runner, publishedPaths, getStatusCalls } = createHarness({
      approvedPaths: [APPROVED],
      statusEntries: [{ path: APPROVED }, { path: 'src/unrelated.ts' }, { path: 'notes/scratch.txt' }],
    });

    await runner.run(TASK_ID);

    expect(publishedPaths).toHaveLength(1);
    expect(publishedPaths[0]).toEqual([APPROVED]);
    expect(publishedPaths[0]).not.toContain('src/unrelated.ts');
    expect(publishedPaths[0]).not.toContain('notes/scratch.txt');
    void getStatusCalls;
  });

  it('blocks publish when verification approves no paths', async () => {
    const { runner, events, publishCalls } = createHarness({
      approvedPaths: [],
      statusEntries: [{ path: 'src/app.ts' }],
    });

    await expect(runner.run(TASK_ID)).rejects.toThrow(/approved paths|no approved/i);
    expect(publishCalls).toHaveLength(0);
    expect(events).not.toContain('commit');
    expect(events).not.toContain('pr.ensure');
    expect(events).not.toContain('complete');
  });

  it('resolves the repository profile fresh on every adapter step with no shared cache', async () => {
    const { runner, events } = createHarness({
      approvedPaths: ['src/app.ts'],
    });

    await runner.run(TASK_ID);

    // RepoResolve + WorkspaceCreate + PrEnsure each resolve fresh:
    // the underlying registry read must run once per adapter step.
    expect(events.filter((e) => e === 'repo.resolve')).toHaveLength(3);
  });

  it('passes deleted/renamed diff-review paths through verbatim without status reconstruction', async () => {
    const DELETED = 'src/removed.ts';
    const { runner, publishedPaths } = createHarness({
      approvedPaths: [DELETED],
      statusEntries: [{ path: 'src/unrelated.ts' }],
    });

    await runner.run(TASK_ID);

    expect(publishedPaths).toHaveLength(1);
    expect(publishedPaths[0]).toEqual([DELETED]);
    expect(publishedPaths[0]).not.toContain('src/unrelated.ts');
  });
});
