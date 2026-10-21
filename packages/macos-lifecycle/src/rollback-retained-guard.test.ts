import { describe, expect, it } from 'vitest';
import { rollbackToReviewedTarget } from './rollback-service.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

describe('retained-target guards (no prior-digest rule)', () => {
  it('refuses a bare prior digest with no retained release.json binding', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const res = await rollbackToReviewedTarget(await f.installedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('restores retained bytes instead of reporting OK unrestored', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const live = f.liveReleaseBytes();
    const retained = f.retainedBytes();
    if (live === null || retained === null) throw new Error('expected two releases');
    expect(live.equals(retained)).toBe(false);
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect((f.liveReleaseBytes() as Buffer).equals(retained)).toBe(true);
  });
});
