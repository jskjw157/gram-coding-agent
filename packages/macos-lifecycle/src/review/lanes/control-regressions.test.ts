import { describe, expect, it } from 'vitest';
import { control } from '../../local-control.js';
import { makeInstallFixture } from '../../test-support/installer/fixture.js';
import {
  resetExecutionCalls,
  serviceMutationsOf,
  withCorruptJournal,
  withMalformedConfig,
  withMismatchedJournal,
  withResetExecutionSpy,
  withStoppedFailureCapability,
  withoutStoppedFailureCapability,
  withTruthyAuthorize,
} from '../../test-support/installer-control/index.js';

// Regression tests for issue #148 (failing-first RED capture on base 463ca94).
// Expected fixed behavior: config/journal validation precedes ANY service
// mutation; reset-failure requires the narrow capability; authorize is
// strict-boolean; fail() returns exactly {ok:false,code} with no extra keys.

describe('control regressions (#148)', () => {
  it('(a) start with malformed prior.config fails with zero service mutations', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withMalformedConfig(f);
    const res = await control('start', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Fixed behavior: config parse precedes services.start('core').
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(b) restart with malformed prior.config fails with zero service mutations', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withMalformedConfig(f);
    const res = await control('restart', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Fixed behavior: neither stop nor start may run before config validates.
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(c) start with corrupt journal fails with zero service mutations', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withCorruptJournal(f);
    const res = await control('start', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Fixed behavior: journal validation precedes services.start('core').
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(d) start with mismatched journal fails with zero service mutations', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withMismatchedJournal(f);
    const res = await control('start', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Fixed behavior: digest-mismatched journal blocks start before mutation.
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(e) reset-failure without stopped-failure capability fails and never resets', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const spy = withResetExecutionSpy(f);
    withoutStoppedFailureCapability(f);
    const res = await control('reset-failure', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Fixed behavior: no narrow capability => no resetExecutionRecords fallback.
    expect(resetExecutionCalls(spy)).toBe(0);
  });

  it('(f) truthy (non-true) authorize is NOT_AUTHORIZED with zero mutations', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    withTruthyAuthorize(f);
    const res = await control('start', f.ports);
    expect(res).toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(g) uninstall with removeManifestOwned=false fails and preserves live core [pin: 463ca94 already fixed R3]', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const restore = f.ports.restore.bind(f.ports);
    f.ports.restore = () => {
      const base = restore();
      return { ...base, removeManifestOwned: async () => false };
    };
    const res = await control('uninstall', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    // Denial/uncertainty preserves foreign files as bounded failure (R3).
    expect(await f.ports.publish().readLive('core')).not.toBeNull();
  });

  it('(h) every non-success result is exactly {ok:false,code} with no extra keys', async () => {    const malformed = makeInstallFixture({ existingInstall: true });
    withMalformedConfig(malformed);
    const r1 = await control('start', malformed.ports);
    expect(r1.ok).toBe(false);
    expect(Object.keys(r1).sort()).toEqual(['code', 'ok']);

    const noCap = makeInstallFixture({ existingInstall: true });
    const spy = withResetExecutionSpy(noCap);
    withoutStoppedFailureCapability(noCap);
    const r2 = await control('reset-failure', noCap.ports);
    expect(r2.ok).toBe(false);
    expect(Object.keys(r2).sort()).toEqual(['code', 'ok']);
    expect(resetExecutionCalls(spy)).toBe(0);

    const truthy = makeInstallFixture({ existingInstall: true });
    withTruthyAuthorize(truthy);
    const r3 = await control('start', truthy.ports);
    expect(r3.ok).toBe(false);
    expect(Object.keys(r3).sort()).toEqual(['code', 'ok']);
    expect(serviceMutationsOf(truthy)).toEqual([]);
  });

  it('(i) service failure with extra/raw fields is sanitized to exact {ok,code}', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const svc = f.ports.services.bind(f.ports);
    f.ports.services = () => {
      const base = svc();
      return {
        ...base,
        stop: (async () => ({
          ok: false, code: 'PARTIAL_INSTALL', stage: 'STARTED', raw: 'leak',
        })) as unknown as typeof base.stop,
      };
    };
    const res = await control('stop', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
    expect(res).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
  });

  it('(j) tunnel unhealthy after own start stops tunnel AND core (owned-process proof)', async () => {
    const f = makeInstallFixture({ existingInstall: true, tunnelEnabled: true });
    const svc = f.ports.services.bind(f.ports);
    f.ports.services = () => {
      const base = svc();
      return {
        ...base,
        ownedHealthy: async (role: 'core' | 'tunnel'): Promise<boolean> =>
          role === 'tunnel' ? false : base.ownedHealthy(role),
      };
    };
    const res = await control('start', f.ports);
    expect(res).toEqual({ ok: false, code: 'HEALTH_UNKNOWN' });
    const mutations = serviceMutationsOf(f);
    expect(mutations).toContain('start:core');
    expect(mutations).toContain('start:tunnel');
    // Tunnel was started by us: compensation must stop it (owned proof),
    // then core. Current code stops core only (RED).
    expect(mutations).toContain('stop:tunnel');
    expect(mutations).toContain('stop:core');
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
    expect(await f.ports.services().isStopped('core')).toBe(true);
  });

  it('(k) throw after own start still compensates (exception-path cleanup)', async () => {
    const f = makeInstallFixture({ existingInstall: true, tunnelEnabled: true });
    const svc = f.ports.services.bind(f.ports);
    f.ports.services = () => {
      const base = svc();
      return {
        ...base,
        start: (async (role: 'core' | 'tunnel') => {
          if (role === 'tunnel') throw new Error('BOOT_FAIL');
          return base.start(role);
        }) as unknown as typeof base.start,
      };
    };
    const res = await control('start', f.ports);
    expect(res).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    const mutations = serviceMutationsOf(f);
    expect(mutations).toContain('start:core');
    // Core was started by us before the throw: must be compensated.
    expect(mutations).toContain('stop:core');
    expect(await f.ports.services().isStopped('core')).toBe(true);
  });

  it('(l) foreign/residual start has zero service mutations', async () => {
    const f = makeInstallFixture({ foreignPrior: true });
    const res = await control('start', f.ports);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(serviceMutationsOf(f)).toEqual([]);
  });

  it('(m) truthy non-true reset ok is failure (strict boolean)', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const restore = f.ports.restore.bind(f.ports);
    f.ports.restore = () => {
      const base = restore();
      return {
        ...base,
        resetStoppedFailure: (async () => ({
          ok: 'yes', code: 'OK',
        })) as unknown as NonNullable<typeof base.resetStoppedFailure>,
      };
    };
    const res = await control('reset-failure', f.ports);
    expect(res.ok).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
  });

  it('(n) stopped-failure reset preserves HELD/revision/DB/history (not wiped)', async () => {
    const f = makeInstallFixture({ existingInstall: true, execution: 'held' });
    const spy = withStoppedFailureCapability(f);
    const beforeDb = f.databaseBytes();
    const beforeSnap = f.snapshotBytes();
    const priorBefore = await f.ports.readPrior();
    const journalBefore = await f.ports.journal().read();
    const res = await control('reset-failure', f.ports);
    expect(res).toEqual({ ok: true, code: 'OK' });
    expect(resetExecutionCalls(spy)).toBe(1);
    // Recovery evidence, not a wipe: DB/history bytes, manifest/config/
    // journal lives, and the install revision (digest) are preserved.
    expect(f.databaseBytes().equals(beforeDb)).toBe(true);
    expect(f.snapshotBytes().equals(beforeSnap)).toBe(true);
    const priorAfter = await f.ports.readPrior();
    expect(priorAfter.digest).toBe(priorBefore.digest);
    expect(priorAfter.manifest?.equals(priorBefore.manifest ?? Buffer.alloc(0))).toBe(true);
    expect((await f.ports.journal().read())?.equals(journalBefore ?? Buffer.alloc(0))).toBe(true);
    // Jobs left stopped (lab disabled snapshot), verified via owned handles.
    expect(await f.ports.services().isStopped('core')).toBe(true);
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
  });
});
