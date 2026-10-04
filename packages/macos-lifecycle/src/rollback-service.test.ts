import { describe, expect, it } from 'vitest';
import { isRollbackDigest, resolveRollbackTarget } from './rollback-contracts.js';
import { rollbackToTarget } from './rollback-service.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

describe('rollback-contracts resolveRollbackTarget', () => {
  it('rejects malformed digests as schema-blocked', async () => {
    const f = makeRollbackFixture();
    const prior = await f.ports.readPrior();
    for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), null, undefined, 42]) {
      expect(resolveRollbackTarget(bad, prior)).toEqual(
        expect.objectContaining({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' }),
      );
    }
  });

  it('accepts only the reviewed installed digest', async () => {
    const f = makeRollbackFixture();
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected installed digest');
    expect(resolveRollbackTarget(prior.digest, prior)).toEqual({
      ok: true, target: { digest: prior.digest },
    });
    expect(isRollbackDigest(prior.digest)).toBe(true);
  });

  it('refuses arbitrary well-formed digests without mutation surface', async () => {
    const f = makeRollbackFixture();
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected installed digest');
    const foreign = prior.digest === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    expect(resolveRollbackTarget(foreign, prior)).toEqual(
      expect.objectContaining({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' }),
    );
  });

  it('reports absent prior as foreign service', async () => {
    const f = makeRollbackFixture({ installed: false });
    const prior = await f.ports.readPrior();
    expect(prior.digest).toBeNull();
    expect(resolveRollbackTarget('a'.repeat(64), prior)).toEqual(
      expect.objectContaining({ ok: false, code: 'FOREIGN_SERVICE' }),
    );
  });
});

describe('rollback-service rollbackToTarget', () => {
  it('rejects malformed target without touching services or bytes', async () => {
    const f = makeRollbackFixture();
    const beforeSnap = f.snapshotBytes();
    const res = await rollbackToTarget('not-a-digest', f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
  });

  it('refuses unreviewed target digest without mutation', async () => {
    const f = makeRollbackFixture();
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected installed digest');
    const foreign = prior.digest === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    const beforeSnap = f.snapshotBytes();
    const beforeDb = f.databaseBytes();
    const res = await rollbackToTarget(foreign, f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('refuses rollback with absent prior as foreign service', async () => {
    const f = makeRollbackFixture({ installed: false });
    const res = await rollbackToTarget('a'.repeat(64), f.ports);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('blocks on unknown schema, preserves DB bytes', async () => {
    const f = makeRollbackFixture({ closedSchema: 'unknown' });
    const beforeDb = f.databaseBytes();
    const digest = await f.installedDigest();
    const res = await rollbackToTarget(digest, f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('verified stop on exact-set match, both releases stay stopped', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const beforeDb = f.databaseBytes();
    const digest = await f.installedDigest();
    const res = await rollbackToTarget(digest, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect(await f.ports.services().isStopped('core')).toBe(true);
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations).toEqual(expect.arrayContaining(['stop:tunnel', 'stop:core']));
    expect(f.serviceMutations.filter((m) => m.startsWith('start:'))).toEqual([]);
  });

  it('restored target keeps valid manifest bytes, journal records the stop', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], acceptedSets: [[1]] });
    const before = await f.ports.readPrior();
    const digest = await f.installedDigest();
    const res = await rollbackToTarget(digest, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    const after = await f.ports.readPrior();
    if (after.manifest === null) throw new Error('expected manifest');
    const { validateManifestBytes } = await import('./adapters/install-files.js');
    expect(validateManifestBytes(after.manifest)).toBe(true);
    expect(after.config?.equals(before.config ?? Buffer.alloc(0))).toBe(true);
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'STOPPED' });
  });

  it('requires admin auth and a free lock', async () => {
    const denied = makeRollbackFixture();
    const digest = await denied.installedDigest();
    const deniedPorts = { ...denied.ports, authorizeLocalAdmin: async () => false };
    expect(await rollbackToTarget(digest, deniedPorts)).toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    const busy = makeRollbackFixture({ lockHeld: true });
    const busyDigest = await busy.installedDigest();
    expect(await rollbackToTarget(busyDigest, busy.ports)).toEqual({ ok: false, code: 'BUSY' });
  });
});
