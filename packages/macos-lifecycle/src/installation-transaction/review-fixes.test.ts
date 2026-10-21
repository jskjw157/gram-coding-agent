import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apply, rollback } from '../install-service.js';
import { control } from '../local-control.js';
import {
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  validateManifestBytes,
} from '../adapters/install-files.js';
import { inspectInstallation } from '../installation-inspection.js';
import { labConfig, makeInstallFixture } from '../test-support/installer/fixture.js';
import type { InstallPorts } from './contracts.js';

const sha = (v: Buffer | string): string => createHash('sha256').update(v).digest('hex');

describe('review R1: rollback refuses arbitrary digests without mutation', () => {
  it('arbitrary target digest returns BLOCKED and never stops services', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    const res = await rollback('a'.repeat(64), f.ports);
    expect(res).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' });
    expect(f.serviceMutations).toEqual([]);
  });
});

describe('review R2: schema reads only after confirmed stop', () => {
  it('readClosedSchema observes both services stopped', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    const inner = f.ports;
    const seen: Array<{ core: boolean; tunnel: boolean }> = [];
    const wrapped: InstallPorts = {
      ...inner,
      services: () => {
        const s = inner.services();
        return {
          ...s,
          stop: (role) => s.stop(role),
          isStopped: (role) => s.isStopped(role),
        };
      },
      readClosedSchema: async () => {
        const s = inner.services();
        seen.push({ core: await s.isStopped('core'), tunnel: await s.isStopped('tunnel') });
        return inner.readClosedSchema();
      },
    };
    const prior = await inner.readPrior();
    if (prior.digest === null) throw new Error('expected digest');
    const res = await rollback(prior.digest, wrapped);
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ core: true, tunnel: true }]);
  });
});

describe('review R3: uninstall honors removal denial', () => {
  it('removeManifestOwned=false yields FOREIGN_SERVICE', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const inner = f.ports;
    const wrapped: InstallPorts = {
      ...inner,
      restore: () => ({ ...inner.restore(), removeManifestOwned: async () => false }),
    };
    const res = await control('uninstall', wrapped);
    expect(res).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
  });
});

describe('review R4: manifest runtime domain validation', () => {
  it('rejects uid0, string uid, negative gid', async () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const corePlist = expectedPlistBytes(config, 'core');
    if (corePlist === null) throw new Error('expected core plist');
    const good = buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes, releaseId: config.releaseId, releaseDigest: config.releaseDigest,
      corePlist, tunnelPlist: expectedPlistBytes(config, 'tunnel'),
    });
    expect(validateManifestBytes(good.bytes)).toBe(true);
    const tamper = (mutate: (m: Record<string, unknown>) => void): boolean => {
      const parsed = JSON.parse(good.bytes.toString('utf8')) as Record<string, unknown>;
      mutate(parsed);
      return validateManifestBytes(Buffer.from(JSON.stringify(parsed), 'utf8'));
    };
    expect(tamper((m) => { (m.runtime as Record<string, unknown>).uid = 0; })).toBe(false);
    expect(tamper((m) => { (m.runtime as Record<string, unknown>).uid = '501'; })).toBe(false);
    expect(tamper((m) => { (m.runtime as Record<string, unknown>).gid = -1; })).toBe(false);
  });
});

describe('review R5: lock release rejection is never clean success', () => {
  it('apply COMMITTED with rejected release reports PARTIAL_INSTALL', async () => {
    const f = makeInstallFixture();
    const inner = f.ports;
    const wrapped: InstallPorts = {
      ...inner,
      lock: async () => ({ acquired: true, release: async () => { throw new Error('release lost'); } }),
    };
    const res = await apply(f.preview, f.config, wrapped);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PARTIAL_INSTALL');
  });
});

