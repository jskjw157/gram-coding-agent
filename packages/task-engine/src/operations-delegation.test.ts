// operations-delegation.test.ts — T10 repair RED: Operations path MUST delegate
// to the M2 engine (TaskService/TaskRunner/state machine, read via
// `git show origin/feat/m2-vertical-slice:...` read-only) under T4 lease
// semantics (LeaseManager.acquire/release/assertUsable, read via
// `git show origin/feat/ops-exec-core:...` read-only). No standalone
// execution path may remain: without an injected M2 runner the dispatch
// throws fail-closed instead of executing in-memory.
import { describe, expect, it } from 'vitest';
import {
  OperationsDispatch,
  OperationsProfileError,
  type DelegatedTaskView,
  type M2StateMachinePort,
  type M2TaskRunnerPort,
  type M2TaskServicePort,
  type M2TaskViewPort,
  type T4LeasePort,
} from './operations-delegation.js';

const service = (): M2TaskServicePort & { calls: unknown[] } => {
  const calls: unknown[] = [];
  let sequence = 0;
  return {
    calls,
    create: async (input: { repo: string; goal: string }) => {
      calls.push(input);
      sequence += 1;
      return {
        taskId: `task-${sequence}`,
        displayId: `TASK-${sequence}`,
        repo: input.repo,
        goal: input.goal,
        status: 'QUEUED' as const,
      };
    },
  };
};

const runner = (): M2TaskRunnerPort & { runs: string[] } => {
  const runs: string[] = [];
  return {
    runs,
    run: async (taskId: string) => {
      runs.push(taskId);
    },
  };
};

const stateMachine = (): M2StateMachinePort & { transitions: unknown[] } => {
  const transitions: unknown[] = [];
  return {
    transitions,
    transition: (taskId: string, from: string, to: string): void => {
      transitions.push({ taskId, from, to });
    },
  };
};

const leases = (): T4LeasePort & { acquired: unknown[]; released: unknown[]; asserted: unknown[] } => {
  const acquired: unknown[] = [];
  const released: unknown[] = [];
  const asserted: unknown[] = [];
  let epoch = 0;
  return {
    acquired,
    released,
    asserted,
    acquire: (resources: string[], owner: string) => {
      epoch += 1;
      acquired.push({ resources, owner });
      return { resources: [...resources].sort(), owner, token: `token-${epoch}`, fenceEpoch: epoch };
    },
    release: (resources: string[], owner: string, token: string): void => {
      released.push({ resources, owner, token });
    },
    assertUsable: (resource: string, fenceEpoch: number): void => {
      asserted.push({ resource, fenceEpoch });
    },
  };
};

const views = (
  store: Map<string, DelegatedTaskView>,
): M2TaskViewPort & { store: Map<string, DelegatedTaskView> } => ({
  store,
  view: async (taskId: string) => store.get(taskId) ?? null,
});

const dispatch = (): {
  operations: OperationsDispatch;
  ports: {
    service: M2TaskServicePort & { calls: unknown[] };
    runner: M2TaskRunnerPort & { runs: string[] };
    stateMachine: M2StateMachinePort & { transitions: unknown[] };
    leasePort: T4LeasePort & { acquired: unknown[]; released: unknown[]; asserted: unknown[] };
  };
} => {
  const ports = { service: service(), runner: runner(), stateMachine: stateMachine(), leasePort: leases() };
  const store = new Map<string, DelegatedTaskView>();
  const operations = new OperationsDispatch({
    profile: 'FIXTURE',
    service: {
      ...ports.service,
      create: async (input: { repo: string; goal: string }) => {
        const view = await ports.service.create(input);
        store.set(view.taskId, view);
        return view;
      },
    },
    runner: ports.runner,
    stateMachine: ports.stateMachine,
    views: views(store),
    leases: ports.leasePort,
  });
  return { operations, ports };
};

describe('OperationsDispatch delegation to M2', () => {
  it('creates through the M2 task service and holds no task state itself', async () => {
    const { operations, ports } = dispatch();
    const first = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    const second = await operations.create({ repo: 'owner/repo', goal: 'goal-b' });
    expect(ports.service.calls).toHaveLength(2);
    expect(first.taskId).not.toBe(second.taskId);
  });

  it('runs through the M2 task runner under a T4 lease (acquire -> assertUsable -> run -> release)', async () => {
    const { operations, ports } = dispatch();
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    const receipt = await operations.run(created.taskId, 'requester-a');
    expect(ports.runner.runs).toEqual([created.taskId]);
    expect(ports.leasePort.acquired).toHaveLength(1);
    expect(ports.leasePort.asserted).toHaveLength(1);
    expect(ports.leasePort.released).toHaveLength(1);
    expect(receipt.operationId).toBe(created.taskId);
  });

  it('throws fail-closed without an M2 runner instead of executing standalone', async () => {
    const ports = { service: service(), stateMachine: stateMachine(), leasePort: leases() };
    const operations = new OperationsDispatch({
      profile: 'FIXTURE',
      service: ports.service,
      runner: undefined,
      stateMachine: ports.stateMachine,
      views: views(new Map()),
      leases: ports.leasePort,
    });
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    await expect(operations.run(created.taskId, 'requester-a')).rejects.toThrow();
    expect(ports.leasePort.released).toHaveLength(0);
  });

  it('releases the T4 lease when the M2 runner throws', async () => {
    const { operations, ports } = dispatch();
    ports.runner.run = async (): Promise<void> => {
      throw new Error('m2-run-failed');
    };
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    await expect(operations.run(created.taskId, 'requester-a')).rejects.toThrow('m2-run-failed');
    expect(ports.leasePort.released).toHaveLength(1);
  });

  it('resumes through the M2 state machine, not checkpoint digests', async () => {
    const { operations, ports } = dispatch();
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    await operations.resume(created.taskId, 'QUEUED', 'WAITING_REPO_LOCK');
    expect(ports.stateMachine.transitions).toEqual([
      { taskId: created.taskId, from: 'QUEUED', to: 'WAITING_REPO_LOCK' },
    ]);
  });

  it('consumes a schedule entry through the same M2 run and refuses duplicates', async () => {
    const { operations, ports } = dispatch();
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    await operations.consumeScheduleEntry(
      { scheduleEntryId: 'sched-1', taskId: created.taskId },
      'requester-a',
    );
    expect(ports.runner.runs).toEqual([created.taskId]);
    await expect(
      operations.consumeScheduleEntry(
        { scheduleEntryId: 'sched-1', taskId: created.taskId },
        'requester-a',
      ),
    ).rejects.toThrow();
    expect(ports.runner.runs).toHaveLength(1);
  });

  it('inspects M2 task state without executing', async () => {
    const { operations, ports } = dispatch();
    const created = await operations.create({ repo: 'owner/repo', goal: 'goal-a' });
    const view = await operations.inspect(created.taskId);
    expect(view.taskId).toBe(created.taskId);
    expect(ports.runner.runs).toHaveLength(0);
    await expect(operations.inspect('task-missing')).rejects.toThrow();
  });

  it('refuses non-FIXTURE profiles at construction', () => {
    expect(
      () =>
        new OperationsDispatch({
          profile: 'WRITE_APPROVED',
          service: service(),
          runner: runner(),
          stateMachine: stateMachine(),
          views: views(new Map()),
          leases: leases(),
        }),
    ).toThrow(OperationsProfileError);
  });
});
