import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  CommandRunRepository,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { SecretRedactor } from '@gram/secrets';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';
import { VerificationCoordinator } from './verification-coordinator.js';
import { ExternalVerificationReview, type PendingVerificationReview } from './external-verification-review.js';
import { TaskVerificationSnapshots } from './verification-snapshot.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.reverse().forEach((f) => f());
  cleanups.length = 0;
});
function fixture(command = 'node -e "process.exit(0)"') {
  const root = mkdtempSync(join(tmpdir(), 'gram-coordinator-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(cwd, 'README.md'), 'before\n');
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(join(cwd, 'README.md'), 'after\n');
  const head = git('rev-parse', 'HEAD').trim();
  const db = openDatabase(':memory:');
  cleanups.push(() => db.close());
  runMigrations(db);
  const tasks = new TaskRepository(db),
    repos = new RepositoryRepository(db),
    workspaces = new WorkspaceRepository(db),
    locks = new LockRepository(db),
    verification = new VerificationRepository(db),
    reviews = new VerificationReviewRepository(db);
  repos.upsert({
    githubRepositoryId: 1,
    owner: 'a',
    name: 'b',
    defaultBranch: 'main',
    localBasePath: cwd,
    commands: { lint: command },
  });
  const task = tasks.create({ repoId: 1, goal: 'docs', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
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
  workspaces.create({ taskId: task.id, repoId: 1, linuxPath: cwd, branch: 'task/docs' });
  const commandRuns = new CommandRunRepository(db),
    redactor = new SecretRedactor();
  const commands = new CommandRunner({
    policy: new PolicyEngine(),
    approvals: { consume: async () => false },
    spawner: new NodeProcessSpawner(),
    commandRuns,
    outputCapture: new OutputCapture({ homeDir: root, redactor }),
    homeDir: root,
  });
  const snapshots = new TaskVerificationSnapshots({ runner: commands, workspaces });
  const capability = new ExternalVerificationReview({
    tasks,
    workspaces,
    locks,
    reviews,
    verification,
    ownsLease: () => true,
    snapshots,
    source: {
      read: async () => ({
        path: 'README.md',
        before: { present: true as const, mode: '100644' as const, oid: 'a'.repeat(40), content: 'before\n' },
        after: { present: true as const, mode: '100644' as const, oid: 'b'.repeat(40), content: 'after\n' },
        digest: 'c'.repeat(64),
      }),
    },
  });
  cleanups.push(() => capability.close());
  const coordinator = new VerificationCoordinator({
    tasks,
    repositories: repos,
    verification,
    snapshots,
    commands,
    reviews: capability,
  });
  return { root, cwd, db, task, head, capability, coordinator, verification, tasks, repos, snapshots };
}
async function waitReview(f: ReturnType<typeof fixture>): Promise<PendingVerificationReview> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const view = f.capability.get(f.task.id);
    if (view !== null) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('review wait exceeded');
}
async function accept(f: ReturnType<typeof fixture>, view: PendingVerificationReview) {
  const { taskId, reviewId, workspaceId, planId, checkId, headSha, snapshotDigest } = view;
  const identity = { taskId, reviewId, workspaceId, planId, checkId, headSha, snapshotDigest };
  const file = await f.capability.read({ ...identity, path: 'README.md' });
  await f.capability.submit({
    ...identity,
    status: 'PASS',
    acknowledgements: [{ path: 'README.md', digest: file.digest }],
    approvedPaths: view.checkName === 'diff-review' ? ['README.md'] : [],
  });
}
it('creates and executes a fresh real declared-command plan then awaits exact reviews before sealing', async () => {
  const f = fixture();
  const promise = f.coordinator.execute(f.task.id, f.head);
  void promise.catch(() => undefined);
  const first = await waitReview(f);
  expect(first.checkName).toBe('secret-scan');
  expect(f.verification.getBoundPlan(f.task.id, f.head)).toBeUndefined();
  expect(f.db.prepare("SELECT status FROM command_runs WHERE category='VERIFICATION'").get()).toEqual({
    status: 'SUCCEEDED',
  });
  await accept(f, first);
  const second = await waitReview(f);
  expect(second.checkName).toBe('diff-review');
  expect(second.reviewId).not.toBe(first.reviewId);
  await accept(f, second);
  await promise;
  const plan = f.coordinator.getVerifiedPlan(f.task.id, f.head);
  expect(plan?.approvedPaths).toEqual(['README.md']);
  expect(plan?.checks.every((c) => c.status === 'PASS')).toBe(true);
  expect(f.coordinator.requiredChecksPassed(f.task.id)).toBe(false);
});
it('fails closed before review for missing commands and failed real commands', async () => {
  const f = fixture(' ');
  await expect(f.coordinator.execute(f.task.id, f.head)).rejects.toThrow(/lint/);
  expect(f.db.prepare('SELECT id FROM verification_plans').get()).toBeUndefined();
  const g = fixture('node -e "process.exit(1)"');
  await expect(g.coordinator.execute(g.task.id, g.head)).rejects.toThrow(/command/);
  expect(g.capability.get(g.task.id)).toBeNull();
  expect(g.verification.getBoundPlan(g.task.id, g.head)).toBeUndefined();
});
it('retains risky-command refusal without an approval facility', async () => {
  const f = fixture('powershell.exe -Command echo');
  await expect(f.coordinator.execute(f.task.id, f.head)).rejects.toThrow(/approval/);
  expect(f.capability.get(f.task.id)).toBeNull();
  expect(f.verification.getBoundPlan(f.task.id, f.head)).toBeUndefined();
});
it('refuses wrong HEAD and prevents concurrent execution/reused historical evidence', async () => {
  const f = fixture();
  await expect(f.coordinator.execute(f.task.id, 'f'.repeat(40))).rejects.toThrow(/HEAD/);
  const pending = f.coordinator.execute(f.task.id, f.head);
  void pending.catch(() => undefined);
  await waitReview(f);
  await expect(f.coordinator.execute(f.task.id, f.head)).rejects.toThrow(/already/);
  f.capability.close();
  await expect(pending).rejects.toThrow();
});

it('rejects changed bytes between initial planning capture and runner capture', async () => {
  const f = fixture(),
    capture = f.snapshots.capture.bind(f.snapshots);
  let calls = 0;
  f.snapshots.capture = async (...args) => {
    const result = await capture(...args);
    if (++calls === 1) writeFileSync(join(f.cwd, 'README.md'), 'changed after planned snapshot\n');
    return result;
  };
  await expect(f.coordinator.execute(f.task.id, f.head)).rejects.toThrow(/snapshot changed after planning/);
  expect(f.capability.get(f.task.id)).toBeNull();
  expect(f.verification.getBoundPlan(f.task.id, f.head)).toBeUndefined();
});
it('refuses candidate changes immediately after a declared command, before any later check or review', async () => {
  const f = fixture(`node -e "require('fs').writeFileSync('README.md','mutated')"`);
  await expect(f.coordinator.execute(f.task.id, f.head)).rejects.toThrow(/snapshot changed/);
  expect(f.capability.get(f.task.id)).toBeNull();
  expect(f.verification.getBoundPlan(f.task.id, f.head)).toBeUndefined();
});
