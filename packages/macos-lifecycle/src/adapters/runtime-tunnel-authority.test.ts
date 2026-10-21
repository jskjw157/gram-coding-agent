import { rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindReviewedCoreRuntimeAt, type ReviewedServiceRuntime } from './runtime-authority.js';
import type { CoreEvidence } from '../health-probe.js';
import type { TunnelCompatibility } from '../supervisor.js';
import type { TunnelAuthority } from './native-tunnel.js';
import { fixture } from '../test-support/runtime/fixture.js';

interface TunnelRuntime {
  authority: TunnelAuthority;
  compatibility: Readonly<TunnelCompatibility>;
}
type RuntimeWithTunnel = ReviewedServiceRuntime & { tunnelRuntime?: TunnelRuntime | null };

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup() {
  const f = await fixture({ tunnel: true }); roots.push(f.anchor);
  const runtime = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal()) as RuntimeWithTunnel | null;
  return { f, runtime };
}
function core(releaseDigest: string): CoreEvidence {
  return Object.freeze({ state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-g1', releaseDigest, observedAtMs: 1 });
}

describe('reviewed tunnel runtime authority', () => {
  it('binds reviewed compatibility without reading credentials or launching a child', async () => {
    const { f, runtime } = await setup();
    expect(runtime).not.toBeNull();
    expect(runtime?.tunnelRuntime?.compatibility).toEqual({ digest: 'b'.repeat(64) });
    expect(Object.isFrozen(runtime?.tunnelRuntime?.compatibility)).toBe(true);
    expect(await stat(join(f.release, 'bin/tunnel-client'))).toMatchObject({ size: expect.any(Number) });
  });

  it('requires the durable tunnel lease before granting executable custody', async () => {
    const { f, runtime } = await setup(); if (!runtime?.tunnelRuntime) throw new Error('missing tunnel runtime');
    expect(await runtime.tunnelRuntime.authority.acquire(f.review.config, runtime.tunnelRuntime.compatibility,
      core(f.review.config.releaseDigest), signal())).toBeNull();
    const lease = await runtime.execution.acquire('tunnel', 'tg1', f.review.configDigest, f.review.config.releaseDigest);
    const grant = await runtime.tunnelRuntime.authority.acquire(f.review.config, runtime.tunnelRuntime.compatibility,
      core(f.review.config.releaseDigest), signal());
    const tunnel = await stat(join(f.release, 'bin/tunnel-client'), { bigint: true });
    expect(grant).toMatchObject({
      configDigest: f.review.configDigest,
      compatibilityDigest: 'b'.repeat(64),
      executable: { dev: tunnel.dev, ino: tunnel.ino },
    });
    await runtime.execution.release(lease);
  });

  it('refuses mismatched compatibility, configuration or core release evidence', async () => {
    const { f, runtime } = await setup(); if (!runtime?.tunnelRuntime) throw new Error('missing tunnel runtime');
    await runtime.execution.acquire('tunnel', 'tg1', f.review.configDigest, f.review.config.releaseDigest);
    const authority = runtime.tunnelRuntime.authority;
    expect(await authority.acquire(f.review.config, { digest: 'c'.repeat(64) },
      core(f.review.config.releaseDigest), signal())).toBeNull();
    expect(await authority.acquire({ ...f.review.config, releaseId: 'other' }, runtime.tunnelRuntime.compatibility,
      core(f.review.config.releaseDigest), signal())).toBeNull();
    expect(await authority.acquire(f.review.config, runtime.tunnelRuntime.compatibility,
      core('c'.repeat(64)), signal())).toBeNull();
  });

  it('revalidates the reviewed tunnel binary for every launch grant', async () => {
    const { f, runtime } = await setup(); if (!runtime?.tunnelRuntime) throw new Error('missing tunnel runtime');
    await runtime.execution.acquire('tunnel', 'tg1', f.review.configDigest, f.review.config.releaseDigest);
    await writeFile(join(f.release, 'bin/tunnel-client'), 'changed-tunnel');
    expect(await runtime.tunnelRuntime.authority.acquire(f.review.config, runtime.tunnelRuntime.compatibility,
      core(f.review.config.releaseDigest), signal())).toBeNull();
  });

  it('refuses a tunnel-enabled installation with a missing tunnel execution record', async () => {
    const f = await fixture({ tunnel: true }); roots.push(f.anchor);
    await unlink(join(f.base, 'run/tunnel.execution.json'));
    expect(await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal())).toBeNull();
  });

  it('does not create tunnel authority for a core-only reviewed configuration', async () => {
    const f = await fixture(); roots.push(f.anchor);
    const runtime = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal()) as RuntimeWithTunnel | null;
    expect(runtime).not.toBeNull();
    expect(runtime?.tunnelRuntime ?? null).toBeNull();
  });
});
