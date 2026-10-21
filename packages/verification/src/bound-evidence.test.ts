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
import { CompletionEvaluator } from './completion-evaluator.js';

const databases: Array<{ close(): void }> = [];
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  const tasks = new TaskRepository(db);
  const task = tasks.create({ goal: 'verify', taskType: 'CODING', publishMode: 'PULL_REQUEST' });
  const other = tasks.create({ goal: 'other', taskType: 'CODING', publishMode: 'PULL_REQUEST' });
  new RepositoryRepository(db).upsert({ githubRepositoryId: 158, owner: 'fixture', name: 'repo', defaultBranch: 'main', localBasePath: '/worktree' });
  new WorkspaceRepository(db).create({ taskId: task.id, repoId: 158, linuxPath: '/worktree', branch: 'fixture' });
  const repository = new VerificationRepository(db);
  const commands = new CommandRunRepository(db);
  function plan(headSha = HEAD) {
    return repository.createPlan({ taskId: task.id, headSha, changeClass: 'OTHER', plan: { checks: [] } });
  }
  function check(planId: number, name = 'diff-review', required = true) {
    return repository.createCheck({ planId, taskId: task.id, name, required });
  }
  function review(planId: number, approvedPaths = ['src/app.ts']) {
    const id = check(planId);
    repository.finishCheck(id, { status: 'PASS', evidenceRef: `diff:${id}`, approvedPaths });
    return id;
  }
  function snapshot(): VerificationSnapshot {
    return {
      version: 1,
      taskId: task.id,
      headSha: HEAD,
      entries: [
        { path: 'old.ts', mode: '000000', oid: null },
        { path: 'src/app.ts', mode: '100644', oid: 'c'.repeat(40) },
        { path: 'unrelated.txt', mode: '100755', oid: 'd'.repeat(40) },
      ],
    };
  }
  function successfulCommand(taskId = task.id) {
    const id = commands.start({ taskId, category: 'VERIFICATION', cwd: '/worktree', shellText: 'pnpm test' });
    commands.finish(id, { status: 'SUCCEEDED', exitCode: 0 });
    return id;
  }
  return { db, task, other, repository, commands, plan, check, review, snapshot, successfulCommand };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe('head-bound verification evidence', () => {
  it('returns one coherent sealed plan with only the actual reviewed paths', () => {
    const s = setup();
    const id = s.plan();
    const reviewId = s.review(id, ['src/app.ts', 'old.ts']);
    const commandId = s.check(id, 'test');
    s.repository.finishCheck(commandId, { status: 'PASS', commandRunId: s.successfulCommand() });
    s.repository.sealSnapshot(id, s.snapshot());
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toEqual({
      id,
      taskId: s.task.id,
      headSha: HEAD,
      snapshot: s.snapshot(),
      approvedPaths: ['old.ts', 'src/app.ts'],
      checks: [s.repository.getCheck(reviewId), s.repository.getCheck(commandId)],
    });
    expect(s.repository.getBoundPlan(s.task.id, OTHER_HEAD)).toBeUndefined();
    expect(s.repository.getBoundPlan(s.other.id, HEAD)).toBeUndefined();
  });

  it('does not authorize a missing or unsealed plan', () => {
    const s = setup();
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
    const id = s.plan();
    s.review(id);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it('does not fall back to an older passed plan or permit a superseded plan ID', () => {
    const s = setup();
    const old = s.plan();
    s.review(old);
    s.repository.sealSnapshot(old, s.snapshot());
    s.plan();
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
    expect(s.repository.getBoundPlan(s.task.id, HEAD, old)).toBeUndefined();
  });

  it('keeps exact-HEAD diagnostic checks separate from a newer other-HEAD plan', () => {
    const s = setup();
    const old = s.plan();
    const oldCheck = s.review(old);
    const newer = s.plan(OTHER_HEAD);
    const newerCheck = s.check(newer);
    expect(s.repository.listForTask(s.task.id, HEAD).map((c) => c.id)).toEqual([oldCheck]);
    expect(s.repository.listForTask(s.task.id).map((c) => c.id)).toEqual([newerCheck]);
    expect(s.repository.listForTask(s.task.id, 'e'.repeat(40))).toEqual([]);
    expect(new CompletionEvaluator(s.repository).requiredChecksPassed(s.task.id, HEAD)).toBe(true);
    expect(new CompletionEvaluator(s.repository).requiredChecksPassed(s.task.id, OTHER_HEAD)).toBe(false);
  });

  it.each([
    { verificationEvidence: { snapshot: {} } },
    { verificationEvidence: undefined },
    { toJSON: () => ({ verificationEvidence: { snapshot: {} } }) },
  ])('rejects caller injection of reserved evidence metadata', (plan) => {
    const s = setup();
    expect(() => s.repository.createPlan({ taskId: s.task.id, headSha: HEAD, changeClass: 'OTHER', plan })).toThrow(
      /reserved/i,
    );
  });

  it('rejects cross-task successful command evidence and leaves the check pending', () => {
    const s = setup();
    const id = s.check(s.plan(), 'test');
    expect(() =>
      s.repository.finishCheck(id, { status: 'PASS', commandRunId: s.successfulCommand(s.other.id) }),
    ).toThrow(/task/i);
    expect(s.repository.getCheck(id)?.status).toBe('PENDING');
  });

  it('rejects checks belonging to another plan owner', () => {
    const s = setup();
    expect(() =>
      s.repository.createCheck({ planId: s.plan(), taskId: s.other.id, name: 'test', required: true }),
    ).toThrow(/task/i);
  });

  it.each([
    'missing-review',
    'missing-paths',
    'optional-review',
    'pending',
    'failed',
    'missing-evidence',
    'zero-required',
  ])('cannot seal %s evidence', (kind) => {
    const s = setup();
    const id = s.plan();
    if (kind === 'missing-review') {
      s.repository.finishCheck(s.check(id, 'secret-scan'), { status: 'PASS', evidenceRef: 'scan:ok' });
    } else if (kind === 'missing-paths') {
      s.repository.finishCheck(s.check(id), { status: 'PASS', evidenceRef: 'review:ok' });
    } else if (kind === 'optional-review') {
      s.repository.finishCheck(s.check(id, 'diff-review', false), {
        status: 'PASS',
        evidenceRef: 'review:ok',
        approvedPaths: ['src/app.ts'],
      });
      s.repository.finishCheck(s.check(id, 'secret-scan'), { status: 'PASS', evidenceRef: 'scan:ok' });
    } else if (kind === 'pending') {
      s.review(id);
      s.check(id, 'test');
    } else if (kind === 'failed') {
      s.review(id);
      s.repository.finishCheck(s.check(id, 'test'), { status: 'FAIL' });
    } else if (kind === 'missing-evidence') {
      s.review(id);
      s.repository.createCheck({ planId: id, taskId: s.task.id, name: 'test', required: true, status: 'PASS' });
    } else {
      s.check(id, 'optional', false);
    }
    expect(() => s.repository.sealSnapshot(id, s.snapshot())).toThrow(/evidence|required|review/i);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it.each([
    'foreign-task',
    'wrong-head',
    'outside-review',
    'unsorted',
    'duplicate',
    'bad-mode',
    'bad-oid',
    'deleted-with-oid',
  ])('rejects a %s snapshot', (kind) => {
    const s = setup();
    const id = s.plan();
    s.review(id);
    const snapshot = s.snapshot();
    if (kind === 'foreign-task') snapshot.taskId = s.other.id;
    if (kind === 'wrong-head') snapshot.headSha = OTHER_HEAD;
    if (kind === 'outside-review') snapshot.entries = [];
    if (kind === 'unsorted') snapshot.entries.reverse();
    const [deleted, modified] = s.snapshot().entries;
    if (deleted === undefined || modified === undefined) throw new Error('Missing test entries');
    if (kind === 'duplicate') snapshot.entries.splice(1, 0, deleted);
    if (kind === 'bad-mode') snapshot.entries[1] = { ...modified, mode: '120000' as '100644' };
    if (kind === 'bad-oid') snapshot.entries[1] = { ...modified, oid: 'not-an-oid' };
    if (kind === 'deleted-with-oid') snapshot.entries[0] = { ...deleted, oid: 'e'.repeat(40) };
    expect(() => s.repository.sealSnapshot(id, snapshot)).toThrow(/snapshot|review/i);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });

  it.each([
    '../bad',
    '/bad',
    '.git/config',
    'a/.GIT/config',
    '-option',
    ':magic',
    'a\\b',
    'a//b',
    './a',
    'a/../b',
    'a\nb',
    'a/*',
  ])('rejects unsafe review path %j atomically', (path) => {
    const s = setup();
    const id = s.plan();
    const checkId = s.check(id);
    expect(() =>
      s.repository.finishCheck(checkId, { status: 'PASS', evidenceRef: 'review:ok', approvedPaths: [path] }),
    ).toThrow(/path/i);
    expect(s.repository.getCheck(checkId)?.status).toBe('PENDING');
  });

  it('cannot inject reviewed paths through a different check or failed review', () => {
    const s = setup();
    const id = s.plan();
    expect(() =>
      s.repository.finishCheck(s.check(id, 'secret-scan'), {
        status: 'PASS',
        evidenceRef: 'scan:ok',
        approvedPaths: ['src/app.ts'],
      }),
    ).toThrow(/review/i);
    expect(() =>
      s.repository.finishCheck(s.check(id), {
        status: 'FAIL',
        evidenceRef: 'review:failed',
        approvedPaths: ['src/app.ts'],
      }),
    ).toThrow(/review/i);
  });

  it('seals immutably and does not allow checks to be added afterward', () => {
    const s = setup();
    const id = s.plan();
    s.review(id);
    s.repository.sealSnapshot(id, s.snapshot());
    expect(() => s.repository.sealSnapshot(id, s.snapshot())).toThrow(/sealed/i);
    expect(() => s.check(id, 'new-check')).toThrow(/sealed/i);
    expect(s.repository.getBoundPlan(s.task.id, HEAD)?.snapshot).toEqual(s.snapshot());
  });

  it.each([
    'bad-json',
    'foreign-check',
    'foreign-command',
    'review-ref',
    'review-id',
    'snapshot-version',
    'missing-evidence',
  ])('fails closed if persisted %s evidence is corrupted', (kind) => {
    const s = setup();
    const id = s.plan();
    const reviewId = s.review(id);
    const testId = s.check(id, 'test');
    const commandId = s.successfulCommand();
    s.repository.finishCheck(testId, { status: 'PASS', commandRunId: commandId });
    s.repository.sealSnapshot(id, s.snapshot());
    if (kind === 'bad-json') s.db.prepare('UPDATE verification_plans SET plan_json = ? WHERE id = ?').run('{', id);
    if (kind === 'foreign-check')
      s.db.prepare('UPDATE verification_checks SET task_id = ? WHERE id = ?').run(s.other.id, reviewId);
    if (kind === 'foreign-command')
      s.db.prepare('UPDATE command_runs SET task_id = ? WHERE id = ?').run(s.other.id, commandId);
    if (kind === 'review-ref')
      s.db.prepare('UPDATE verification_checks SET evidence_ref = ? WHERE id = ?').run('different-ref', reviewId);
    if (kind === 'review-id')
      s.db.prepare('UPDATE verification_checks SET name = ? WHERE id = ?').run('secret-scan', reviewId);
    if (kind === 'missing-evidence')
      s.db.prepare('UPDATE verification_checks SET command_run_id = NULL WHERE id = ?').run(testId);
    if (kind === 'snapshot-version') {
      const row = s.db.prepare('SELECT plan_json FROM verification_plans WHERE id = ?').get(id) as {
        plan_json: string;
      };
      const plan = JSON.parse(row.plan_json);
      plan.verificationEvidence.snapshot.version = 2;
      s.db.prepare('UPDATE verification_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), id);
    }
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });
});

describe('command evidence lifetime', () => {
  it('rejects reusing a consumed command in another same-task HEAD plan', () => {
    const s = setup(); const first = s.plan(); s.review(first);
    const oldRun = s.successfulCommand();
    s.repository.finishCheck(s.check(first, 'test'), { status: 'PASS', commandRunId: oldRun });
    s.repository.sealSnapshot(first, s.snapshot());
    const next = s.plan(OTHER_HEAD); s.review(next);
    expect(() => s.repository.finishCheck(s.check(next, 'test'), { status: 'PASS', commandRunId: oldRun })).toThrow(/command|evidence/i);
  });
  it('rejects an old unconsumed command completed before plan creation', () => {
    const s = setup(); const oldRun = s.successfulCommand(); const next = s.plan();
    expect(() => s.repository.finishCheck(s.check(next, 'test'), { status: 'PASS', commandRunId: oldRun })).toThrow(/command|evidence/i);
  });
  it('rejects consuming one fresh command twice in the same plan', () => {
    const s = setup(); const id = s.plan(); const run = s.successfulCommand();
    s.repository.finishCheck(s.check(id, 'test'), { status: 'PASS', commandRunId: run });
    expect(() => s.repository.finishCheck(s.check(id, 'build'), { status: 'PASS', commandRunId: run })).toThrow(/command|evidence/i);
  });
});


describe('sealed command evidence readback', () => {
  it('refuses to seal successful evidence executed in another cwd', () => {
    const s = setup(); const id = s.plan(); s.review(id);
    const run = s.successfulCommand();
    s.db.prepare('UPDATE command_runs SET cwd = ? WHERE id = ?').run('/sibling', run);
    s.repository.finishCheck(s.check(id, 'test'), { status: 'PASS', commandRunId: run });
    expect(() => s.repository.sealSnapshot(id, s.snapshot())).toThrow(/workspace|cwd/i);
  });
  it.each(['cwd', 'consumption', 'watermark'])('revalidates %s after sealing', (change) => {
    const s = setup(); const id = s.plan(); s.review(id); const run = s.successfulCommand();
    const check = s.check(id, 'test');
    s.repository.finishCheck(check, { status: 'PASS', commandRunId: run });
    s.repository.sealSnapshot(id, s.snapshot());
    if (change === 'cwd') s.db.prepare('UPDATE command_runs SET cwd = ? WHERE id = ?').run('/sibling', run);
    else if (change === 'consumption') {
      const next = s.plan(OTHER_HEAD); const duplicate = s.check(next, 'test');
      s.db.prepare('UPDATE verification_checks SET command_run_id = ? WHERE id = ?').run(run, duplicate);
    } else {
      const row = s.db.prepare('SELECT plan_json FROM verification_plans WHERE id = ?').get(id) as { plan_json: string };
      const json = JSON.parse(row.plan_json); json.verificationEvidence.commandFloor = run;
      s.db.prepare('UPDATE verification_plans SET plan_json = ? WHERE id = ?').run(JSON.stringify(json), id);
    }
    expect(s.repository.getBoundPlan(s.task.id, HEAD)).toBeUndefined();
  });
});
