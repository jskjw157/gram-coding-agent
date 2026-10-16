import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, runMigrations, RepositoryRepository, TaskRepository, WorkspaceRepository,
  VerificationRepository, VerificationReviewRepository } from '../index.js';
import { PullRequestEvidenceRepository } from './pull-request-evidence-repository.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
interface FixturePlan {
  externalReviews?: boolean;
  verificationEvidence: {
    reviews: [{ checkId: number; evidenceRef: string; approvedPaths: string[] }];
    snapshot: { entries: [{ path: string }] };
  };
}

function fixture(path = 'src/counter.ts', databasePath = ':memory:') {
  const db = openDatabase(databasePath);
  databases.push(db);
  runMigrations(db);
  new RepositoryRepository(db).upsert({ githubRepositoryId: 1, owner: 'test', name: 'fixture', defaultBranch: 'main', localBasePath: '/repo' });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ repoId: 1, goal: 'Fix counter', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  const other = tasks.create({ repoId: 1, goal: 'Other task', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  db.prepare("UPDATE tasks SET status='VERIFYING' WHERE id=?").run(task.id);
  const workspace = new WorkspaceRepository(db).create({ taskId: task.id, repoId: 1, linuxPath: '/repo/task', branch: 'task/fix' });
  const verification = new VerificationRepository(db);
  const headSha = 'a'.repeat(40);
  const planId = verification.createPlan({ taskId: task.id, headSha, changeClass: 'OTHER', plan: { externalReviews: true } });
  const checkId = verification.createCheck({ taskId: task.id, planId, name: 'diff-review', required: true });
  const snapshot = { version: 1 as const, taskId: task.id, headSha, entries: [{ path, mode: '100644' as const, oid: 'b'.repeat(40) }] };
  const reviewId = randomUUID();
  const runId = randomUUID();
  const reviews = new VerificationReviewRepository(db);
  reviews.create({ id: reviewId, runId, taskId: task.id, workspaceId: workspace.id, workspacePath: workspace.linuxPath,
    branch: workspace.branch, planId, checkId, checkName: 'diff-review', headSha,
    snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() });
  reviews.accept(reviewId, runId, { decision: 'PASS', views: [{ path, digest: 'c'.repeat(64) }], approvedPaths: [path] });
  verification.finishCheck(checkId, { status: 'PASS', evidenceRef: `external-review:${reviewId}`, approvedPaths: [path] });
  verification.sealSnapshot(planId, snapshot);
  const read = () => new PullRequestEvidenceRepository(db).readForTask(task.id).changedPaths;
  const editPlan = (edit: (value: FixturePlan) => void) => {
    const row = db.prepare('SELECT plan_json FROM verification_plans WHERE id=?').get(planId) as {plan_json: string};
    const plan = JSON.parse(row.plan_json) as FixturePlan;
    edit(plan);
    db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run(JSON.stringify(plan), planId);
  };
  return { db, task, other, planId, checkId, reviewId, verification, workspace, read, editPlan };
}

it('keeps paths and checks in one snapshot while a separate WAL writer publishes a newer plan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gram-pr-evidence-'));
  directories.push(directory);
  const databasePath = join(directory, 'evidence.sqlite');
  const f = fixture('src/counter.ts', databasePath);
  const writer = openDatabase(databasePath);
  databases.push(writer);
  expect(writer.pragma('journal_mode', { simple: true })).toBe('wal');
  const prepare = f.db.prepare.bind(f.db);
  let interleaved = false;
  vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes('FROM verification_checks') && sql.includes('ORDER BY id')) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters: unknown[]) => {
        const rows = all(...parameters);
        if (!interleaved) {
          interleaved = true;
          const verification = new VerificationRepository(writer);
          const headSha = 'd'.repeat(40);
          const planId = verification.createPlan({ taskId: f.task.id, headSha, changeClass: 'OTHER', plan: { externalReviews: true } });
          const checkId = verification.createCheck({ taskId: f.task.id, planId, name: 'diff-review', required: true });
          verification.createCheck({ taskId: f.task.id, planId, name: 'new-plan-marker', required: false, status: 'NOT_REQUIRED' });
          const path = 'src/new.ts';
          const snapshot = { version: 1 as const, taskId: f.task.id, headSha, entries: [{ path, mode: '100644' as const, oid: 'e'.repeat(40) }] };
          const reviewId = randomUUID();
          const runId = randomUUID();
          const reviews = new VerificationReviewRepository(writer);
          reviews.create({ id: reviewId, runId, taskId: f.task.id, workspaceId: f.workspace.id, workspacePath: f.workspace.linuxPath,
            branch: f.workspace.branch, planId, checkId, checkName: 'diff-review', headSha,
            snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() });
          reviews.accept(reviewId, runId, { decision: 'PASS', views: [{ path, digest: 'f'.repeat(64) }], approvedPaths: [path] });
          verification.finishCheck(checkId, { status: 'PASS', evidenceRef: `external-review:${reviewId}`, approvedPaths: [path] });
          verification.sealSnapshot(planId, snapshot);
        }
        return rows;
      });
    }
    return statement;
  });
  const repository = new PullRequestEvidenceRepository(f.db);
  const first = repository.readForTask(f.task.id);
  expect(interleaved).toBe(true);
  expect(first.changedPaths).toEqual(['src/counter.ts']);
  expect(first.verification.map(check => check.name)).toEqual(['diff-review']);
  const second = repository.readForTask(f.task.id);
  expect(second.changedPaths).toEqual(['src/new.ts']);
  expect(second.verification.map(check => check.name)).toEqual(['diff-review', 'new-plan-marker']);
});

