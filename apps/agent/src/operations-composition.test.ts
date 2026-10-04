// operations-composition.test.ts — MAC-03 WP-12 RED: FIXTURE-profile composition
// wiring runner + artifacts + tools. Never auto-enables production.
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
  it('wires runner, artifacts, and tools under the FIXTURE profile', () => {
    const composed = composeFixtureOperations({
      profile: 'FIXTURE',
      runner: { kind: 'runner-fixture' },
      artifacts: { kind: 'artifacts-fixture' },
      tools: [{ name: 'fixture_task_create' }],
    });
    expect(composed.runner).toEqual({ kind: 'runner-fixture' });
    expect(composed.artifacts).toEqual({ kind: 'artifacts-fixture' });
    expect(composed.tools.map((tool) => tool.name)).toEqual(['fixture_task_create']);
    expect(composed.profile).toBe('FIXTURE');
  });

  it('refuses to compose any non-FIXTURE profile', () => {
    expect(() =>
      composeFixtureOperations({
        profile: 'DISABLED',
        runner: { kind: 'runner' },
        artifacts: { kind: 'artifacts' },
        tools: [],
      }),
    ).toThrow(ProductionProfileRefusedError);
    expect(() =>
      composeFixtureOperations({
        profile: 'WRITE_APPROVED',
        runner: { kind: 'runner' },
        artifacts: { kind: 'artifacts' },
        tools: [],
      }),
    ).toThrow(ProductionProfileRefusedError);
  });
});
