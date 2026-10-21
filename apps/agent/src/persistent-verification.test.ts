import { describe, expect, it } from 'vitest';
import { CompletionEvaluator } from '@gram/verification';
import { PersistentVerificationCompletion } from './persistence-adapters.js';

const head = 'a'.repeat(40);
const taskId = '018f0000-0000-7000-8000-000000000158';
const plan = { id: 9, taskId, headSha: head, approvedPaths: ['src/a.ts'], checks: [], snapshot: { version: 1 as const, taskId, headSha: head, entries: [] } };

describe('production persistent verification reader', () => {
  it('does not treat a legacy task-only PASS as bound evidence', () => {
    const adapter = new PersistentVerificationCompletion(new CompletionEvaluator({ listForTask: () => [{ required: true, status: 'PASS', hasEvidence: true }] }));
    expect(adapter.requiredChecksPassed(taskId, head)).toBe(false);
    expect(adapter.requiredChecksPassed(taskId)).toBe(false);
  });
  it('returns paths and success from only a sealed exact-HEAD plan', () => {
    const adapter = new PersistentVerificationCompletion(new CompletionEvaluator({ listForTask: () => [] }), {
      getBoundPlan: (task, sha) => task === taskId && sha === head ? plan : undefined,
    });
    expect(adapter.getVerifiedPlan(taskId, head)).toEqual(plan);
    expect(adapter.requiredChecksPassed(taskId, head)).toBe(true);
    expect(adapter.listApprovedPaths(taskId, head)).toEqual(['src/a.ts']);
    expect(adapter.requiredChecksPassed(taskId, 'b'.repeat(40))).toBe(false);
    expect(adapter.listApprovedPaths(taskId, 'b'.repeat(40))).toEqual([]);
  });
});
