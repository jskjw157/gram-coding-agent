// runner.ts — single-engine workflow runner (MAC-03 WP-12, decision D11).
//
// This runner is the ONLY driver of fixture recipe/task lifecycles:
// create -> execute -> receipt -> resume. Schedule entries are consumed through
// this same engine (consumeScheduleEntry delegates to execute). This module
// owns no timers, queues, or background loops: there is no second scheduler.
//
// Lease/ledger ports mirror the origin/feat/ops-exec-core contracts without
// importing that branch:
// - LeasePort mirrors LeaseManager.acquire/release/assertUsable (all-or-nothing
//   acquire, fence epoch, durable blocks).
// - LedgerPort mirrors EffectLedger.prepare/dispatch (PREPARED -> DISPATCHING ->
//   CONFIRMED | NOT_APPLIED, with the DISPATCHING commit durable before the
//   transmit runs).
//
// FIXTURE profile only: construction refuses any other profile, and the fixture
// transmit always settles CONFIRMED without performing a real effect.
import { createHash, randomUUID } from 'node:crypto';

export type RunnerEffectClass = 'READ' | 'WRITE' | 'DELETE';

export type RunnerTaskState = 'CREATED' | 'EXECUTING' | 'SUCCEEDED' | 'RESUMED';

/** The only profile this runner ever operates under. */
export const RUNNER_PROFILE = 'FIXTURE' as const;

export class RunnerError extends Error {
  override name = 'RunnerError';
}

export class RunnerProfileError extends RunnerError {
  override name = 'RunnerProfileError';
}

export class CrossRequesterError extends RunnerError {
  override name = 'CrossRequesterError';
}

export class CheckpointDriftError extends RunnerError {
  override name = 'CheckpointDriftError';
}

export class ScheduleDuplicateError extends RunnerError {
  override name = 'ScheduleDuplicateError';
}

export class RunnerStateError extends RunnerError {
  override name = 'RunnerStateError';
}

export class RunnerUnknownTaskError extends RunnerError {
  override name = 'RunnerUnknownTaskError';
}

export interface RunnerLease {
  readonly resources: readonly string[];
  readonly owner: string;
  readonly token: string;
  readonly fenceEpoch: number;
}

export interface LeasePort {
  acquire(resources: string[], owner: string): RunnerLease;
  release(resources: string[], owner: string, token: string): void;
  assertUsable(resource: string, fenceEpoch: number): void;
}

export type LedgerEffectState = 'PREPARED' | 'DISPATCHING' | 'CONFIRMED' | 'NOT_APPLIED';

export interface LedgerEffect {
  readonly effectId: string;
  readonly operationId: string;
  readonly effectClass: RunnerEffectClass;
  readonly state: LedgerEffectState;
  readonly attempts: number;
}

export interface LedgerPort {
  prepare(operationId: string, effectClass: RunnerEffectClass): LedgerEffect;
  dispatch(
    effectId: string,
    transmit: () => Promise<'CONFIRMED' | 'NOT_APPLIED'>,
  ): Promise<LedgerEffect>;
}

export interface FixtureRecipe {
  readonly recipeId: string;
  readonly canonicalAction: string;
  readonly effectClass: RunnerEffectClass;
  readonly expectedState: string;
  readonly expectedVersion: string;
}

export interface RunnerTask {
  readonly taskId: string;
  readonly recipeId: string;
  readonly requester: string;
  readonly state: RunnerTaskState;
  readonly checkpointDigest: string;
}

export interface RunnerArtifactRef {
  readonly artifactId: string;
  readonly digest: string;
}

export interface RunnerReceipt {
  readonly operationId: string;
  readonly operationHash: string;
  readonly effectClass: RunnerEffectClass;
  readonly policyDecision: 'ALLOW';
  readonly appliedAt: string;
  readonly artifacts: readonly RunnerArtifactRef[];
}

export interface ResumeCheckpoint {
  readonly checkpointDigest: string;
}

export interface ScheduleEntry {
  readonly scheduleEntryId: string;
  readonly taskId: string;
}

export interface WorkflowRunnerOptions {
  readonly profile: string;
  readonly leases: LeasePort;
  readonly ledger: LedgerPort;
  readonly clock?: () => number;
}

interface StoredTask {
  taskId: string;
  recipe: FixtureRecipe;
  requester: string;
  state: RunnerTaskState;
  checkpointDigest: string;
}

const effectClasses: readonly RunnerEffectClass[] = ['READ', 'WRITE', 'DELETE'];

const shaHex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const assertNonEmpty = (value: string, label: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunnerError(`${label} must be a non-empty string`);
  }
};

const checkpointFor = (taskId: string, recipe: FixtureRecipe, previous: string): string =>
  shaHex(
    [taskId, recipe.recipeId, recipe.expectedState, recipe.expectedVersion, previous].join('|'),
  );

const operationHashFor = (taskId: string, recipe: FixtureRecipe): string =>
  shaHex(
    [
      taskId,
      recipe.recipeId,
      recipe.canonicalAction,
      recipe.effectClass,
      recipe.expectedState,
      recipe.expectedVersion,
    ].join('|'),
  );

export class WorkflowRunner {
  private readonly leases: LeasePort;
  private readonly ledger: LedgerPort;
  private readonly clock: () => number;
  private readonly tasks = new Map<string, StoredTask>();
  private readonly consumedScheduleEntries = new Set<string>();

