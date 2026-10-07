import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  openDatabase,
  runMigrations,
  RepositoryRepository,
  TaskRepository,
  WorkspaceRepository,
  VerificationRepository,
  VerificationReviewRepository,
} from '../index.js';
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  new RepositoryRepository(db).upsert({
    githubRepositoryId: 1,
    owner: 'a',
    name: 'b',
    defaultBranch: 'main',
    localBasePath: '/repo',
  });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ repoId: 1, goal: 'test', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  db.prepare("UPDATE tasks SET status='VERIFYING' WHERE id=?").run(task.id);
  const workspace = new WorkspaceRepository(db).create({
    taskId: task.id,
    repoId: 1,
    linuxPath: '/repo/task',
    branch: 'task/review',
  });
  const verification = new VerificationRepository(db);
  const planId = verification.createPlan({ taskId: task.id, headSha: 'a'.repeat(40), changeClass: 'OTHER', plan: {} });
  const checkId = verification.createCheck({ taskId: task.id, planId, name: 'diff-review', required: true });
  const input = {
    id: randomUUID(),
    taskId: task.id,
    workspaceId: workspace.id,
    workspacePath: workspace.linuxPath,
    branch: workspace.branch,
    planId,
    checkId,
    checkName: 'diff-review' as const,
    headSha: 'a'.repeat(40),
    snapshotDigest: 'b'.repeat(64),
    runId: randomUUID(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  };
  return { db, input, reviews: new VerificationReviewRepository(db), verification };
}
it('binds a durable review to an active task, workspace, plan and check and consumes it once', () => {
  const { reviews, input } = fixture();
  expect(reviews.create(input)).toMatchObject({ ...input, state: 'PENDING' });
  const views = [{ path: 'file.ts', digest: 'c'.repeat(64) }];
  const accepted = reviews.accept(input.id, input.runId, { decision: 'PASS', views, approvedPaths: ['file.ts'] });
  expect(accepted.state).toBe('ACCEPTED');
  expect(accepted.evidenceRef).toBe(`external-review:${input.id}`);
  expect(reviews.get(input.id)).toMatchObject({ decision: 'PASS', views, approvedPaths: ['file.ts'] });
  expect(() =>
    reviews.accept(input.id, input.runId, { decision: 'PASS', views, approvedPaths: ['file.ts'] }),
  ).toThrow();
});
it('rejects foreign plan, check, workspace, head and inactive task bindings', () => {
  const { db, reviews, input } = fixture();
  for (const patch of [
    { taskId: randomUUID() },
    { workspaceId: 999 },
    { planId: 999 },
    { checkId: 999 },
    { headSha: 'c'.repeat(40) },
    { workspacePath: '/elsewhere' },
    { branch: 'other' },
  ]) {
    expect(() => reviews.create({ ...input, ...patch })).toThrow();
  }
  db.prepare("UPDATE tasks SET status='RUNNING' WHERE id=?").run(input.taskId);
  expect(() => reviews.create(input)).toThrow();
});
it('rejects expired, wrong-run and interrupted acceptance and keeps only one active review per task', () => {
  const { reviews, input } = fixture();
  reviews.create(input);
  expect(() => reviews.create({ ...input, id: randomUUID() })).toThrow();
  expect(() => reviews.accept(input.id, randomUUID(), { decision: 'FAIL', views: [], approvedPaths: [] })).toThrow();
  reviews.interruptPending();
  expect(reviews.get(input.id)?.state).toBe('INTERRUPTED');
  expect(() => reviews.accept(input.id, input.runId, { decision: 'PASS', views: [], approvedPaths: [] })).toThrow();
  const expired = { ...input, id: randomUUID(), expiresAt: new Date(Date.now() - 1000).toISOString() };
  reviews.create(expired);
  expect(() => reviews.accept(expired.id, input.runId, { decision: 'FAIL', views: [], approvedPaths: [] })).toThrow();
});
it('production plans refuse arbitrary non-command refs and require matching accepted review records', () => {
  const { input, reviews, verification } = fixture();
  const planId = verification.createPlan({
    taskId: input.taskId,
    headSha: input.headSha,
    changeClass: 'OTHER',
    plan: { externalReviews: true },
  });
  const checkId = verification.createCheck({ taskId: input.taskId, planId, name: 'diff-review', required: true });
  expect(() =>
    verification.finishCheck(checkId, { status: 'PASS', evidenceRef: 'fake-pass', approvedPaths: ['file.ts'] }),
  ).toThrow(/review/);
  expect(() =>
    verification.finishCheck(checkId, {
      status: 'PASS',
      evidenceRef: `external-review:${randomUUID()}`,
      approvedPaths: ['file.ts'],
    }),
  ).toThrow(/review/);
  const r = reviews.create({ ...input, planId, checkId });
  expect(() =>
    verification.finishCheck(checkId, { status: 'PASS', evidenceRef: r.evidenceRef, approvedPaths: ['file.ts'] }),
  ).toThrow(/review/);
  reviews.accept(r.id, r.runId, {
    decision: 'PASS',
    views: [{ path: 'file.ts', digest: 'c'.repeat(64) }],
    approvedPaths: ['file.ts'],
  });
  expect(() =>
    verification.finishCheck(checkId, { status: 'PASS', evidenceRef: r.evidenceRef, approvedPaths: ['unseen.ts'] }),
  ).toThrow(/review/);
  verification.finishCheck(checkId, { status: 'PASS', evidenceRef: r.evidenceRef, approvedPaths: ['file.ts'] });
  expect(() =>
    verification.sealSnapshot(planId, {
      version: 1,
      taskId: input.taskId,
      headSha: input.headSha,
      entries: [{ path: 'file.ts', mode: '100644', oid: 'd'.repeat(40) }],
    }),
  ).toThrow(/review/);
});
