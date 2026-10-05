import { describe, expect, it } from 'vitest';
import { confirmDatabaseClosed, resolveRollbackTarget } from './rollback-contracts.js';
import { rollbackToReviewedTarget } from './rollback-service.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

describe('resolveRollbackTarget (reviewed-target binding, no prior rule)', () => {
  it('rejects malformed digests without a prior', () => {
    for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), null, undefined, 42]) {
      expect(resolveRollbackTarget(bad)).toEqual(
        expect.objectContaining({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' }),
      );
    }
  });

  it('accepts a well-formed retained release digest', () => {
    const f = makeRollbackFixture();
    expect(resolveRollbackTarget(f.retainedDigest())).toEqual({
      ok: true, target: { digest: f.retainedDigest() },
    });
  });
});

describe('confirmDatabaseClosed', () => {
  it('holds when the database is closed', async () => {
    const f = makeRollbackFixture();
    await expect(confirmDatabaseClosed(f.rollbackPorts)).resolves.toBe(true);
  });

  it('fails when the database is still open, and never throws', async () => {
    const f = makeRollbackFixture({ dbOpen: true });
    await expect(confirmDatabaseClosed(f.rollbackPorts)).resolves.toBe(false);
    const broken = { confirmDatabaseClosed: async (): Promise<boolean> => { throw new Error('io'); } };
    await expect(confirmDatabaseClosed(broken)).resolves.toBe(false);
  });
});

describe('rollbackToReviewedTarget', () => {
  it('rejects malformed targets before auth, lock, or services', async () => {
    const f = makeRollbackFixture();
    const res = await rollbackToReviewedTarget('not-a-digest', f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.calls).toEqual([]);
    expect(f.serviceMutations).toEqual([]);
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

  it('refuses a bare prior digest with no retained binding as foreign', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const res = await rollbackToReviewedTarget(await f.installedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('refuses an unknown retained digest without stopping services', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const foreign = f.retainedDigest() === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    const res = await rollbackToReviewedTarget(foreign, f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('blocks when the database is still open, without restoring', async () => {
    const f = makeRollbackFixture({ dbOpen: true, closedSchema: [1], acceptedSets: [[1]] });
    const before = f.liveReleaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect((f.liveReleaseBytes() as Buffer).equals(before as Buffer)).toBe(true);
    expect(f.calls).not.toContain('restore');
  });

  it('blocks on unknown schema and preserves DB bytes', async () => {
    const f = makeRollbackFixture({ closedSchema: 'unknown' });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.calls).not.toContain('restore');
  });

  it('uses the target-owned accepted schema, not a global set', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[9]] });
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.calls).not.toContain('restore');
  });

  it('restores the actual retained bytes and verifies by reread', async () => {
    const f = makeRollbackFixture({ closedSchema: [1] });
    expect((f.liveReleaseBytes() as Buffer).equals(f.retainedBytes() as Buffer)).toBe(false);
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect((f.liveReleaseBytes() as Buffer).equals(f.retainedBytes() as Buffer)).toBe(true);
    const live = await f.rollbackPorts.rereadLiveRelease();
    expect(live.digest).toBe(f.retainedDigest());
    const journal = await f.rollbackPorts.journal().read();
    expect(JSON.parse((journal as Buffer).toString('utf8')))
      .toMatchObject({ stage: 'STOPPED', nextDigest: f.retainedDigest() });
  });

  it('keeps both releases stopped with DB preserved, tunnel before core', async () => {
    const f = makeRollbackFixture({ closedSchema: [1] });
    const beforeDb = f.databaseBytes();
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res.ok).toBe(true);
    expect(await f.rollbackPorts.services().isStopped('core')).toBe(true);
    expect(await f.rollbackPorts.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations.filter((m) => m.startsWith('start:'))).toEqual([]);
    expect(f.calls.indexOf('stop:tunnel')).toBeLessThan(f.calls.indexOf('stop:core'));
  });

  it('follows authorize, lock, identity, stop, db, schema, restore, verify, journal order', async () => {
    const f = makeRollbackFixture({ closedSchema: [1] });
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res.ok).toBe(true);
    expect(f.calls).toEqual([
      'authorize', 'lock', 'readCurrent', 'readRetained',
      'stop:tunnel', 'stop:core', 'confirmDb', 'readSchema',
      'restore', 'verify', 'journal',
    ]);
  });

  it('never reports OK when restore leaves unrestored bytes', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], restoreCorrupt: true });
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect((f.liveReleaseBytes() as Buffer).equals(f.retainedBytes() as Buffer)).toBe(false);
  });

  it('stays idempotent when live already equals the retained target', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], liveRelease: 'retained' });
    const res = await rollbackToReviewedTarget(f.retainedDigest(), f.rollbackPorts);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect((f.liveReleaseBytes() as Buffer).equals(f.retainedBytes() as Buffer)).toBe(true);
  });
});
