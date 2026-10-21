import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId, TaskStatus } from '@gram/domain';
import {
  LockRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  type StoredTask,
} from '@gram/persistence';
import { RepoLockService } from '@gram/repo-lock';
import { TaskRunnerConfigurationError } from './task-runner-composition.js';
import { TaskScheduler } from './task-scheduler.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
const schedulers: TaskScheduler[] = [];
const leases: Array<{ release(): Promise<void> }> = [];
const barrierResolvers: Array<() => void> = [];

const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z');

interface Deferred {
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface SchedulerFixture {
  readonly root: string;
  readonly db: ReturnType<typeof openDatabase>;
  readonly repositories: RepositoryRepository;
  readonly tasks: TaskRepository;
  readonly locks: LockRepository;
  readonly lockDirectory: string;
  readonly service: RepoLockService;
}

function setup(): SchedulerFixture {
  const root = mkdtempSync(join(tmpdir(), 'gram-task-scheduler-'));
  roots.push(root);
  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);

  const repositories = new RepositoryRepository(db);
  const tasks = new TaskRepository(db);
  const locks = new LockRepository(db);
  const lockDirectory = join(root, 'locks');
  const service = new RepoLockService({
    locks,
    tasks,
    lockDirectory,
    now: () => FIXED_NOW,
    pid: () => 4242,
    bootId: () => 'boot-scheduler-test',
    scheduler: {
      setInterval: (): unknown => 0,
      clearInterval: (): void => undefined,
    },
  });
  return { root, db, repositories, tasks, locks, lockDirectory, service };
}

function seedRepo(repositories: RepositoryRepository, root: string, id: number): void {
  repositories.upsert({
    githubRepositoryId: id,
    owner: 'acme',
    name: `repo-${id}`,
    defaultBranch: 'main',
    localBasePath: join(root, `repo-${id}`),
  });
}

function createBoundTask(tasks: TaskRepository, repoId: number, goal: string): StoredTask {
  return tasks.create({
    goal,
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId,
    repoSelector: `acme/repo-${repoId}`,
  });
}

interface AuditEvent {
  taskId?: TaskId | null;
  eventType: string;
  payload?: unknown;
  createdAt?: string;
}

function createAudit(): { events: AuditEvent[]; port: { append(event: AuditEvent): number } } {
  const events: AuditEvent[] = [];
  return {
    events,
    port: {
      append: (event: AuditEvent): number => {
        events.push(event);
        return events.length;
      },
    },
  };
}

function createLogger(): {
  errors: Array<{ message: string; metadata: Record<string, unknown> }>;
  port: { error(message: string, metadata?: Record<string, unknown>): void };
} {
  const errors: Array<{ message: string; metadata: Record<string, unknown> }> = [];
  return {
    errors,
    port: {
      error: (message: string, metadata: Record<string, unknown> = {}): void => {
        errors.push({ message, metadata });
      },
    },
  };
}

function createInterval(): {
  sets: number;
  clears: number;
  callbacks: Array<() => void>;
  port: { setInterval(callback: () => void, intervalMs: number): unknown; clearInterval(handle: unknown): void };
} {
  const callbacks: Array<() => void> = [];
  const state = {
    sets: 0,
    clears: 0,
    callbacks,
    port: {
      setInterval: (callback: () => void, intervalMs: number): unknown => {
        void intervalMs;
        state.sets += 1;
        callbacks.push(callback);
        return callbacks.length;
      },
      clearInterval: (handle: unknown): void => {
        void handle;
        state.clears += 1;
      },
    },
  };
  return state;
}