  constructor(options: WorkflowRunnerOptions) {
    if (options.profile !== RUNNER_PROFILE) {
      throw new RunnerProfileError(
        `WorkflowRunner runs under FIXTURE only (requested: ${options.profile})`,
      );
    }
    this.leases = options.leases;
    this.ledger = options.ledger;
    this.clock = options.clock ?? (() => Date.now());
  }

  createTask(recipe: FixtureRecipe, requester: string): RunnerTask {
    assertNonEmpty(requester, 'requester');
    assertNonEmpty(recipe.recipeId, 'recipeId');
    assertNonEmpty(recipe.canonicalAction, 'canonicalAction');
    assertNonEmpty(recipe.expectedState, 'expectedState');
    assertNonEmpty(recipe.expectedVersion, 'expectedVersion');
    if (!effectClasses.includes(recipe.effectClass)) {
      throw new RunnerError(`effectClass must be one of: ${effectClasses.join(', ')}`);
    }
    const taskId = randomUUID();
    const stored: StoredTask = {
      taskId,
      recipe: { ...recipe },
      requester,
      state: 'CREATED',
      checkpointDigest: checkpointFor(taskId, recipe, 'genesis'),
    };
    this.tasks.set(taskId, stored);
    return copyOf(stored);
  }

  getTask(taskId: string): RunnerTask {
    return copyOf(this.requireTask(taskId));
  }

  async execute(taskId: string, requester: string): Promise<RunnerReceipt> {
    const task = this.requireTask(taskId);
    this.requireOwner(task, requester);
    if (task.state !== 'CREATED' && task.state !== 'RESUMED') {
      throw new RunnerStateError(`execute requires CREATED or RESUMED, found ${task.state}`);
    }
    const previousState = task.state;
    const resource = `task:${taskId}`;
    task.state = 'EXECUTING';
    const lease = this.leases.acquire([resource], requester);
    try {
      this.leases.assertUsable(resource, lease.fenceEpoch);
      const prepared = this.ledger.prepare(taskId, task.recipe.effectClass);
      // Fixture transmit: settles CONFIRMED without performing a real effect.
      const settled = await this.ledger.dispatch(prepared.effectId, async () => 'CONFIRMED');
      if (settled.state !== 'CONFIRMED') {
        throw new RunnerStateError(`fixture dispatch must settle CONFIRMED, found ${settled.state}`);
      }
      const receipt: RunnerReceipt = {
        operationId: taskId,
        operationHash: operationHashFor(taskId, task.recipe),
        effectClass: task.recipe.effectClass,
        policyDecision: 'ALLOW',
        appliedAt: new Date(this.clock()).toISOString(),
        artifacts: [],
      };
      task.state = 'SUCCEEDED';
      task.checkpointDigest = checkpointFor(taskId, task.recipe, receipt.operationHash);
      return receipt;
    } catch (error) {
      task.state = previousState;
      throw error;
    } finally {
      this.leases.release([resource], requester, lease.token);
    }
  }

  async resume(taskId: string, requester: string, checkpoint: ResumeCheckpoint): Promise<RunnerTask> {
    const task = this.requireTask(taskId);
    this.requireOwner(task, requester);
    assertNonEmpty(checkpoint.checkpointDigest, 'checkpointDigest');
    if (checkpoint.checkpointDigest !== task.checkpointDigest) {
      throw new CheckpointDriftError(
        `checkpoint drift for task ${taskId}: presented digest does not match stored checkpoint`,
      );
    }
    if (task.state === 'EXECUTING') {
      throw new RunnerStateError('resume refused while task is EXECUTING');
    }
    task.state = 'RESUMED';
    return copyOf(task);
  }

  /**
   * Consume a schedule entry through the SAME engine: delegation to execute().
   * No timers, no queue, no background loop — the caller drives cadence.
   */
  async consumeScheduleEntry(entry: ScheduleEntry, requester: string): Promise<RunnerReceipt> {
    assertNonEmpty(entry.scheduleEntryId, 'scheduleEntryId');
    assertNonEmpty(entry.taskId, 'taskId');
    if (this.consumedScheduleEntries.has(entry.scheduleEntryId)) {
      throw new ScheduleDuplicateError(
        `schedule entry already consumed: ${entry.scheduleEntryId}`,
      );
    }
    this.consumedScheduleEntries.add(entry.scheduleEntryId);
    try {
      return await this.execute(entry.taskId, requester);
    } catch (error) {
      this.consumedScheduleEntries.delete(entry.scheduleEntryId);
      throw error;
    }
  }

  private requireTask(taskId: string): StoredTask {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new RunnerUnknownTaskError(`unknown task: ${taskId}`);
    return task;
  }

  private requireOwner(task: StoredTask, requester: string): void {
    if (task.requester !== requester) {
      throw new CrossRequesterError(
        `requester ${requester} does not own task ${task.taskId}`,
      );
    }
  }
}

const copyOf = (stored: StoredTask): RunnerTask => ({
  taskId: stored.taskId,
  recipeId: stored.recipe.recipeId,
  requester: stored.requester,
  state: stored.state,
  checkpointDigest: stored.checkpointDigest,
});
