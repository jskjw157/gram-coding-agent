import { describe, expect, it } from 'vitest';
import { rollbackToTarget } from './rollback-service.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

describe('RED: prior-digest-only target rule flaws (T8 repair)', () => {
  it('rejects a bare prior digest with no retained release.json binding', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const res = await rollbackToTarget(await f.installedDigest(), f.ports);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
  });

  it('never reports OK while retained bytes stay unrestored', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const live = f.liveReleaseBytes();
    const retained = f.retainedBytes();
    if (live === null || retained === null) throw new Error('expected two releases');
    expect(live.equals(retained)).toBe(false);
    const res = await rollbackToTarget(await f.installedDigest(), f.ports);
    expect(res.ok).toBe(true);
    expect((f.liveReleaseBytes() as Buffer).equals(retained)).toBe(true);
  });
});
