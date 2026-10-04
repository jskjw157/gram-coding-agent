// runner.test.ts — MAC-03 WP-12 RED: single-engine workflow runner (FIXTURE only).
//
// Ports mirror origin/feat/ops-exec-core contracts:
// - LeasePort mirrors LeaseManager.acquire/release/assertUsable (all-or-nothing,
//   fence epoch, durable blocks) without importing that branch.
// - LedgerPort mirrors EffectLedger prepare/dispatch lifecycle
//   (PREPARED -> DISPATCHING -> CONFIRMED | NOT_APPLIED; UNKNOWN on crash).
import { describe, expect, it } from 'vitest';
import {
  CheckpointDriftError,
  CrossRequesterError,
  RunnerProfileError,
  ScheduleDuplicateError,
  WorkflowRunner,
  type FixtureRecipe,
  type LedgerPort,
  type RunnerLease,
} from './runner.js';

const recipe = (overrides?: Partial<FixtureRecipe>): FixtureRecipe => ({
  recipeId: 'recipe-fixture-echo',
  canonicalAction: 'fixture.echo',
  effectClass: 'READ',
  expectedState: 'v1',
  expectedVersion: '1',
  ...overrides,
});

const memoryLease = (): {
  acquire: (resources: string[], owner: string) => RunnerLease;
  release: (resources: string[], owner: string, token: string) => void;
  assertUsable: (resource: string, fenceEpoch: number) => void;
} => {
  let epoch = 0;
  const held = new Map<string, { owner: string; token: string }>();
  return {
    acquire: (resources, owner) => {
      for (const resource of resources) {
        if (held.has(resource)) throw new Error(`held: ${resource}`);
      }
      epoch += 1;
      const token = `token-${epoch}`;
      for (const resource of resources) held.set(resource, { owner, token });
      return { resources: [...resources].sort(), owner, token, fenceEpoch: epoch };
    },
    release: (resources, owner, token) => {
      for (const resource of resources) {
        const current = held.get(resource);
        if (current?.owner !== owner || current?.token !== token) {
          throw new Error(`release refused: ${resource}`);
        }
      }
      for (const resource of resources) held.delete(resource);
    },
    assertUsable: (resource, fenceEpoch) => {
      if (fenceEpoch < epoch && held.has(resource)) {
        throw new Error(`stale fence: ${resource}`);
      }
    },
  };
};

const memoryLedger = (): LedgerPort => {
  let sequence = 0;
  const states = new Map<string, string>();
  return {
    prepare: (operationId, effectClass) => {
      sequence += 1;
      const effectId = `effect-${sequence}`;
      states.set(effectId, 'PREPARED');
      return { effectId, operationId, effectClass, state: 'PREPARED', attempts: 0 };
    },
    dispatch: async (effectId, transmit) => {
      if (states.get(effectId) !== 'PREPARED') throw new Error(`not PREPARED: ${effectId}`);
      states.set(effectId, 'DISPATCHING'); // durable-before-effect: commit before transmit
      const outcome = await transmit();
      states.set(effectId, outcome);
      return { effectId, operationId: 'op', effectClass: 'READ', state: outcome, attempts: 0 };
    },
  };
};

const runner = (): WorkflowRunner =>
  new WorkflowRunner({ profile: 'FIXTURE', leases: memoryLease(), ledger: memoryLedger() });

describe('WorkflowRunner create', () => {
  it('creates a FIXTURE task and returns a checkpoint', () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    expect(task.taskId.length).toBeGreaterThan(0);
    expect(task.state).toBe('CREATED');
    expect(task.checkpointDigest.length).toBeGreaterThan(0);
  });

  it('refuses non-FIXTURE profiles at construction', () => {
    expect(
      () => new WorkflowRunner({ profile: 'WRITE_APPROVED', leases: memoryLease(), ledger: memoryLedger() }),
    ).toThrow(RunnerProfileError);
  });
});

describe('WorkflowRunner execute', () => {
  it('drives create -> execute -> receipt for the owning requester', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    const receipt = await engine.execute(task.taskId, 'requester-a');
    expect(receipt.operationId).toBe(task.taskId);
    expect(receipt.effectClass).toBe('READ');
    expect(receipt.policyDecision).toBe('ALLOW');
    expect(engine.getTask(task.taskId).state).toBe('SUCCEEDED');
  });

  it('refuses execute from a different requester (cross-requester refusal)', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    await expect(engine.execute(task.taskId, 'requester-b')).rejects.toThrow(CrossRequesterError);
  });
});

describe('WorkflowRunner resume', () => {
  it('resumes with a matching checkpoint', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    const resumed = await engine.resume(task.taskId, 'requester-a', {
      checkpointDigest: task.checkpointDigest,
    });
    expect(resumed.taskId).toBe(task.taskId);
  });

  it('rejects resume with a drifted checkpoint digest', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    await expect(
      engine.resume(task.taskId, 'requester-a', { checkpointDigest: 'digest-drifted' }),
    ).rejects.toThrow(CheckpointDriftError);
  });

  it('refuses resume from a different requester', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    await expect(
      engine.resume(task.taskId, 'requester-b', { checkpointDigest: task.checkpointDigest }),
    ).rejects.toThrow(CrossRequesterError);
  });
});

describe('WorkflowRunner schedule entries (same engine, no second scheduler)', () => {
  it('consumes a schedule entry through execute and refuses duplicates', async () => {
    const engine = runner();
    const task = engine.createTask(recipe(), 'requester-a');
    const first = await engine.consumeScheduleEntry(
      { scheduleEntryId: 'sched-1', taskId: task.taskId },
      'requester-a',
    );
    expect(first.policyDecision).toBe('ALLOW');
    await expect(
      engine.consumeScheduleEntry({ scheduleEntryId: 'sched-1', taskId: task.taskId }, 'requester-a'),
    ).rejects.toThrow(ScheduleDuplicateError);
  });

  it('exposes no timer-based scheduling surface', () => {
    const engine = runner();
    expect('setInterval' in engine).toBe(false);
    expect('schedule' in engine).toBe(false);
    expect('start' in engine).toBe(false);
  });
});
