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

  it('(h) every non-success result is exactly {ok:false,code} with no extra keys', async () => {
    const malformed = makeInstallFixture({ existingInstall: true });
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
});
