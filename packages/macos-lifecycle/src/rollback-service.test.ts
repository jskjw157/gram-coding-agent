import { describe, expect, it } from 'vitest';
import { confirmDatabaseClosed, isRollbackDigest, resolveRollbackTarget } from './rollback-contracts.js';
import { rollbackToReviewedTarget } from './rollback-service.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

describe('rollback-contracts resolveRollbackTarget', () => {
  it('rejects malformed digests as schema-blocked', async () => {
    for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), null, undefined, 42]) {
      expect(resolveRollbackTarget(bad)).toEqual(
        expect.objectContaining({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' }),
      );
    }
  });

  it('accepts the retained reviewed digest without a prior', async () => {
    const f = makeRollbackFixture();
    expect(resolveRollbackTarget(f.retainedDigest())).toEqual({
      ok: true, target: { digest: f.retainedDigest() },
    });
    expect(isRollbackDigest(f.retainedDigest())).toBe(true);
  });

  it('reports database closure honestly', async () => {
    const closed = makeRollbackFixture();
    await expect(confirmDatabaseClosed(closed.rollbackPorts)).resolves.toBe(true);
    const open = makeRollbackFixture({ dbOpen: true });
    await expect(confirmDatabaseClosed(open.rollbackPorts)).resolves.toBe(false);
  });
});

describe('rollback-service rollbackToReviewedTarget', () => {
  it('rejects malformed target without touching services or bytes', async () => {
    const f = makeRollbackFixture();
    const beforeSnap = f.snapshotBytes();
    const res = await rollbackToReviewedTarget('not-a-digest', f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.calls).toEqual([]);
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
  });

  it('refuses a retained-unknown digest as foreign without mutation', async () => {
    const f = makeRollbackFixture();
    const foreign = f.retainedDigest() === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    const beforeSnap = f.snapshotBytes();
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(foreign, f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('refuses rollback with absent retained release as foreign service', async () => {
    const f = makeRollbackFixture({ installed: false });
    const res = await rollbackToReviewedTarget('a'.repeat(64), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('blocks on unknown schema, preserves DB bytes', async () => {
    const f = makeRollbackFixture({ closedSchema: 'unknown' });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('verified stop on target-owned exact-set match, both releases stay stopped', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[1]] });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect(await f.rollbackPorts.services().isStopped('core')).toBe(true);
    expect(await f.rollbackPorts.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations).toEqual(expect.arrayContaining(['stop:tunnel', 'stop:core']));
    expect(f.serviceMutations.filter((m) => m.startsWith('start:'))).toEqual([]);
  });

  it('restored target matches retained release.json bytes, journal records the stop', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[1]] });
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    const live = await f.rollbackPorts.rereadLiveRelease();
    expect(live.digest).toBe(f.retainedDigest());
    expect((live.releaseJson as Buffer).equals(f.retainedBytes() as Buffer)).toBe(true);
    const journal = await f.rollbackPorts.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({
      stage: 'STOPPED', nextDigest: f.retainedDigest(),
    });
  });

  it('requires admin auth and a free lock', async () => {
    const denied = makeRollbackFixture();
    const deniedPorts = { ...denied.rollbackPorts, authorizeLocalAdmin: async (): Promise<boolean> => false };
    expect(await rollbackToReviewedTarget(denied.retainedDigest(), deniedPorts))
      .toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    const busy = makeRollbackFixture({ lockHeld: true });
    expect(await rollbackToReviewedTarget(busy.retainedDigest(), busy.rollbackPorts))
      .toEqual({ ok: false, code: 'BUSY' });
  });
});
