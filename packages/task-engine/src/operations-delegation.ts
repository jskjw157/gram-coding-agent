// operations-delegation.ts — Operations path as additive composition on the
// M2 engine (T10 repair: the standalone in-memory WorkflowRunner divergence
// is deleted; this module replaces it).
//
// M2 contracts (read via `git show origin/feat/m2-vertical-slice:...`
// read-only; never edited, never vendored — the injected ports below mirror
// their shapes and the real M2 service/runner is wired at the call site):
// - packages/task-engine/src/task-service.ts: TaskService.create({repo, goal})
// - packages/task-engine/src/task-runner.ts: TaskRunner.run(taskId)
// - packages/task-engine/src/task-runner-ports.ts: run port DTOs (identifiers,
//   paths, and results only — never secrets)
// - packages/task-engine/src/state-machine.ts: TaskStateMachine.transition,
//   guarded by canTransitionTaskStatus
//
// T4 lease semantics (read via
// `git show origin/feat/ops-exec-core:packages/task-engine/src/lease-manager.ts`
// read-only): LeaseManager.acquire (all-or-nothing, fence epoch) + release
// (owner/token pair) + assertUsable (fence epoch + durable blocks).
//
// This module adds NO execution logic: no task map, no checkpoint digests,
// no ledger transmit. Dispatch is service.create -> lease acquire/assertUsable
// -> runner.run -> lease release. Without an injected M2 runner, run throws
// fail-closed; there is no in-memory fallback.
import { createHash } from 'node:crypto';

/** The only profile this dispatch ever operates under. */
export const OPERATIONS_PROFILE = 'FIXTURE' as const;

export class OperationsError extends Error {
  override name = 'OperationsError';
}

export class OperationsProfileError extends OperationsError {
  override name = 'OperationsProfileError';
}

export class OperationsConfigurationError extends OperationsError {
  override name = 'OperationsConfigurationError';
}

export class ScheduleDuplicateError extends OperationsError {
  override name = 'ScheduleDuplicateError';
}

export interface DelegatedTaskView {
  readonly taskId: string;
  readonly displayId: string;
  readonly repo: string;
  readonly goal: string;
  readonly status: string;
}

/** Structural mirror of M2 TaskService.create (task-service.ts). */
export interface M2TaskServicePort {
  create(input: { readonly repo: string; readonly goal: string }): Promise<DelegatedTaskView>;
}

/** Structural mirror of M2 TaskRunner.run (task-runner.ts). */
export interface M2TaskRunnerPort {
  run(taskId: string): Promise<void>;
}

/** Structural mirror of M2 TaskStateMachine.transition (state-machine.ts). */
export interface M2StateMachinePort {
  transition(taskId: string, from: string, to: string): void;
}

/** Structural mirror of the T4 LeaseManager lease (lease-manager.ts). */
export interface DelegationLease {
  readonly resources: readonly string[];
  readonly owner: string;
  readonly token: string;
  readonly fenceEpoch: number;
}

/** Structural mirror of the M2 state machine store read (TaskRepository.get shape). */
export interface M2TaskViewPort {
  view(taskId: string): Promise<DelegatedTaskView | null>;
}

/** Structural mirror of T4 LeaseManager.acquire/release/assertUsable. */
export interface T4LeasePort {
  acquire(resources: string[], owner: string): DelegationLease;
  release(resources: string[], owner: string, token: string): void;
  assertUsable(resource: string, fenceEpoch: number): void;
}

export interface OperationsReceipt {
  readonly operationId: string;
  readonly operationHash: string;
  readonly policyDecision: 'ALLOW';
  readonly appliedAt: string;
}

export interface ScheduleEntry {
  readonly scheduleEntryId: string;
  readonly taskId: string;
}

export interface OperationsDispatchOptions {
  readonly profile: string;
  readonly service: M2TaskServicePort;
  readonly runner: M2TaskRunnerPort | undefined;
  readonly stateMachine: M2StateMachinePort;
  readonly views: M2TaskViewPort;
  readonly leases: T4LeasePort;
  readonly clock?: () => number;
}

