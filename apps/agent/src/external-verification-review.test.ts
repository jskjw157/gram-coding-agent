import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  openDatabase,
  runMigrations,
  TaskRepository,
  RepositoryRepository,
  WorkspaceRepository,
  LockRepository,
  VerificationRepository,
  VerificationReviewRepository,
  type VerificationSnapshot,
} from '@gram/persistence';
import { ExternalVerificationReview } from './external-verification-review.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.reverse().forEach((fn) => fn());
  cleanup.length = 0;
});
function fixture(timeoutMs = 10000) {
  const root = mkdtempSync(join(tmpdir(), 'gram-review-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  runMigrations(db);
  new RepositoryRepository(db).upsert({
    githubRepositoryId: 1,
    owner: 'a',
    name: 'b',
    defaultBranch: 'main',
    localBasePath: root,
  });
  const tasks = new TaskRepository(db),
    task = tasks.create({ repoId: 1, goal: 'review', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
  const locks = new LockRepository(db);
  locks.acquireAndPrepare({
    repoId: 1,
    taskId: task.id,
    leaseToken: 'lease',
    ownerPid: process.pid,
    ownerBootId: 'test',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 3600000).toISOString(),
  });
  tasks.transition(task.id, 'PREPARING', 'RUNNING');
  tasks.transition(task.id, 'RUNNING', 'VERIFYING');
  const workspaces = new WorkspaceRepository(db),
    workspace = workspaces.create({ taskId: task.id, repoId: 1, linuxPath: root, branch: 'task/review' });
  const verification = new VerificationRepository(db),
    planId = verification.createPlan({ taskId: task.id, headSha: 'a'.repeat(40), changeClass: 'OTHER', plan: {} }),
    checkId = verification.createCheck({ taskId: task.id, planId, name: 'diff-review', required: true });
  const snapshot: VerificationSnapshot = {
    version: 1,
    taskId: task.id,
    headSha: 'a'.repeat(40),
    entries: [{ path: 'file.ts', mode: '100644', oid: 'b'.repeat(40) }],
  };
  let current = structuredClone(snapshot);
  const reviews = new VerificationReviewRepository(db);
  const options = {
    tasks,
    workspaces,
    locks,
    reviews,
    verification,
    ownsLease: () => true,
    snapshots: { capture: async () => structuredClone(current) },
    source: {
      read: async () => ({
        path: 'file.ts',
        before: { present: true as const, mode: '100644' as const, oid: 'c'.repeat(40), content: 'old' },
        after: { present: true as const, mode: '100644' as const, oid: 'b'.repeat(40), content: 'new' },
        digest: 'd'.repeat(64),
      }),
    },
    timeoutMs,
  };
  const capability = new ExternalVerificationReview(options);
  cleanup.push(() => capability.close());
  const request = () => capability.request({ taskId: task.id, planId, checkId, checkName: 'diff-review', snapshot });
  return {
    db,
    task,
    workspace,
    verification,
    planId,
    checkId,
    reviews,
    snapshot,
    options,
    capability,
    request,
    drift: () => {
      current = { ...current, headSha: 'e'.repeat(40) };
    },
  };
}
async function start(f: ReturnType<typeof fixture>) {
  const promise = f.request();
  await Promise.resolve();
  const view = f.capability.get(f.task.id);
  if (view === null) throw new Error('pending missing');
  return { promise, view };
}
const input = (view: NonNullable<ReturnType<ExternalVerificationReview['get']>>) => ({
  taskId: view.taskId,
  reviewId: view.reviewId,
  workspaceId: view.workspaceId,
  planId: view.planId,
  checkId: view.checkId,
  headSha: view.headSha,
  snapshotDigest: view.snapshotDigest,
});
it('requires every path to be read and exactly acknowledged before single-use acceptance', async () => {
  const f = fixture(),
    { promise, view } = await start(f);
  await expect(
    f.capability.submit({
      ...input(view),
      status: 'PASS',
      acknowledgements: [{ path: 'file.ts', digest: 'd'.repeat(64) }],
      approvedPaths: ['file.ts'],
    }),
  ).rejects.toThrow();
  const file = await f.capability.read({ ...input(view), path: 'file.ts' });
  const submission = {
    ...input(view),
    status: 'PASS' as const,
    acknowledgements: [{ path: 'file.ts', digest: file.digest }],
    approvedPaths: ['file.ts'],
  };
  const both = await Promise.allSettled([f.capability.submit(submission), f.capability.submit(submission)]);
  expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  await expect(promise).resolves.toEqual({
    passed: true,
    evidenceRef: `external-review:${view.reviewId}`,
    changedPaths: ['file.ts'],
  });
  expect(f.reviews.get(view.reviewId)?.state).toBe('ACCEPTED');
});
it('rejects drift, changed task/lease/workspace, foreign and unseen paths', async () => {
  const f = fixture(),
    { promise, view } = await start(f);
  void promise.catch(() => undefined);
  await expect(f.capability.read({ ...input(view), path: 'other.ts' })).rejects.toThrow();
  await expect(f.capability.read({ ...input(view), planId: view.planId + 1, path: 'file.ts' })).rejects.toThrow();
  const file = await f.capability.read({ ...input(view), path: 'file.ts' });
  f.drift();
  await expect(
    f.capability.submit({
      ...input(view),
      status: 'PASS',
      acknowledgements: [{ path: 'file.ts', digest: file.digest }],
      approvedPaths: ['file.ts'],
    }),
  ).rejects.toThrow(/snapshot/);
  f.capability.close();
  await expect(promise).rejects.toThrow();
});
it('interrupts pending review on shutdown/restart and times out without releasing locks', async () => {
  const f = fixture(10),
    { promise, view } = await start(f);
  await expect(promise).rejects.toThrow(/timed out/);
  expect(f.reviews.get(view.reviewId)?.state).toBe('FAILED');
  const g = fixture(),
    pending = await start(g);
  const restarted = new ExternalVerificationReview(g.options);
  cleanup.push(() => restarted.close());
  await expect(g.capability.read({ ...input(pending.view), path: 'file.ts' })).rejects.toThrow();
  g.capability.close();
  await expect(pending.promise).rejects.toThrow();
  expect(g.options.locks.get(1)?.ownerTaskId).toBe(g.task.id);
});
it('refuses replacement plans while a review is pending', async () => {
  const f = fixture(),
    { promise, view } = await start(f);
  void promise.catch(() => undefined);
  f.verification.createPlan({ taskId: f.task.id, headSha: f.snapshot.headSha, changeClass: 'OTHER', plan: {} });
  await expect(f.capability.read({ ...input(view), path: 'file.ts' })).rejects.toThrow();
  f.capability.close();
  await expect(promise).rejects.toThrow();
});
it('binds view acknowledgement digest to the exact review identity', async () => {
  const f = fixture(),
    { promise, view } = await start(f);
  void promise.catch(() => undefined);
  const file = await f.capability.read({ ...input(view), path: 'file.ts' });
  expect(file.digest).not.toBe('d'.repeat(64));
  expect(file.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(createHash('sha256').update(file.digest).digest('hex')).not.toBe(file.digest);
  f.capability.close();
  await expect(promise).rejects.toThrow();
});
it.each(['task', 'lease', 'workspace'] as const)(
  'rejects %s changes during an asynchronous source read',
  async (kind) => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = f.options.source.read;
    f.options.source.read = async () => {
      await gate;
      return original();
    };
    const { promise, view } = await start(f);
    void promise.catch(() => undefined);
    const read = f.capability.read({ ...input(view), path: 'file.ts' });
    await Promise.resolve();
    await Promise.resolve();
    if (kind === 'task') f.db.prepare("UPDATE tasks SET status='CANCELLED' WHERE id=?").run(f.task.id);
    if (kind === 'lease') f.options.locks.release(1, 'lease');
    if (kind === 'workspace')
      f.db.prepare('UPDATE workspaces SET branch=? WHERE id=?').run('different', f.workspace.id);
    release();
    await expect(read).rejects.toThrow();
    f.capability.close();
    await expect(promise).rejects.toThrow();
  },
);
it('rejects missing, duplicate, extra acknowledgements and approvals of unseen paths', async () => {
  const f = fixture(),
    { promise, view } = await start(f);
  void promise.catch(() => undefined);
  const file = await f.capability.read({ ...input(view), path: 'file.ts' });
  const ack = { path: 'file.ts', digest: file.digest };
  for (const acknowledgements of [[], [ack, ack], [{ ...ack, path: 'other.ts' }]])
    await expect(
      f.capability.submit({ ...input(view), status: 'PASS', acknowledgements, approvedPaths: ['file.ts'] }),
    ).rejects.toThrow();
  await expect(
    f.capability.submit({ ...input(view), status: 'PASS', acknowledgements: [ack], approvedPaths: ['unseen.ts'] }),
  ).rejects.toThrow();
  await f.capability.submit({ ...input(view), status: 'FAIL', acknowledgements: [], approvedPaths: [] });
  await expect(promise).resolves.toMatchObject({ passed: false });
});
it('checks the persisted lease token against the runtime-owned lease token before opening a review', async () => {
  const f = fixture();
  f.options.ownsLease = (_taskId?: string, token?: string) => token === undefined || token === 'lease';
  f.capability.assertActive(f.task.id);
  f.db.prepare('UPDATE repo_locks SET lease_token=? WHERE repo_id=1').run('replacement');
  expect(() => f.capability.assertActive(f.task.id)).toThrow(/lease/);
});
