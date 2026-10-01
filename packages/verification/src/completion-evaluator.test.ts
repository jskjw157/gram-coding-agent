import { describe, expect, it } from 'vitest';
import {
  CompletionEvaluator,
  type VerificationCheckSnapshot,
} from './completion-evaluator.js';

function evaluator(checks: VerificationCheckSnapshot[]): CompletionEvaluator {
  return new CompletionEvaluator({
    listForTask() {
      return checks;
    },
  });
}

const TASK_ID = '018f0000-0000-7000-8000-000000000001';

function authorizesCompletion(passed: boolean): boolean {
  return passed;
}

function authorizesPublication(passed: boolean): boolean {
  return passed;
}

describe('CompletionEvaluator', () => {
  it('passes only when every required check has PASS evidence', () => {
    expect(
      evaluator([
        { required: true, status: 'PASS', hasEvidence: true },
        { required: true, status: 'PASS', hasEvidence: true },
      ]).requiredChecksPassed('018f0000-0000-7000-8000-000000000001'),
    ).toBe(true);
  });

  it.each(['FAIL', 'SKIPPED'] as const)(
    'blocks completion when a required check is %s',
    (status) => {
      expect(
        evaluator([
          { required: true, status: 'PASS', hasEvidence: true },
          { required: true, status, hasEvidence: true },
        ]).requiredChecksPassed('018f0000-0000-7000-8000-000000000001'),
      ).toBe(false);
    },
  );

  it('does not let a required PASS without evidence count as verified', () => {
    expect(
      evaluator([
        { required: true, status: 'PASS', hasEvidence: false },
      ]).requiredChecksPassed('018f0000-0000-7000-8000-000000000001'),
    ).toBe(false);
  });

  it('does not block on optional NOT_REQUIRED checks', () => {
    expect(
      evaluator([
        { required: true, status: 'PASS', hasEvidence: true },
        { required: false, status: 'NOT_REQUIRED', hasEvidence: false },
      ]).requiredChecksPassed('018f0000-0000-7000-8000-000000000001'),
    ).toBe(true);
  });

  it('rejects completion and publication when no verification plan exists', () => {
    const passed = evaluator([]).requiredChecksPassed(TASK_ID);
    expect(passed).toBe(false);
    expect(authorizesCompletion(passed)).toBe(false);
    expect(authorizesPublication(passed)).toBe(false);
  });

  it('rejects completion and publication when the plan has zero required checks', () => {
    const passed = evaluator([
      { required: false, status: 'NOT_REQUIRED', hasEvidence: false },
      { required: false, status: 'SKIPPED', hasEvidence: false },
    ]).requiredChecksPassed(TASK_ID);
    expect(passed).toBe(false);
    expect(authorizesCompletion(passed)).toBe(false);
    expect(authorizesPublication(passed)).toBe(false);
  });
});
