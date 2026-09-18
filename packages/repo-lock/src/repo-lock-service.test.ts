import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LockRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { RepoLockedError, RepoLockLostError, RepoLockService } from './repo-lock-service.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
const FIXED_NOW = new Date('2026-09-18T05:00:00.000Z');

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-repo-lock-'));
  roots.push(root);
  return root;
}

function setup() {
  const root = tempRoot();
  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);

  const repositories = new RepositoryRepository(db);
  for (const id of [100, 200]) {
    repositories.upsert({
      githubRepositoryId: id,
      owner: 'company',
      name: `repo-${id}`,
      defaultBranch: 'main',
      localBasePath: join(root, `repo-${id}`),
    });
  }

  const tasks = new TaskRepository(db);
  const locks = new LockRepository(db);
  const lockDirectory = join(root, 'locks', 'repos');
  const scheduler = {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  };

  const service = new RepoLockService({
    locks,
    tasks,
    lockDirectory,
    now: () => FIXED_NOW,
    pid: () => 4242,
    bootId: () => 'boot-test-123',
    scheduler,
  });

  const createWaitingTask = (repoId: number) => {
    const task = tasks.create({
      goal: `mutate repo ${repoId}`,
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId,
    });
    tasks.transition(task.id, 'QUEUED', 'WAITING_REPO_LOCK');
    return task;
  };

  return { db, root, tasks, locks, service, lockDirectory, createWaitingTask, scheduler };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('RepoLockService', () => {
  it('serializes mutation for the same repository while allowing different repositories', async () => {
    const { service, tasks, createWaitingTask } = setup();
    const taskA = createWaitingTask(100);
    const taskB = createWaitingTask(100);
    const taskC = createWaitingTask(200);

    const first = await service.acquire(100, taskA.id);
    expect(tasks.get(taskA.id)?.status).toBe('PREPARING');

    await expect(service.acquire(100, taskB.id)).rejects.toThrow(RepoLockedError);
    expect(tasks.get(taskB.id)?.status).toBe('WAITING_REPO_LOCK');

    const otherRepo = await service.acquire(200, taskC.id);
    expect(tasks.get(taskC.id)?.status).toBe('PREPARING');

    await otherRepo.release();
    await first.release();
  });

  it('uses exclusive filesystem creation and leaves SQLite/task state unchanged on collision', async () => {
    const { db, service, tasks, lockDirectory, createWaitingTask } = setup();
    const task = createWaitingTask(100);
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, '100.lock'), 'occupied', { flag: 'wx' });

    await expect(service.acquire(100, task.id)).rejects.toThrow(RepoLockedError);

    const count = db.prepare('SELECT COUNT(*) AS count FROM repo_locks').get() as { count: number };
    expect(count.count).toBe(0);
    expect(tasks.get(task.id)?.status).toBe('WAITING_REPO_LOCK');
  });

  it('writes task/pid/boot/timestamp metadata and pairs it with one SQLite lease', async () => {
    const { db, service, tasks, lockDirectory, createWaitingTask, scheduler } = setup();
    const task = createWaitingTask(100);

    const lease = await service.acquire(100, task.id);
    const metadata = JSON.parse(readFileSync(join(lockDirectory, '100.lock'), 'utf8')) as Record<string, unknown>;
    const row = db.prepare('SELECT * FROM repo_locks WHERE repo_id = 100').get() as Record<string, unknown>;

    expect(metadata).toMatchObject({
      taskId: task.id,
      pid: 4242,
      bootId: 'boot-test-123',
      acquiredAt: FIXED_NOW.toISOString(),
    });
    expect(row.owner_task_id).toBe(task.id);
    expect(row.owner_pid).toBe(4242);
    expect(row.owner_boot_id).toBe('boot-test-123');
    expect(row.lease_until).toBe(new Date(FIXED_NOW.getTime() + 60_000).toISOString());
    expect(tasks.get(task.id)?.status).toBe('PREPARING');
    expect(scheduler.setInterval).toHaveBeenCalledWith(expect.any(Function), 15_000);

    await lease.release();
    expect(existsSync(join(lockDirectory, '100.lock'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM repo_locks').get()).toEqual({ count: 0 });
  });

  it('moves the task toward recovery when heartbeat ownership is lost', async () => {
    const { db, service, tasks, createWaitingTask } = setup();
    const task = createWaitingTask(100);
    const lease = await service.acquire(100, task.id);

    db.prepare('DELETE FROM repo_locks WHERE repo_id = 100').run();

    await expect(lease.heartbeat()).rejects.toThrow(RepoLockLostError);
    expect(tasks.get(task.id)?.status).toBe('NEEDS_RECOVERY');
  });

  it('removes the filesystem lock when SQLite acquisition fails after wx succeeds', async () => {
    const { db, service, lockDirectory, createWaitingTask } = setup();
    const holder = createWaitingTask(100);
    const contender = createWaitingTask(100);
    const now = FIXED_NOW.toISOString();

    db.prepare(`
      INSERT INTO repo_locks(
        repo_id, owner_task_id, lease_token, acquired_at, heartbeat_at, lease_until, owner_pid, owner_boot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(100, holder.id, 'existing-token', now, now, new Date(FIXED_NOW.getTime() + 60_000).toISOString(), 1, 'boot-existing');

    await expect(service.acquire(100, contender.id)).rejects.toThrow(RepoLockedError);
    expect(existsSync(join(lockDirectory, '100.lock'))).toBe(false);
  });
});
