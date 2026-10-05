import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewedInstallerCliDeps, createReviewedStoppedFailureReset } from './a-integration.js';
import type { Preview } from './contracts.js';
import { bindReviewedCoreRuntimeAt, type ReviewedServiceRuntime } from './adapters/runtime-authority.js';
import { fixture as runtimeFixture } from './test-support/runtime/fixture.js';
import { makeInstallFixture } from './test-support/installer/fixture.js';
import { makeRollbackFixture } from './test-support/installer-rollback/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

const signal = (): AbortSignal => new AbortController().signal;
const digest = (char: string): string => char.repeat(64);

describe('A/WP-06 installer + lifecycle composition', () => {
  it('routes CLI rollback to the reviewed retained-target engine', async () => {
    const f = makeRollbackFixture({ closedSchema: [1], retainedAccepted: [[1]] });
    const preview: Preview = {
      ok: true,
      code: 'OK',
      configDigest: digest('a'),
      previousInstallDigest: digest('b'),
      releaseDigest: f.config.releaseDigest,
      roles: ['core'],
    };
    const output: string[] = [];
    const deps = createReviewedInstallerCliDeps({
      config: f.config,
      preview: async () => preview,
      diagnostic: async () => ({
        nowMs: 1,
        core: { status: null, currentIdentity: null },
        tunnel: { status: null, currentIdentity: null },
      }),
      installPorts: f.ports,
      rollbackPorts: f.rollbackPorts,
      output: (line) => { output.push(line); },
    });

    const target = f.retainedDigest();
    const result = await deps.rollback?.({
      config: 'service',
      expectedPreviewDigest: preview.configDigest,
      expectedInstallDigest: preview.previousInstallDigest,
      targetReleaseDigest: target,
    });

    expect(result).toEqual({ ok: true, code: 'OK' });
    expect(f.calls).toContain('readRetained');
    expect(f.calls).toContain('restore');
    expect(f.currentDigest()).toBe(target);
    expect(output).toEqual([]);
  });

  it('rejects stale CLI expected identity before any installer mutation', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const preview = f.preview;
    const deps = createReviewedInstallerCliDeps({
      config: f.config,
      preview: async () => preview,
      diagnostic: async () => ({
        nowMs: 1,
        core: { status: null, currentIdentity: null },
        tunnel: { status: null, currentIdentity: null },
      }),
      installPorts: f.ports,
      rollbackPorts: makeRollbackFixture().rollbackPorts,
      output: () => undefined,
    });

    const result = await deps.apply?.({
      config: 'service',
      expectedPreviewDigest: digest('f'),
      expectedInstallDigest: preview.previousInstallDigest,
    });

    expect(result).toEqual({ ok: false, code: 'CONFIG_CHANGED' });
    expect(f.serviceMutations).toEqual([]);
  });

  it('resets only stopped lifecycle failure history and preserves execution lease state', async () => {
    const f = await runtimeFixture();
    roots.push(f.anchor);
    const runtime = await bindReviewedCoreRuntimeAt(
      f.layout,
      f.review,
      f.acl,
      f.environment,
      signal(),
    ) as ReviewedServiceRuntime | null;
    if (runtime === null) throw new Error('reviewed runtime unavailable');

    let history = await runtime.stores.lifecycle.initializeNew('core', 0);
    for (let n = 1; n <= 5; n++) {
      history = await runtime.stores.lifecycle.write('core', history, {
        kind: 'begin',
        generation: `g${String(n)}`,
        nowMs: n * 10,
      });
      history = await runtime.stores.lifecycle.write('core', history, {
        kind: 'recover',
        nowMs: n * 10 + 1,
      });
    }
    expect(history.history.blocked).toBe(true);

    await runtime.execution.acquire(
      'core',
      'execution-owner',
      f.review.configDigest,
      f.review.config.releaseDigest,
    );
    const executionBefore = await runtime.execution.read('core');

    let broadResetCalls = 0;
    const install = makeInstallFixture({ existingInstall: true, execution: 'held' });
    const base = install.ports.restore();
    const guardedBase = {
      ...base,
      resetExecutionRecords: async () => {
        broadResetCalls += 1;
        return base.resetExecutionRecords();
      },
    };
    const resetPort = createReviewedStoppedFailureReset(guardedBase, {
      runtime,
      services: {
        isStopped: async () => true,
      },
      clock: () => 100,
    });

    expect(await resetPort.resetStoppedFailure?.()).toEqual({ ok: true, code: 'OK' });
    expect(broadResetCalls).toBe(0);
    const lifecycleAfter = await runtime.stores.lifecycle.read('core');
    expect(lifecycleAfter.history.blocked).toBe(false);
    expect(lifecycleAfter.history.exitsMs).toEqual([]);
    expect(lifecycleAfter.history.lastGeneration).toBe('g5');
    expect(await runtime.execution.read('core')).toEqual(executionBefore);
  });

  it('refuses lifecycle reset unless both jobs are confirmed stopped', async () => {
    const f = await runtimeFixture();
    roots.push(f.anchor);
    const runtime = await bindReviewedCoreRuntimeAt(
      f.layout,
      f.review,
      f.acl,
      f.environment,
      signal(),
    ) as ReviewedServiceRuntime | null;
    if (runtime === null) throw new Error('reviewed runtime unavailable');
    await runtime.stores.lifecycle.initializeNew('core', 0);

    const install = makeInstallFixture({ existingInstall: true });
    const resetPort = createReviewedStoppedFailureReset(install.ports.restore(), {
      runtime,
      services: {
        isStopped: async (role) => role !== 'core',
      },
      clock: () => 1,
    });

    expect(await resetPort.resetStoppedFailure?.()).toEqual({
      ok: false,
      code: 'PARTIAL_INSTALL',
    });
  });
});