it('reads accepted external paths at the reviewed baseline even after publishing a new commit', () => {
  const f = fixture();
  f.db.prepare("UPDATE tasks SET status='COMPLETED', result_summary='Published commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id=?").run(f.task.id);
  expect(f.read()).toEqual(['src/counter.ts']);
});

it('ignores unapproved metadata paths when external review evidence is used', () => {
  const f = fixture();
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run(JSON.stringify({ changedPaths: ['unapproved.ts'] }), f.task.id);
  expect(f.read()).toEqual(['src/counter.ts']);
});

it.each([
  ['task_id', 'other'], ['plan_id', 999], ['check_id', 999], ['head_sha', 'd'.repeat(40)],
  ['check_name', 'secret-scan'], ['state', 'FAILED'], ['decision', 'FAIL'],
  ['approved_paths_json', '["unapproved.ts"]'], ['approved_paths_json', '{malformed'],
  ['views_json', '{malformed'], ['snapshot_digest', 'd'.repeat(64)],
])('rejects mismatched or malformed review %s', (column, value) => {
  const f = fixture();
  // Deliberate corruption in this isolated database exercises persisted evidence validation.
  f.db.pragma('foreign_keys = OFF');
  f.db.prepare(`UPDATE verification_reviews SET ${column}=? WHERE id=?`).run(value === 'other' ? f.other.id : value, f.reviewId);
  expect(f.read()).toEqual([]);
});

it.each(['FAIL', 'PENDING', 'SKIPPED'])('rejects a non-passing check: %s', status => {
  const f = fixture();
  f.db.prepare('UPDATE verification_checks SET status=? WHERE id=?').run(status, f.checkId);
  expect(f.read()).toEqual([]);
});

it.each(['external-review:missing', 'external-review:../other', 'diff-review:injected.ts', null])('does not fall back from a corrupt external reference %s', ref => {
  const f = fixture();
  f.db.prepare('UPDATE verification_checks SET evidence_ref=? WHERE id=?').run(ref, f.checkId);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run('{"changedPaths":["injected.ts"]}', f.task.id);
  expect(f.read()).toEqual([]);
});

it.each(['../secret', '/absolute', 'C:\\secret', 'src/../../secret', '.git/config', 'src\nInjected', 'src/`injected`', 'src/ghp_0123456789abcdef.ts', 'src/github_pat_0123456789abcdef.ts', 'src/sk-0123456789abcdef.ts'])('never publishes unsafe or secret-bearing paths: %s', path => {
  const f = fixture();
  f.editPlan(plan => {
    plan.verificationEvidence.reviews[0].approvedPaths = [path];
    plan.verificationEvidence.snapshot.entries[0].path = path;
    f.db.prepare('UPDATE verification_reviews SET approved_paths_json=?, views_json=?, snapshot_digest=? WHERE id=?').run(
      JSON.stringify([path]), JSON.stringify([{ path, digest: 'c'.repeat(64) }]),
      createHash('sha256').update(JSON.stringify(plan.verificationEvidence.snapshot)).digest('hex'), f.reviewId);
  });
  expect(f.read()).toEqual([]);
});

