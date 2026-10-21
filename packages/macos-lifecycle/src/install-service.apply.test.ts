import { describe, expect, it } from 'vitest';
import { apply } from './install-service.js';
import { makeInstallFixture } from './test-support/installer/fixture.js';
import {
  deferAuthorize,
  failLockRelease,
  throwOnAuthorize,
  throwOnLock,
  throwOnRevalidate,
} from './test-support/installer-apply/apply-ports.js';
import { makeTunnelDisableScenario } from './test-support/installer-apply/tunnel-disable.js';

/** B1 lane (#146): apply-transaction regressions (R5/R6/R8 + completion
 * state + interruption matrix). Rollback describes stay in
 * install-service.test.ts and are untouched here.
 */
describe('install-service apply transaction (B1 lane)', () => {
  it('snapshots preview token before first await despite mid-flight mutation', async () => {
    const f = makeInstallFixture();
    const deferred = deferAuthorize(f.ports);
    const pending = apply(f.preview, f.config, deferred.ports);
    // Caller mutates the reviewed preview while authorization is pending.
    f.preview.configDigest = 'f'.repeat(64);
    deferred.release(true);
    const res = await pending;
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
  });

  it('snapshots prior digest before first await despite mid-flight mutation', async () => {
    const f = makeInstallFixture();
    const deferred = deferAuthorize(f.ports);
    const pending = apply(f.preview, f.config, deferred.ports);
    f.preview.previousInstallDigest = 'e'.repeat(64);
    deferred.release(true);
    const res = await pending;
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
  });

  it('R5: lock release rejection downgrades committed success to PARTIAL_INSTALL', async () => {
    const f = makeInstallFixture();
    const res = await apply(f.preview, f.config, failLockRelease(f.ports));
    expect(res).toEqual({ ok: false, code: 'PARTIAL_INSTALL', stage: 'COMMITTED' });
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'COMMITTED' });
  });

  it('R8: authorize/lock/revalidate outer exceptions become closed codes', async () => {
    const auth = makeInstallFixture();
    expect(await apply(auth.preview, auth.config, throwOnAuthorize(auth.ports)))
      .toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    const lock = makeInstallFixture();
    expect(await apply(lock.preview, lock.config, throwOnLock(lock.ports)))
      .toEqual(expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }));
    const revalidate = makeInstallFixture();
    expect(await apply(revalidate.preview, revalidate.config, throwOnRevalidate(revalidate.ports)))
      .toEqual(expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }));
  });

  it('stale preview token changes no service or file state', async () => {
    const f = makeInstallFixture();
    const before = f.snapshotBytes();
    const stale = { ...f.preview, configDigest: 'd'.repeat(64) };
    const res = await apply(stale, f.config, f.ports);
    expect(res).toEqual({ ok: false, code: 'CONFIG_CHANGED' });
    expect(f.serviceMutations).toEqual([]);
    expect(f.snapshotBytes().equals(before)).toBe(true);
  });

  it('health failure compensates started core and keeps PUBLISHED evidence', async () => {
    const f = makeInstallFixture({ healthFailure: true });
    const beforeDb = f.databaseBytes();
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual({ ok: false, code: 'HEALTH_UNKNOWN', stage: 'PUBLISHED' });
    expect(f.serviceMutations).toContain('start:core');
    expect(f.serviceMutations.filter((m) => m === 'stop:core').length).toBeGreaterThanOrEqual(2);
    expect(await f.ports.services().isStopped('core')).toBe(true);
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'PUBLISHED' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('tunnel disable removes only the manifest-owned stale plist', async () => {
    const s = await makeTunnelDisableScenario(false);
    const beforeDb = s.databaseBytes();
    const res = await apply(s.preview, s.config, s.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    const prior = await s.ports.readPrior();
    expect(prior.tunnelPlist).toBeNull();
    const liveTunnel = await s.ports.publish().readLive('tunnel');
    expect(liveTunnel).toBeNull();
    expect(s.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('foreign tunnel plist blocks instead of committing a stale install', async () => {
    const s = await makeTunnelDisableScenario(true);
    const res = await apply(s.preview, s.config, s.ports);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'FOREIGN_SERVICE' }));
    const liveTunnel = await s.ports.publish().readLive('tunnel');
    if (liveTunnel === null) throw new Error('expected blocking without removal');
    expect(liveTunnel.equals(s.priorTunnelBytes)).toBe(true);
  });

  it('interrupt after manifest publish keeps FILES_STAGED evidence and DB bytes', async () => {
    const f = makeInstallFixture({ interruptAt: 'publish:manifest:after' });
    const beforeDb = f.databaseBytes();
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }));
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'FILES_STAGED' });
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
  });

  it('interrupt after STARTED write blocks retry-shaped success', async () => {
    const f = makeInstallFixture({ interruptAt: 'STARTED:after' });
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }));
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'STARTED' });
  });

  it('concurrent applies commit exactly once', async () => {
    const f = makeInstallFixture();
    const [first, second] = await Promise.all([
      apply(f.preview, f.config, f.ports),
      apply(f.preview, f.config, f.ports),
    ]);
    const committed = [first, second].filter((r) => r.ok);
    const refused = [first, second].filter((r) => !r.ok);
    expect(committed).toEqual([{ ok: true, code: 'OK', stage: 'COMMITTED' }]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.code).toBe('BUSY');
    const journal = await f.ports.journal().read();
    if (journal === null) throw new Error('expected journal');
    expect(JSON.parse(journal.toString('utf8'))).toMatchObject({ stage: 'COMMITTED' });
  });
});