const shaHex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const assertNonEmpty = (value: string, label: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationsError(`${label} must be a non-empty string`);
  }
};

export class OperationsDispatch {
  private readonly service: M2TaskServicePort;
  private readonly runner: M2TaskRunnerPort | undefined;
  private readonly stateMachine: M2StateMachinePort;
  private readonly views: M2TaskViewPort;
  private readonly leases: T4LeasePort;
  private readonly clock: () => number;
  private readonly consumedScheduleEntries = new Set<string>();

  constructor(options: OperationsDispatchOptions) {
    if (options.profile !== OPERATIONS_PROFILE) {
      throw new OperationsProfileError(
        `OperationsDispatch runs under FIXTURE only (requested: ${options.profile})`,
      );
    }
    this.service = options.service;
    this.runner = options.runner;
    this.stateMachine = options.stateMachine;
    this.views = options.views;
    this.leases = options.leases;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Delegate creation to the M2 task service. Holds no task state. */
  async create(input: { readonly repo: string; readonly goal: string }): Promise<DelegatedTaskView> {
    assertNonEmpty(input.repo, 'repo');
    assertNonEmpty(input.goal, 'goal');
    return this.service.create({ repo: input.repo, goal: input.goal });
  }

  /**
   * Delegate execution to the M2 task runner under a T4 lease:
   * acquire -> assertUsable -> runner.run -> release. Fail-closed when no
   * M2 runner is wired: throws before acquiring anything.
   */
  async run(taskId: string, requester: string): Promise<OperationsReceipt> {
    assertNonEmpty(taskId, 'taskId');
    assertNonEmpty(requester, 'requester');
    const runner = this.runner;
    if (runner === undefined) {
      throw new OperationsConfigurationError(
        'OperationsDispatch.run needs an M2 TaskRunner port: refusing standalone execution',
      );
    }
    const resource = `task:${taskId}`;
    const lease = this.leases.acquire([resource], requester);
    try {
      this.leases.assertUsable(resource, lease.fenceEpoch);
      await runner.run(taskId);
      return {
        operationId: taskId,
        operationHash: shaHex(taskId),
        policyDecision: 'ALLOW',
        appliedAt: new Date(this.clock()).toISOString(),
      };
    } finally {
      this.leases.release([resource], requester, lease.token);
    }
  }

  /** Delegate resume to the M2 state machine (transition guard, no digests). */
  async resume(taskId: string, from: string, to: string): Promise<void> {
    assertNonEmpty(taskId, 'taskId');
    assertNonEmpty(from, 'from');
    assertNonEmpty(to, 'to');
    this.stateMachine.transition(taskId, from, to);
  }

  /** Read M2 task state without executing. Unknown tasks throw. */
  async inspect(taskId: string): Promise<DelegatedTaskView> {
    assertNonEmpty(taskId, 'taskId');
    const view = await this.views.view(taskId);
    if (view === null) {
      throw new OperationsError(`unknown task: ${taskId}`);
    }
    return view;
  }

  /**
   * Consume a schedule entry through the SAME M2-backed run: delegation to
   * run(). No timers, no queue, no background loop — the caller drives cadence.
   */
  async consumeScheduleEntry(entry: ScheduleEntry, requester: string): Promise<OperationsReceipt> {
    assertNonEmpty(entry.scheduleEntryId, 'scheduleEntryId');
    assertNonEmpty(entry.taskId, 'taskId');
    if (this.consumedScheduleEntries.has(entry.scheduleEntryId)) {
      throw new ScheduleDuplicateError(
        `schedule entry already consumed: ${entry.scheduleEntryId}`,
      );
    }
    this.consumedScheduleEntries.add(entry.scheduleEntryId);
    try {
      return await this.run(entry.taskId, requester);
    } catch (error) {
      this.consumedScheduleEntries.delete(entry.scheduleEntryId);
      throw error;
    }
  }
}
