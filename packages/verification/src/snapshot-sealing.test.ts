import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRunRepository,
  RepositoryRepository,
  WorkspaceRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
  VerificationRepository,
  type VerificationSnapshot,
} from '@gram/persistence';
import { EvidenceCollector } from './evidence-collector.js';
import { VerificationRunner, type VerificationGateResult } from './verification-runner.js';
import type { PlannedVerificationCheck } from './verification-planner.js';

const databases: Array<{ close(): void }> = [];
const HEAD = 'a'.repeat(40);

function setup(
  options: {
    checks?: PlannedVerificationCheck[];
    headSha?: string | null;
    snapshots?: boolean;
    seal?: boolean;
    exitCode?: number;
    capture?: (snapshot: VerificationSnapshot, count: number) => VerificationSnapshot;
    scan?: () => VerificationGateResult;
    review?: () => VerificationGateResult & { changedPaths?: readonly string[] };
  } = {},
) {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  const task = new TaskRepository(db).create({ goal: 'verify', taskType: 'CODING', publishMode: 'PULL_REQUEST' });
  new RepositoryRepository(db).upsert({ githubRepositoryId: 158, owner: 'fixture', name: 'repo', defaultBranch: 'main', localBasePath: '/worktree' });
  new WorkspaceRepository(db).create({ taskId: task.id, repoId: 158, linuxPath: '/worktree', branch: 'fixture' });
  const repository = new VerificationRepository(db);
  const collector = new EvidenceCollector(repository);
  const commands = new CommandRunRepository(db);
  const events: string[] = [];
  const plan = collector.persistPlan({
    taskId: task.id,
    headSha: options.headSha === undefined ? HEAD : options.headSha,
    plan: {
      changeClass: 'OTHER',
      checks: options.checks ?? [
        { name: 'test', kind: 'COMMAND', required: true, status: 'PENDING', command: 'pnpm test' },
        { name: 'secret-scan', kind: 'NON_COMMAND', required: true, status: 'PENDING' },
        { name: 'diff-review', kind: 'NON_COMMAND', required: true, status: 'PENDING' },
      ],
    },
  });
  const snapshot: VerificationSnapshot = {
    version: 1,
    taskId: task.id,
    headSha: HEAD,
    entries: [
      { path: 'old.ts', mode: '000000', oid: null },
      { path: 'src/app.ts', mode: '100644', oid: 'b'.repeat(40) },
      { path: 'unrelated.txt', mode: '100644', oid: 'c'.repeat(40) },
    ],
  };
  let captureCount = 0;
  const runner = new VerificationRunner({
    commands: {
      async run(input) {
        events.push('command');
        const id = commands.start(input);
        const exitCode = options.exitCode ?? 0;
        commands.finish(id, { status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode });
        return { commandRunId: id, exitCode, stdout: '', stderr: '', stdoutPath: '/out', stderrPath: '/err' };
      },
    },
    evidence: {
      recordCommandResult: (input) => {
        collector.recordCommandResult(input);
        events.push('command-evidence');
      },
      recordNonCommandResult: (input) => {
        collector.recordNonCommandResult(input);
        events.push(`evidence:${input.checkId}`);
      },
      ...(options.seal === false
        ? {}
        : {
            sealSnapshot: (planId: number, value: VerificationSnapshot) => {
              collector.sealSnapshot(planId, value);
              events.push('seal');
            },
          }),
    },
    secretScan: {
      async scan() {
        events.push('scan');
        return options.scan?.() ?? { passed: true, evidenceRef: 'scan:clean' };
      },
    },
    diffReview: {
      async review() {
        events.push('review');
        return (
          options.review?.() ?? { passed: true, evidenceRef: 'review:actual', changedPaths: ['src/app.ts', 'old.ts'] }
        );
      },
    },
    ...(options.snapshots === false
      ? {}
      : {
          snapshots: {
            async capture(taskId: string) {
              expect(taskId).toBe(task.id);
              events.push('capture');
              captureCount++;
              const value = structuredClone(snapshot);
              return options.capture?.(value, captureCount) ?? value;
            },
          },
        }),
  });
  const run = () => runner.run(plan, { taskId: task.id, cwd: '/worktree' });
  return { task, repository, collector, plan, snapshot, runner, events, run };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe('snapshot-bound verification execution', () => {
  it('carries plan HEAD and seals actual reviewed paths after both matching captures', async () => {
    const s = setup();
    expect(s.plan.headSha).toBe(HEAD);
    expect((await s.run()).passed).toBe(true);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toMatchObject({
      id: s.plan.id,
      snapshot: s.snapshot,
      approvedPaths: ['old.ts', 'src/app.ts'],
    });
    expect(s.events).toEqual([
      'capture',
      'command',
      'command-evidence',
      'scan',
      `evidence:${s.plan.checks[1]?.id}`,
      'review',
      `evidence:${s.plan.checks[2]?.id}`,
      'capture',
      'seal',
    ]);
  });

  it('records passed review paths even for legacy unsealed diagnostics', async () => {
    const s = setup({ snapshots: false });
    expect((await s.run()).passed).toBe(true);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
    // Evidence was recorded by the real collector and can satisfy explicit sealing.
    s.collector.sealSnapshot(s.plan.id, s.snapshot);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)?.approvedPaths).toEqual(['old.ts', 'src/app.ts']);
    expect(s.events).not.toContain('capture');
    expect(s.events).not.toContain('seal');
  });

  it.each(['task', 'head', 'bytes', 'mode', 'paths'] as const)(
    'does not seal if %s changes during verification',
    async (field) => {
      const s = setup({
        capture(snapshot, count) {
          if (count === 1) return snapshot;
          if (field === 'task') snapshot.taskId = 'foreign-task';
          if (field === 'head') snapshot.headSha = 'd'.repeat(40);
          const file = snapshot.entries[1];
          if (file === undefined) throw new Error('Missing test file');
          if (field === 'bytes') file.oid = 'd'.repeat(40);
          if (field === 'mode') file.mode = '100755';
          if (field === 'paths') snapshot.entries.pop();
          return snapshot;
        },
      });
      await expect(s.run()).rejects.toThrow(/snapshot|changed/i);
      expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
      expect(s.events).not.toContain('seal');
    },
  );

  it.each(['foreign-task', 'wrong-head', 'missing-head'] as const)(
    'rejects %s before executing checks',
    async (kind) => {
      const s = setup({
        ...(kind === 'missing-head' ? { headSha: null } : {}),
        capture(snapshot) {
          if (kind === 'foreign-task') snapshot.taskId = 'foreign-task';
          if (kind === 'wrong-head') snapshot.headSha = 'e'.repeat(40);
          return snapshot;
        },
      });
      await expect(s.run()).rejects.toThrow(/snapshot|HEAD|task/i);
      expect(s.events).not.toContain('command');
      expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
    },
  );

  it('rejects a foreign task context before capture or execution', async () => {
    const s = setup();
    await expect(s.runner.run(s.plan, { taskId: 'other', cwd: '/worktree' })).rejects.toThrow(/task/i);
    expect(s.events).toEqual([]);
  });

  it.each(['command', 'scan', 'review', 'crash', 'capture-crash'] as const)(
    'does not seal on a %s failure',
    async (kind) => {
      const s = setup({
        exitCode: kind === 'command' ? 1 : 0,
        scan: () => {
          if (kind === 'crash') throw new Error('scanner crashed');
          return { passed: kind !== 'scan', evidenceRef: 'scan:result' };
        },
        review: () => ({ passed: kind !== 'review', evidenceRef: 'review:result', changedPaths: ['src/app.ts'] }),
        capture(snapshot, count) {
          if (kind === 'capture-crash' && count === 2) throw new Error('capture crashed');
          return snapshot;
        },
      });
      if (kind === 'crash' || kind === 'capture-crash') await expect(s.run()).rejects.toThrow(/crashed/);
      else expect((await s.run()).passed).toBe(false);
      expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
      expect(s.events).not.toContain('seal');
    },
  );

  it('does not seal a passed diff review with missing changed paths', async () => {
    const s = setup({ review: () => ({ passed: true, evidenceRef: 'review:missing-paths' }) });
    await expect(s.run()).rejects.toThrow(/paths|review/i);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it('does not seal a required non-command PASS without evidence', async () => {
    const s = setup({ scan: () => ({ passed: true, evidenceRef: '' }) });
    await expect(s.run()).rejects.toThrow(/evidence/i);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it('rejects snapshot execution if the evidence port cannot seal', async () => {
    const s = setup({ seal: false });
    await expect(s.run()).rejects.toThrow(/seal/i);
    expect(s.events).not.toContain('command');
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it('does not seal old passed checks under a freshly captured snapshot', async () => {
    const s = setup({ checks: [{ name: 'diff-review', kind: 'NON_COMMAND', required: true, status: 'PENDING' }] });
    const check = s.plan.checks[0];
    if (check === undefined) throw new Error('Missing review check');
    s.collector.recordNonCommandResult({
      checkId: check.id,
      status: 'PASS',
      evidenceRef: 'old-review',
      approvedPaths: ['src/app.ts'],
    });
    check.status = 'PASS';
    await expect(s.run()).rejects.toThrow(/pending|fresh/i);
    expect(s.events).not.toContain('seal');
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it.each([true, false])('does not pass or seal zero required checks (snapshots=%s)', async (snapshots) => {
    const s = setup({
      snapshots,
      checks: [{ name: 'browser', kind: 'NON_COMMAND', required: false, status: 'NOT_REQUIRED' }],
    });
    expect((await s.run()).passed).toBe(false);
    expect(s.events).not.toContain('seal');
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });
});
