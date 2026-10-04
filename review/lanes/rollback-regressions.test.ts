import { describe, expect, it } from 'vitest';
import { resolveRollbackTarget } from '../../packages/macos-lifecycle/src/rollback-contracts.js';
import { rollbackToTarget } from '../../packages/macos-lifecycle/src/rollback-service.js';
import { makeRollbackFixture } from '../../packages/macos-lifecycle/src/test-support/installer-rollback/fixture.js';

/** B2 lane regression: rollback-target gating must hold from the lane surface.
 * Guards the reviewed-target invariant (arbitrary digests never restore),
 * the stopped schema gate (unknown/unreadable closure blocks), and the
 * stopped lab delivery (both jobs stopped, DB bytes preserved, no start).
 */
describe('rollback-target lane regressions', () => {
  it('arbitrary digests never reach restore', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected installed digest');
    const foreign = prior.digest === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    expect(resolveRollbackTarget(foreign, prior).ok).toBe(false);
    const beforeSnap = f.snapshotBytes();
    const res = await rollbackToTarget(foreign, f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
  });

  it('unknown schema blocks even the reviewed target', async () => {
    const f = makeRollbackFixture({ closedSchema: 'unknown' });
    const digest = await f.installedDigest();
    const beforeDb = f.databaseBytes();
    const res = await rollbackToTarget(digest, f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('reviewed rollback parks both jobs stopped with DB preserved', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const digest = await f.installedDigest();
    const beforeDb = f.databaseBytes();
    const res = await rollbackToTarget(digest, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect(await f.ports.services().isStopped('core')).toBe(true);
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations.filter((m) => m.startsWith('start:'))).toEqual([]);
  });
});
