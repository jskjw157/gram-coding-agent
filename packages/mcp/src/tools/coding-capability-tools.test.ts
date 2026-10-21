import { describe, expect, it } from 'vitest';
import { CodingSubmitInput, CodingReadInput, CodingGetInput } from './coding-capability-tools.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';
const stepId = '018d8a73-6b4e-7000-8000-000000000002';
describe('external coding schemas', () => {
  it('binds every operation to exact task and step and rejects extra authority', () => {
    expect(CodingGetInput.safeParse({ taskId }).success).toBe(true);
    expect(CodingGetInput.safeParse({ taskId, cwd: '/tmp' }).success).toBe(false);
    expect(CodingReadInput.safeParse({ taskId, stepId, path: 'src/a.ts' }).success).toBe(true);
    expect(CodingReadInput.safeParse({ taskId, path: 'src/a.ts' }).success).toBe(false);
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'INSTRUCTIONS', digest: 'a'.repeat(64) }).success).toBe(true);
  });
  it('rejects empty no-op mutations, traversal and arbitrary fields', () => {
    const patch = { path: 'src/a.ts', expectedSha256: 'a'.repeat(64), content: 'new source' };
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'MODIFY', patches: [patch] }).success).toBe(true);
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'MODIFY', patches: [] }).success).toBe(false);
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'MODIFY', patches: [{ ...patch, path: '../outside' }] }).success).toBe(false);
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'ANALYZE', summary: '', files: [] }).success).toBe(false);
    expect(CodingSubmitInput.safeParse({ taskId, stepId, phase: 'ANALYZE', summary: 'change', files: ['a'], command: 'sh' }).success).toBe(false);
  });
});
