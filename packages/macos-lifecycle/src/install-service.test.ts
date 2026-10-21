import { describe, expect, it } from 'vitest';
import { apply, rollback } from './install-service.js';
import { canonicalConfigBytes, shaBytes, validateManifestBytes } from './adapters/install-files.js';
import { makeInstallFixture } from './test-support/installer/fixture.js';

describe('install-service apply', () => {
  it('fresh install commits byte-identical manifest + journal, preserves DB', async () => {
    const f = makeInstallFixture();
    const beforeSnap = f.snapshotBytes();
    const beforeDb = f.databaseBytes();
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    const prior = await f.ports.readPrior();
    expect(prior.digest).toMatch(/^[a-f0-9]{64}$/);
    const manifest = prior.manifest;
    const liveConfig = prior.config;
    if (manifest === null || liveConfig === null) throw new Error('expected live bytes');
    expect(validateManifestBytes(manifest)).toBe(true);
    // manifest binds config + plist bytes
    expect(liveConfig.equals(canonicalConfigBytes(f.config))).toBe(true);
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ schemaVersion: 1, stage: 'COMMITTED' });
    // live bytes changed, DB untouched (byte-level)
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(false);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    // service ordering: stop before start
    expect(f.serviceMutations[0]).toBe('stop:tunnel');
    expect(f.serviceMutations).toContain('start:core');
    // install digest binds all live files; journal binds manifest sha
    expect(JSON.parse(journal.toString('utf8')).installationDigest).toBe(shaBytes(manifest));
  });

  it('duplicate apply is no-op OK', async () => {
    const f = makeInstallFixture();
    const first = await apply(f.preview, f.config, f.ports);
    expect(first.ok).toBe(true);
    const snapAfterFirst = f.snapshotBytes();
    // Re-preview against committed digest -> duplicate
    const { previewTokenFor } = await import('./test-support/installer/fixture.js');
    const prior = await f.ports.readPrior();
    const dupPreview = { ...f.preview, previousInstallDigest: prior.digest, configDigest: previewTokenFor(f.config, prior.digest) };
    const second = await apply(dupPreview, f.config, f.ports);
    expect(second).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    expect(f.snapshotBytes().equals(snapAfterFirst)).toBe(true);
  });

  it('rejects tampered live bytes after preview', async () => {
    const f = makeInstallFixture({ changedAfterPreview: true });
    const res = await apply(f.preview, f.config, f.ports);
    expect(res.ok).toBe(false);
    expect(['CONFIG_CHANGED', 'FOREIGN_SERVICE']).toContain(res.code);
  });

  it('rejects foreign prior bytes', async () => {
    const f = makeInstallFixture({ foreignPrior: true });
    const res = await apply(f.preview, f.config, f.ports);
    expect(res.ok).toBe(false);
    expect(['FOREIGN_SERVICE', 'CONFIG_CHANGED']).toContain(res.code);
  });

  it('rejects partial prior manifest', async () => {
    const f = makeInstallFixture({ partialPrior: true });
    const res = await apply(f.preview, f.config, f.ports);
    expect(res.ok).toBe(false);
    expect(['FOREIGN_SERVICE', 'PARTIAL_INSTALL', 'CONFIG_CHANGED']).toContain(res.code);
  });

  it('interrupt during staging yields PARTIAL_INSTALL with journal evidence', async () => {
    const f = makeInstallFixture({ interruptAt: 'stage:core:before' });
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }));
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8')).stage).toBe('STOPPED');
  });

  it('auth denied and lock held', async () => {
    const denied = makeInstallFixture({ authDenied: true });
    expect(await apply(denied.preview, denied.config, denied.ports)).toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    const busy = makeInstallFixture({ lockHeld: true });
    expect(await apply(busy.preview, busy.config, busy.ports)).toEqual({ ok: false, code: 'BUSY' });
  });
});

describe('install-service rollback', () => {
  it('blocks on unknown schema, preserves DB bytes', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: 'unknown' });
    const beforeDb = f.databaseBytes();
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected digest');
    const res = await rollback(prior.digest, f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('verified stop on exact-set match, both releases stay stopped', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    const beforeDb = f.databaseBytes();
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected digest');
    const res = await rollback(prior.digest, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'STOPPED' });
    expect(await f.ports.services().isStopped('core')).toBe(true);
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.serviceMutations).toEqual(expect.arrayContaining(['stop:tunnel', 'stop:core']));
  });
});
