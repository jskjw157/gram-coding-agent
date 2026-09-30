import { describe, expect, it } from 'vitest';
import { BoundPublishingVerification } from './verified-publishing.js';

const taskId = '018f0000-0000-7000-8000-000000000158';
const headSha = 'a'.repeat(40);
const snapshot = { version: 1 as const, taskId, headSha, entries: [{ path: 'src/a.ts', mode: '100644' as const, oid: 'b'.repeat(40) }] };
const plan = { id: 17, taskId, headSha, snapshot, approvedPaths: ['src/a.ts'], checks: [] };

function fixture() {
  let current = structuredClone(snapshot);
  let available = true;
  const committed: string[] = [];
  const guard = new BoundPublishingVerification({
    taskId, planId: 17, headSha, paths: ['src/a.ts'],
    repository: { getBoundPlan: (id, head, planId) => {
      expect([id, head, planId]).toEqual([taskId, headSha, 17]);
      return available ? plan : undefined;
    } },
    snapshots: {
      capture: async (id) => { expect(id).toBe(taskId); return current; },
      assertCommitted: async (id, proof, paths, sha) => {
        expect([id, proof, paths]).toEqual([taskId, snapshot, ['src/a.ts']]); committed.push(sha);
      },
    },
  });
  return { guard, committed, drift: () => { current = { ...snapshot, entries: [{ path: 'src/a.ts', mode: '100644', oid: 'c'.repeat(40) }] }; }, supersede: () => { available = false; } };
}

describe('production bound publication evidence', () => {
  it('rejects same-HEAD file drift before commit', async () => {
    const { guard, drift } = fixture(); drift();
    await expect(guard.assertPassed(taskId)).rejects.toThrow(/snapshot/i);
  });
  it('rejects superseded plan before post-commit publication', async () => {
    const { guard, supersede, committed } = fixture();
    await guard.assertPassed(taskId); supersede();
    await expect(guard.assertCommitted(taskId, 'd'.repeat(40))).rejects.toThrow(/plan/i);
    expect(committed).toEqual([]);
  });
  it('binds both phases to the exact task and plan', async () => {
    const { guard, committed } = fixture();
    await expect(guard.assertPassed('other-task')).rejects.toThrow(/task/i);
    await guard.assertPassed(taskId); await guard.assertCommitted(taskId, 'd'.repeat(40));
    expect(committed).toEqual(['d'.repeat(40)]);
  });
});
