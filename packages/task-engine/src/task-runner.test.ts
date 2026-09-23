import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import {
  NotRepairableCiOutcomeError,
  RemoteConfirmFailedError,
  TaskRunner,
  type RepairCycleEvent,
  type TaskRunnerOptions,
} from './task-runner.js';
import { TaskService } from './task-service.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

interface Fixture {
  taskId: string;
  audit: AuditRepository;
}

async function openFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gram-task-runner-'));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, 'state.db'));
  openDbs.push(db);
  runMigrations(db);
  const service = new TaskService(new TaskRepository(db), new AuditRepository(db));
  const task = await service.create({ repo: 'mamf-web', goal: 'Fix Excel download URL' });
  return { taskId: task.id, audit: new AuditRepository(db) };
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

interface Calls {
  acquire: number;
  reuse: number;
  repair: number;
  verify: number;
  push: number;
  confirm: number;
  release: number;
  observe: number;
}

function createCalls(): Calls {
  return { acquire: 0, reuse: 0, repair: 0, verify: 0, push: 0, confirm: 0, release: 0, observe: 0 };
}

interface FakeOptions {
  acquireError?: Error;
  confirmResult?: boolean;
  ciOutcome?: 'SUCCESS' | 'FAILURE' | 'PENDING';
}

function createOptions(audit: AuditRepository, calls: Calls, fake: FakeOptions = {}): TaskRunnerOptions {
  return {
    audit,
    locks: {
      acquire: async () => {
        calls.acquire += 1;
        if (fake.acquireError !== undefined) throw fake.acquireError;
        return {
          release: async () => {
            calls.release += 1;
          },
        };
      },
    },
    workspaces: {
      reuse: async () => {
        calls.reuse += 1;
        return {
          linuxPath: '/home/agent/.gram-agent/worktrees/84722133/task-uuid',
          branch: 'fix/task-0201-excel-download-url',
        };
      },
    },
    mutations: {
      repair: async () => {
        calls.repair += 1;
      },
    },
    verification: {
      verify: async () => {
        calls.verify += 1;
      },
    },
    git: {
      push: async () => {
        calls.push += 1;
        return 'a91c34f0a91c34f0a91c34f0a91c34f0a91c34f0';
      },
      confirmRemoteSha: async () => {
        calls.confirm += 1;
        return fake.confirmResult ?? true;
      },
    },
    ci: {
      observe: async () => {
        calls.observe += 1;
        return fake.ciOutcome ?? 'SUCCESS';
      },
    },
  };
}

function createInput(taskId: string) {
  return {
    taskId,
    repoId: 84722133,
    branch: 'fix/task-0201-excel-download-url',
    remote: 'origin',
    ciOutcome: 'FAILURE' as const,
  };
}

const expectedOrder: RepairCycleEvent[] = [
  'ci.failed',
  'lock.acquire',
  'workspace.reuse',
  'repair',
  'verify',
  'push',
  'remote.confirm',
  'lock.release',
  'ci.observe',
];

describe('TaskRunner.runRepairCycle', () => {
  it('emits the exact repair order after CI failure', async () => {
    const fixture = await openFixture();
    const calls = createCalls();
    const events: RepairCycleEvent[] = [];
    const runner = new TaskRunner(createOptions(fixture.audit, calls));

    const result = await runner.runRepairCycle(createInput(fixture.taskId), (event) => {
      events.push(event);
    });

    expect(events).toEqual(expectedOrder);
    expect(result.sha).toBe('a91c34f0a91c34f0a91c34f0a91c34f0a91c34f0');
    expect(result.ciOutcome).toBe('SUCCESS');
    expect(calls).toMatchObject({
      acquire: 1,
      reuse: 1,
      repair: 1,
      verify: 1,
      push: 1,
      confirm: 1,
      release: 1,
      observe: 1,
    });
  });

  it('runs no mutation before the lock is acquired', async () => {
    const fixture = await openFixture();
    const calls = createCalls();
    const events: RepairCycleEvent[] = [];
    const runner = new TaskRunner(createOptions(fixture.audit, calls, { acquireError: new Error('lease conflict') }));

    await expect(
      runner.runRepairCycle(createInput(fixture.taskId), (event) => {
        events.push(event);
      }),
    ).rejects.toThrow('lease conflict');

    expect(events).toEqual(['ci.failed']);
    expect(calls).toMatchObject({
      acquire: 1,
      reuse: 0,
      repair: 0,
      verify: 0,
      push: 0,
      confirm: 0,
      release: 0,
      observe: 0,
    });
  });

  it('never releases the lock when remote confirmation fails', async () => {
    const fixture = await openFixture();
    const calls = createCalls();
    const events: RepairCycleEvent[] = [];
    const runner = new TaskRunner(createOptions(fixture.audit, calls, { confirmResult: false }));

    await expect(
      runner.runRepairCycle(createInput(fixture.taskId), (event) => {
        events.push(event);
      }),
    ).rejects.toBeInstanceOf(RemoteConfirmFailedError);

    expect(events).toEqual([
      'ci.failed',
      'lock.acquire',
      'workspace.reuse',
      'repair',
      'verify',
      'push',
      'remote.confirm',
    ]);
    expect(calls.release).toBe(0);
    expect(calls.observe).toBe(0);
  });

  it('rejects non-failure CI outcomes without touching the lock', async () => {
    const fixture = await openFixture();
    const calls = createCalls();
    const events: RepairCycleEvent[] = [];
    const runner = new TaskRunner(createOptions(fixture.audit, calls));

    await expect(
      runner.runRepairCycle({ ...createInput(fixture.taskId), ciOutcome: 'SUCCESS' }, (event) => {
        events.push(event);
      }),
    ).rejects.toBeInstanceOf(NotRepairableCiOutcomeError);

    expect(events).toEqual([]);
    expect(calls).toMatchObject({
      acquire: 0,
      reuse: 0,
      repair: 0,
      verify: 0,
      push: 0,
      confirm: 0,
      release: 0,
      observe: 0,
    });
  });
});
