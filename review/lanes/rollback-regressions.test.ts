import { describe, expect, it } from 'vitest';
import { resolveRollbackTarget } from '../../packages/macos-lifecycle/src/rollback-contracts.js';
import { rollbackToReviewedTarget } from '../../packages/macos-lifecycle/src/rollback-service.js';
import { makeRollbackFixture } from '../../packages/macos-lifecycle/src/test-support/installer-rollback/fixture.js';

/** B2 lane regression (T8 repair): reviewed-target gating must hold from the
 * lane surface. Guards the retained release.json binding (bare prior and
 * arbitrary digests never restore), the closed-database gate, the
 * target-owned schema gate (unknown/unreadable closure blocks), the actual
 * retained-bytes restore with reread verification, and the stopped lab
 * delivery (both jobs stopped, DB bytes preserved, no start).
 */
describe('rollback-target lane regressions', () => {
  it('bare prior and arbitrary digests never reach restore', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[1]] });
    const prior = await f.installedDigest();
    expect(resolveRollbackTarget(prior).ok).toBe(true);
    const beforeSnap = f.snapshotBytes();
    const beforeLive = f.liveReleaseBytes();
    expect(await rollbackToReviewedTarget(prior, f.rollbackPorts))
      .toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    const foreign = f.retainedDigest() === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    expect(resolveRollbackTarget(foreign).ok).toBe(true);
    expect(await rollbackToReviewedTarget(foreign, f.rollbackPorts))
      .toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
    expect((f.liveReleaseBytes() as Buffer).equals(beforeLive as Buffer)).toBe(true);
  });

  it('unknown schema blocks even the retained target', async () => {
    const f = makeRollbackFixture({ closedSchema: 'unknown' });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('retained rollback restores exact bytes and parks both jobs stopped', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[1]] });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect((f.liveReleaseBytes() as Buffer).equals(f.retainedBytes() as Buffer)).toBe(true);
    const live = await f.rollbackPorts.rereadLiveRelease();
    expect(live.digest).toBe(f.retainedDigest());
    expect(await f.rollbackPorts.services().isStopped('core')).toBe(true);
    expect(await f.rollbackPorts.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations.filter((m) => m.startsWith('start:'))).toEqual([]);
  });
});