afterEach(async () => {
  for (const resolve of barrierResolvers.splice(0)) resolve();
  for (const scheduler of schedulers.splice(0)) {
    try {
      await scheduler.stop();
    } catch {
      /* teardown best-effort: a failed drain must not mask the test result */
    }
  }
  for (const lease of leases.splice(0)) {
    try {
      await lease.release();
    } catch {
      /* teardown best-effort: idempotent releases may already be settled */
    }
  }
  while (databases.length > 0) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('TaskScheduler', () => {
  it('claims a QUEUED task and reaches RUNNING before failing closed at instructions.load', async () => {
    const { tasks, repositories, root, service } = setup();
    seedRepo(repositories, root, 100);
    const task = createBoundTask(tasks, 100, 'Ship the web fix');
    const audit = createAudit();
    const logger = createLogger();
    const entered: TaskId[] = [];
    let observedAtFailure: TaskStatus | null = null;
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        entered.push(taskId);
        const lease = await service.acquire(100, taskId);
        leases.push(lease);
        tasks.transition(taskId, 'PREPARING', 'RUNNING');
        observedAtFailure = tasks.get(taskId)?.status ?? null;
        throw new TaskRunnerConfigurationError(
          'Instructions',
          'repository instruction loading is not wired in the agent composition root',
        );
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();

    expect(entered).toEqual([task.id]);
    // The claim (QUEUED -> WAITING_REPO_LOCK) and the lock acquisition
    // (WAITING_REPO_LOCK -> PREPARING) both completed synchronously inside
    // tick(): the async runner body runs without yielding before its first
    // await, and every lock primitive underneath is synchronous. PREPARING
    // is only reachable through WAITING_REPO_LOCK, so this proves the claim.
    expect(tasks.get(task.id)?.status).toBe('PREPARING');

    await flush();

    expect(observedAtFailure).toBe('RUNNING');
    expect(tasks.get(task.id)?.status).toBe('FAILED');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      taskId: task.id,
      eventType: 'TASK_RUN_FAILED',
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(logger.errors).toHaveLength(1);
  });

  it('never mutates two tasks from the same repository concurrently because RepoLock blocks the second', async () => {
    const { tasks, repositories, root, service } = setup();
    seedRepo(repositories, root, 100);
    const taskA = createBoundTask(tasks, 100, 'Task A same repo');
    const taskB = createBoundTask(tasks, 100, 'Task B same repo');
    const audit = createAudit();
    const logger = createLogger();
    const entered: TaskId[] = [];
    const critical: TaskId[] = [];
    const lockRejected: TaskId[] = [];
    let active = 0;
    let maxActive = 0;
    const gateA = deferred();
    const gateB = deferred();
    barrierResolvers.push(() => gateA.resolve(), () => gateB.resolve());
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        entered.push(taskId);
        let lease;
        try {
          lease = await service.acquire(100, taskId);
        } catch (error) {
          lockRejected.push(taskId);
          throw error;
        }
        leases.push(lease);
        active += 1;
        maxActive = Math.max(maxActive, active);
        critical.push(taskId);
        if (taskId === taskA.id) await gateA.promise;
        else await gateB.promise;
        active -= 1;
        await lease.release();
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();
    await flush();

    // No global queue held B back: both runs were dispatched, but only A
    // entered the post-lock critical section while A holds the lease.
    expect(entered).toEqual([taskA.id, taskB.id]);
    expect(critical).toEqual([taskA.id]);
    expect(lockRejected).toEqual([taskB.id]);
    expect(maxActive).toBe(1);
    expect(tasks.get(taskA.id)?.status).toBe('PREPARING');
    expect(tasks.get(taskB.id)?.status).toBe('WAITING_REPO_LOCK');
    expect(audit.events).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);

    gateA.resolve();
    await flush();

    scheduler.tick();
    await flush();

    expect(critical).toEqual([taskA.id, taskB.id]);
    expect(tasks.get(taskB.id)?.status).toBe('PREPARING');

    gateB.resolve();
    await flush();

    expect(maxActive).toBe(1);
    expect(audit.events).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('runs tasks from different repositories concurrently without a global queue', async () => {
    const { tasks, repositories, root, service } = setup();
    seedRepo(repositories, root, 100);
    seedRepo(repositories, root, 200);
    const taskA = createBoundTask(tasks, 100, 'Task A repo 100');
    const taskB = createBoundTask(tasks, 200, 'Task B repo 200');
    const audit = createAudit();
    const logger = createLogger();
    const repoOf = new Map<TaskId, number>([
      [taskA.id, 100],
      [taskB.id, 200],
    ]);
    const entered: TaskId[] = [];
    let active = 0;
    let maxActive = 0;
    const bothEntered = deferred();
    const releaseGate = deferred();
    barrierResolvers.push(() => bothEntered.resolve(), () => releaseGate.resolve());
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        entered.push(taskId);
        const repoId = repoOf.get(taskId);
        if (repoId === undefined) throw new Error(`unknown task: ${taskId}`);
        const lease = await service.acquire(repoId, taskId);
        leases.push(lease);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) bothEntered.resolve();
        await releaseGate.promise;
        active -= 1;
        await lease.release();
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();

    // A global single-task queue or run mutex would deadlock here: the
    // barrier only resolves once BOTH runs hold their own repo lease.
    await bothEntered.promise;

    expect(entered).toEqual([taskA.id, taskB.id]);
    expect(active).toBe(2);
    expect(maxActive).toBe(2);

    releaseGate.resolve();
    await flush();

    expect(tasks.get(taskA.id)?.status).toBe('PREPARING');
    expect(tasks.get(taskB.id)?.status).toBe('PREPARING');
    expect(audit.events).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('retries a stranded WAITING_REPO_LOCK task after restart and later lock release', async () => {
    const { tasks, repositories, root, service } = setup();
    seedRepo(repositories, root, 100);
    const blocker = createBoundTask(tasks, 100, 'Blocker holds the repo');
    tasks.transition(blocker.id, 'QUEUED', 'WAITING_REPO_LOCK');
    const blockerLease = await service.acquire(100, blocker.id);
    leases.push(blockerLease);

    const stranded = createBoundTask(tasks, 100, 'Stranded waiter');
    const audit = createAudit();
    const logger = createLogger();
    const completed: TaskId[] = [];
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        const lease = await service.acquire(100, taskId);
        leases.push(lease);
        tasks.transition(taskId, 'PREPARING', 'RUNNING');
        completed.push(taskId);
        await lease.release();
      },
    };
    const first = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(first);

    first.tick();
    await flush();

    expect(tasks.get(stranded.id)?.status).toBe('WAITING_REPO_LOCK');
    expect(completed).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);

    await blockerLease.release();
    const second = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(second);

    second.tick();
    await flush();

    expect(completed).toEqual([stranded.id]);
    expect(tasks.get(stranded.id)?.status).toBe('RUNNING');
    expect(audit.events).toHaveLength(0);
  });

  it('dispatches queued work when waiting candidates exceed the per-status batch limit', async () => {
    const { tasks } = setup();
    const waiting: StoredTask[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = tasks.create({
        goal: `Waiting ${index}`,
        taskType: 'CODING',
        publishMode: 'PULL_REQUEST',
      });
      tasks.transition(created.id, 'QUEUED', 'WAITING_REPO_LOCK');
      waiting.push(created);
    }
    const queued = tasks.create({
      goal: 'Queued behind the waiting overflow',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const audit = createAudit();
    const logger = createLogger();
    const dispatched: TaskId[] = [];
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        dispatched.push(taskId);
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
      perStatusLimit: 1,
    });
    schedulers.push(scheduler);

    scheduler.tick();
    await flush();

    const oldestWaiting = waiting[0];
    if (oldestWaiting === undefined) throw new Error('expected a waiting task');
    expect(dispatched).toEqual([oldestWaiting.id, queued.id]);
    expect(tasks.get(queued.id)?.status).toBe('WAITING_REPO_LOCK');
  });

  it('does not dispatch the same task twice across overlapping ticks', async () => {
    const { tasks } = setup();
    const task = tasks.create({
      goal: 'Single-flight task',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const audit = createAudit();
    const logger = createLogger();
    let entries = 0;
    const gate = deferred();
    barrierResolvers.push(() => gate.resolve());
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        expect(taskId).toBe(task.id);
        entries += 1;
        await gate.promise;
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    await flush();

    expect(entries).toBe(1);

    gate.resolve();
    await flush();

    expect(entries).toBe(1);

    scheduler.tick();
    await flush();

    expect(entries).toBe(2);
  });

  it.each(['WAITING_REPO_LOCK', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING'] as const)(
    'transitions a failed run from %s to FAILED using the reread durable status',
    async (status) => {
      const { tasks, db, repositories, root } = setup();
      seedRepo(repositories, root, 100);
      const task = tasks.create({
        goal: `Fail from ${status}`,
        taskType: 'CODING',
        publishMode: 'PULL_REQUEST',
        repoId: 100,
      });
      const audit = createAudit();
      const logger = createLogger();
      const runner = {
        run: async (taskId: TaskId): Promise<void> => {
          db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
          throw new Error(`boom from ${status}`);
        },
      };
      const scheduler = new TaskScheduler({
        tasks,
        runner,
        audit: audit.port,
        logger: logger.port,
        now: () => FIXED_NOW,
      });
      schedulers.push(scheduler);

      scheduler.tick();
      await flush();

      expect(tasks.get(task.id)?.status).toBe('FAILED');
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        taskId: task.id,
        eventType: 'TASK_RUN_FAILED',
        createdAt: FIXED_NOW.toISOString(),
      });
      expect(logger.errors).toHaveLength(1);
    },
  );

  it('starts and stops idempotently and stop prevents dispatch while draining in-flight work', async () => {
    const { tasks } = setup();
    const first = tasks.create({
      goal: 'First drains',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const audit = createAudit();
    const logger = createLogger();
    const interval = createInterval();
    const entered: TaskId[] = [];
    const gate = deferred();
    barrierResolvers.push(() => gate.resolve());
    const runner = {
      run: async (taskId: TaskId): Promise<void> => {
        entered.push(taskId);
        await gate.promise;
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      interval: interval.port,
      now: () => FIXED_NOW,
      intervalMs: 50,
    });
    schedulers.push(scheduler);

    scheduler.start();
    scheduler.start();

    expect(interval.sets).toBe(1);
    expect(entered).toEqual([first.id]);

    const draining = scheduler.stop();
    const drainingAgain = scheduler.stop();

    expect(draining).toBe(drainingAgain);
    expect(interval.clears).toBe(1);

    const second = tasks.create({
      goal: 'Second never dispatches after stop',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    scheduler.tick();
    await flush();

    expect(entered).toEqual([first.id]);
    expect(tasks.get(second.id)?.status).toBe('QUEUED');

    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    gate.resolve();
    await draining;
    await flush();

    expect(drained).toBe(true);
    expect(entered).toEqual([first.id]);
  });

  it('S5 treats a name-spoofed RepoLockedError without discriminator as a real failure', async () => {
    const { tasks } = setup();
    const task = tasks.create({
      goal: 'Name-spoofed lock error is not a lock signal',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const audit = createAudit();
    const logger = createLogger();
    const runner = {
      run: async (): Promise<void> => {
        const spoofed = new Error('spoofed lock contention');
        spoofed.name = 'RepoLockedError';
        throw spoofed;
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();
    await flush();

    expect(tasks.get(task.id)?.status).toBe('FAILED');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      taskId: task.id,
      eventType: 'TASK_RUN_FAILED',
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(logger.errors).toHaveLength(1);
  });

  it('retains WAITING_REPO_LOCK for a duck-typed lock signal carrying the shared discriminator', async () => {
    const { tasks } = setup();
    const task = tasks.create({
      goal: 'Discriminated lock signal stays queued',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const audit = createAudit();
    const logger = createLogger();
    const runner = {
      run: async (): Promise<void> => {
        throw { code: 'REPO_LOCKED', repoId: 100 };
      },
    };
    const scheduler = new TaskScheduler({
      tasks,
      runner,
      audit: audit.port,
      logger: logger.port,
      now: () => FIXED_NOW,
    });
    schedulers.push(scheduler);

    scheduler.tick();
    await flush();

    expect(tasks.get(task.id)?.status).toBe('WAITING_REPO_LOCK');
    expect(audit.events).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });
});