describe('review R6: LAB_ONLY stopped/disabled delivery + reader round-trip', () => {
  it('apply parks services stopped with disabled manifest', async () => {
    const f = makeInstallFixture();
    const res = await apply(f.preview, f.config, f.ports);
    expect(res).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    expect(await f.ports.services().isStopped('core')).toBe(true);
    expect(await f.ports.services().isStopped('tunnel')).toBe(true);
    const prior = await f.ports.readPrior();
    const manifest = JSON.parse((prior.manifest as Buffer).toString('utf8')) as {
      desiredEnabled: { core: boolean; tunnel: boolean };
    };
    expect(manifest.desiredEnabled).toEqual({ core: false, tunnel: false });
    // health was proven then parked: start observed before final stop
    expect(f.serviceMutations).toContain('start:core');
    expect(f.serviceMutations.slice(f.serviceMutations.lastIndexOf('start:core'))).toContain('stop:core');
  });

  it('committed output round-trips the unchanged stopped-install reader', async () => {
    const f = makeInstallFixture();
    const res = await apply(f.preview, f.config, f.ports);
    expect(res.ok).toBe(true);
    const live = {
      configuration: await f.ports.publish().readLive('configuration'),
      manifest: await f.ports.publish().readLive('manifest'),
      journal: await f.ports.publish().readLive('journal'),
      core: await f.ports.publish().readLive('core'),
      tunnel: await f.ports.publish().readLive('tunnel'),
    };
    const tunnelLive = live.tunnel !== null;
    const io = {
      presence: async (file: string): Promise<'absent' | 'file'> =>
        (live as Record<string, Buffer | null>)[file] === null ? 'absent' : 'file',
      read: async (file: string): Promise<Buffer> => {
        const v = (live as Record<string, Buffer | null>)[file];
        if (v === null) throw new Error('absent');
        return Buffer.from(v);
      },
      registry: async () => ({
        jobs: { core: 'absent', tunnel: 'absent' },
        overrides: { core: true, tunnel: tunnelLive ? true : null },
      }),
      verifyRelease: async () => true,
    };
    const evidence = await inspectInstallation(
      { name: 'gram-agent', uid: 501, gid: 501, admin: false, groupsComplete: true },
      io as never,
    );
    const prior = await f.ports.readPrior();
    expect(evidence.digest).toBe(prior.digest);
  });

  it('disabling tunnel removes the old manifest-owned tunnel plist', async () => {
    const f = makeInstallFixture({ existingInstall: true, tunnelEnabled: true });
    const prior = await f.ports.readPrior();
    if (prior.digest === null || prior.tunnelPlist === null) throw new Error('expected tunnel install');
    const { previewTokenFor } = await import('../test-support/installer/fixture.js');
    const nextConfig = labConfig();
    const preview = {
      ok: true as const, code: 'OK' as const,
      configDigest: previewTokenFor(nextConfig, prior.digest),
      previousInstallDigest: prior.digest,
      releaseDigest: nextConfig.releaseDigest,
      roles: ['core'] as Array<'core' | 'tunnel'>,
    };
    // Fixture revalidate() is bound to its creation config; rebind the
    // preview token to the reviewed next config like a real reviewer would.
    const inner = f.ports;
    const rebound: InstallPorts = {
      ...inner,
      revalidate: async () => {
        const r = await inner.revalidate();
        return { ...r, previewToken: previewTokenFor(nextConfig, r.priorDigest) };
      },
    };
    const res = await apply(preview, nextConfig, rebound);
    expect(res.ok).toBe(true);
    expect(await f.ports.publish().readLive('tunnel')).toBe(null);
  });
});

describe('review R7: digest derives from the real registry observation', () => {
  it('prior digest matches registry-object digest, not the legacy string', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const prior = await f.ports.readPrior();
    if (prior.digest === null || prior.manifest === null) throw new Error('expected digest');
    const manifest = prior.manifest;
    const config = prior.config as Buffer;
    const core = prior.corePlist as Buffer;
    const tunnel = prior.tunnelPlist;
    const journal = await f.ports.journal().read();
    const files: Array<[string, string | null]> = [
      ['configuration', sha(config)],
      ['manifest', sha(manifest)],
      ['journal', journal ? sha(journal) : null],
      ['core', sha(core)],
      ['tunnel', tunnel ? sha(tunnel) : null],
    ];
    const legacy = sha(Buffer.from(JSON.stringify({ files, registry: 'disabled-absent' }), 'utf8'));
    expect(prior.digest === legacy).toBe(false);
    const parsed = JSON.parse(manifest.toString('utf8')) as {
      plistSha256: { tunnel: string | null };
    };
    const registry = {
      jobs: { core: 'absent', tunnel: 'absent' },
      overrides: { core: true, tunnel: parsed.plistSha256.tunnel !== null ? true : null },
    };
    expect(prior.digest).toBe(sha(Buffer.from(JSON.stringify({ files, registry }), 'utf8')));
  });
});

describe('review R8: provider exceptions become fixed safe codes', () => {
  it('throwing authorizeLocalAdmin never escapes apply/rollback/control', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    const throwing: InstallPorts = {
      ...f.ports,
      authorizeLocalAdmin: async () => { throw new Error('boom'); },
    };
    await expect(apply(f.preview, f.config, throwing)).resolves.toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    await expect(rollback('b'.repeat(64), throwing)).resolves.toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    await expect(control('stop', throwing)).resolves.toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
  });
});

describe('review gaps: every journal/rename interruption is bounded PARTIAL', () => {
  it.each([
    'publish:configuration:before',
    'publish:core:before',
    'publish:manifest:before',
    'publish:journal:before',
    'PUBLISHED:before',
    'STARTED:after',
  ])('%s yields PARTIAL_INSTALL without throwing', async (point) => {
    const { makeInstallFixture: make } = await import('../test-support/installer/fixture.js');
    const f = make({ interruptAt: point });
    await expect(apply(f.preview, f.config, f.ports)).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'PARTIAL_INSTALL' }),
    );
  });
});

describe('review gaps: restart/reset validate prior identity', () => {
  it('restart and reset-failure refuse foreign prior', async () => {
    const f = makeInstallFixture({ foreignPrior: true });
    expect(await control('restart', f.ports)).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
    expect(await control('reset-failure', f.ports)).toEqual({ ok: false, code: 'FOREIGN_SERVICE' });
  });
});