it('never reuses an older approved plan', () => {
  const f = fixture();
  f.verification.createPlan({ taskId: f.task.id, headSha: 'd'.repeat(40), changeClass: 'OTHER', plan: { externalReviews: true } });
  expect(f.read()).toEqual([]);
});

it('fails closed on malformed plan schema and duplicate review bindings', () => {
  const f = fixture();
  f.editPlan(plan => { plan.verificationEvidence.reviews.push(plan.verificationEvidence.reviews[0]); });
  expect(f.read()).toEqual([]);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{malformed', f.planId);
  expect(f.read()).toEqual([]);
});

it('preserves the legacy diff-review evidence format', () => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare("UPDATE verification_checks SET evidence_ref='diff-review:src/one.ts,src/two.ts' WHERE id=?").run(f.checkId);
  expect(f.read()).toEqual(['src/one.ts', 'src/two.ts']);
});

it.each(['FAIL', 'PENDING', 'SKIPPED', 'NOT_REQUIRED'])('does not project unapproved legacy %s paths', status => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare("UPDATE verification_checks SET status=?, evidence_ref='diff-review:src/counter.ts' WHERE id=?").run(status, f.checkId);
  expect(f.read()).toEqual([]);
});

it('does not project paths from an optional legacy review', () => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare("UPDATE verification_checks SET required=0, evidence_ref='diff-review:src/counter.ts' WHERE id=?").run(f.checkId);
  expect(f.read()).toEqual([]);
});

it('never lets metadata override approved legacy paths', () => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare("UPDATE verification_checks SET evidence_ref='diff-review:src/counter.ts' WHERE id=?").run(f.checkId);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run(JSON.stringify({ changedPaths: ['unapproved.ts'], summary: 'Safe summary', rootCause: 'Safe cause' }), f.task.id);
  expect(new PullRequestEvidenceRepository(f.db).readForTask(f.task.id)).toMatchObject({
    changedPaths: ['src/counter.ts'], summary: 'Safe summary', rootCause: 'Safe cause',
  });
});

it.each([null, 'not-review:src/counter.ts', 'diff-review:', 'diff-review:clean'])('ignores metadata when legacy approval is absent: %s', ref => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare('UPDATE verification_checks SET evidence_ref=? WHERE id=?').run(ref, f.checkId);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run('{"changedPaths":["unapproved.ts"]}', f.task.id);
  expect(f.read()).toEqual([]);
});

it('does not project metadata-only paths without a review check or plan', () => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('DELETE FROM verification_plans WHERE id=?').run(f.planId);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run('{"changedPaths":["unapproved.ts"]}', f.task.id);
  expect(f.read()).toEqual([]);
});

it('never downgrades malformed external evidence into legacy metadata fallback', () => {
  const f = fixture();
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{malformed', f.planId);
  f.db.prepare("UPDATE verification_checks SET evidence_ref='diff-review:injected.ts' WHERE id=?").run(f.checkId);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run('{"changedPaths":["injected.ts"]}', f.task.id);
  expect(f.read()).toEqual([]);
});

it('does not trust external paths when the plan external-review binding is disabled', () => {
  const f = fixture();
  f.editPlan(plan => { plan.externalReviews = false; });
  f.db.prepare("UPDATE verification_reviews SET decision='FAIL' WHERE id=?").run(f.reviewId);
  expect(f.read()).toEqual([]);
});

it.each(['../secret', '/absolute', 'C:\\secret', '.git/config', 'src\nInjected', 'src/`injected`', 'src/ghp_0123456789abcdef.ts'])('rejects unsafe legacy paths: %s', path => {
  const f = fixture();
  f.db.prepare('DELETE FROM verification_reviews WHERE id=?').run(f.reviewId);
  f.db.prepare('UPDATE verification_plans SET plan_json=? WHERE id=?').run('{}', f.planId);
  f.db.prepare('UPDATE verification_checks SET evidence_ref=? WHERE id=?').run(`diff-review:${path}`, f.checkId);
  expect(f.read()).toEqual([]);
  f.db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run(JSON.stringify({ changedPaths: [path] }), f.task.id);
  expect(f.read()).toEqual([]);
});
