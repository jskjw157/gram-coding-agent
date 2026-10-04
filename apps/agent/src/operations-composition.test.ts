// operations-composition.test.ts — T10 repair: FIXTURE-profile composition
// wiring the M2-backed dispatch + artifacts + tools. Never auto-enables
// production. The composed dispatch is the injected M2 delegation — this
// composition adds no execution path of its own.
import { describe, expect, it } from 'vitest';
import {
  ProductionProfileRefusedError,
  composeFixtureOperations,
  resolveOperationsProfile,
} from './operations-composition.js';

describe('resolveOperationsProfile', () => {
  it('enables FIXTURE only on explicit opt-in', () => {
    expect(resolveOperationsProfile({ GRAM_OPERATIONS_PROFILE: 'FIXTURE' })).toBe('FIXTURE');
  });

  it('defaults to DISABLED and never resolves production implicitly', () => {
    expect(resolveOperationsProfile({})).toBe('DISABLED');
    expect(resolveOperationsProfile({ GRAM_OPERATIONS_PROFILE: 'WRITE_APPROVED' })).toBe(
      'DISABLED',
    );
    expect(resolveOperationsProfile({ GRAM_OPERATIONS_PROFILE: 'production' })).toBe('DISABLED');
  });
});

describe('composeFixtureOperations', () => {
  it('wires the M2-backed dispatch, artifacts, and tools under the FIXTURE profile', async () => {
    const dispatch = {
      create: async (input: { repo: string; goal: string }): Promise<unknown> => ({
        taskId: 'task-1',
        repo: input.repo,
        goal: input.goal,
      }),
      run: async (taskId: string): Promise<unknown> => ({ operationId: taskId }),
    };
    const composed = composeFixtureOperations({
      profile: 'FIXTURE',
      dispatch,
      artifacts: { kind: 'artifacts-fixture' },
      tools: [{ name: 'fixture_task_create' }],
    });
    expect(composed.dispatch).toBe(dispatch);
    await expect(
      composed.dispatch.create({ repo: 'owner/repo', goal: 'goal-a' }),
    ).resolves.toMatchObject({ taskId: 'task-1' });
    expect(composed.artifacts).toEqual({ kind: 'artifacts-fixture' });
    expect(composed.tools.map((tool) => tool.name)).toEqual(['fixture_task_create']);
    expect(composed.profile).toBe('FIXTURE');
  });

  it('refuses to compose any non-FIXTURE profile', () => {
    const dispatch = {
      create: async (): Promise<unknown> => ({ taskId: 'task-1' }),
      run: async (): Promise<unknown> => ({ operationId: 'task-1' }),
    };
    expect(() =>
      composeFixtureOperations({
        profile: 'DISABLED',
        dispatch,
        artifacts: { kind: 'artifacts' },
        tools: [],
      }),
    ).toThrow(ProductionProfileRefusedError);
    expect(() =>
      composeFixtureOperations({
        profile: 'WRITE_APPROVED',
        dispatch,
        artifacts: { kind: 'artifacts' },
        tools: [],
      }),
    ).toThrow(ProductionProfileRefusedError);
  });
});
