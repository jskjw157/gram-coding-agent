import { describe, expect, it } from 'vitest';
import { control } from './local-control.js';
import { makeInstallFixture } from './test-support/installer/fixture.js';
import { resetExecutionCalls, withResetExecutionSpy, withStoppedFailureCapability } from './test-support/installer-control/index.js';
import { validateManifestBytes } from './adapters/install-files.js';

describe('local-control', () => {
  it('stop on committed install is OK and verified stopped', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const res = await control('stop', f.ports);
    expect(res).toEqual({ ok: true, code: 'OK' });
    expect(await f.ports.services().isStopped('core')).toBe(true);
  });

  it('start on foreign bytes is FOREIGN_SERVICE', async () => {
    const f = makeInstallFixture({ foreignPrior: true });
    expect(await control('start', f.ports)).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
  });

  it('uninstall removes only manifest-owned plists, preserves manifest/config/journal + DB', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const beforeDb = f.databaseBytes();
    const priorBefore = await f.ports.readPrior();
    if (priorBefore.manifest === null) throw new Error('expected manifest');
    expect(validateManifestBytes(priorBefore.manifest)).toBe(true);
    const res = await control('uninstall', f.ports);
    expect(res).toEqual({ ok: true, code: 'OK' });
    const pub = f.ports.publish();
    expect(await pub.readLive('core')).toBeNull();
    // manifest/config/journal preserved (no purge)
    expect(await pub.readLive('manifest')).not.toBeNull();
    expect(await pub.readLive('configuration')).not.toBeNull();
    expect(await f.ports.journal().read()).not.toBeNull();
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    // second uninstall no-op OK
    expect(await control('uninstall', f.ports)).toEqual({ ok: true, code: 'OK' });
  });

  it('reset-failure requires stopped core', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withStoppedFailureCapability(f);
    const res = await control('reset-failure', f.ports);
    expect(res).toEqual({ ok: true, code: 'OK' });
  });

  it('reset-failure without capability leaves reset untouched', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const spy = withResetExecutionSpy(f);
    const res = await control('reset-failure', f.ports);
    expect(res.ok).toBe(false);
    expect(resetExecutionCalls(spy)).toBe(0);
  });

  it('rejects unknown action + auth/lock', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    // @ts-expect-error byte-level invalid action
    expect(await control('status', f.ports)).toEqual({ ok: false, code: 'INVALID_CONFIG' });
    const denied = makeInstallFixture({ authDenied: true });
    expect(await control('stop', denied.ports)).toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
  });
});
