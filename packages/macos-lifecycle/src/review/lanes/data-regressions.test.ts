import { describe, expect, it } from 'vitest';
import {
  buildIntermediateJournal,
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  validateManifestBytes,
} from '../../adapters/install-files.js';
import { schemaCompatible } from '../../adapters/closed-schema.js';
import { decideProvisioning } from '../../installation-transaction/provisioning.js';
import { labConfig, makeInstallFixture } from '../../test-support/installer/fixture.js';

function goodManifest(): Buffer {
  const config = labConfig();
  const configBytes = canonicalConfigBytes(config);
  const corePlist = expectedPlistBytes(config, 'core');
  if (corePlist === null) throw new Error('expected core plist');
  return buildManifest({
    runtime: { name: 'gram-agent', uid: 501, gid: 501 },
    configBytes,
    releaseId: config.releaseId,
    releaseDigest: config.releaseDigest,
    corePlist,
    tunnelPlist: expectedPlistBytes(config, 'tunnel'),
  }).bytes;
}

function tamperedReleaseId(releaseId: string): boolean {
  const parsed = JSON.parse(goodManifest().toString('utf8')) as Record<string, unknown>;
  parsed.releaseId = releaseId;
  return validateManifestBytes(Buffer.from(JSON.stringify(parsed), 'utf8'));
}

describe('B4 R4: closed runtime/domain validation (#149)', () => {
  it('rejects empty, malformed, and oversize releaseId', () => {
    expect(tamperedReleaseId('')).toBe(false);
    expect(tamperedReleaseId('!!bad!!')).toBe(false);
    expect(tamperedReleaseId('a'.repeat(65))).toBe(false);
    expect(tamperedReleaseId('a'.repeat(64))).toBe(true);
  });

  it('buildManifest refuses releaseId/releaseDigest that do not match config bytes', () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const corePlist = expectedPlistBytes(config, 'core');
    if (corePlist === null) throw new Error('expected core plist');
    expect(() => buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes,
      releaseId: 'lab-999',
      releaseDigest: config.releaseDigest,
      corePlist,
      tunnelPlist: null,
    })).toThrow();
    expect(() => buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes,
      releaseId: config.releaseId,
      releaseDigest: 'b'.repeat(64),
      corePlist,
      tunnelPlist: null,
    })).toThrow();
  });

  it('buildManifest refuses plist bytes that are not the config render', () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const corePlist = expectedPlistBytes(config, 'core');
    if (corePlist === null) throw new Error('expected core plist');
    const tamperedCore = Buffer.from(corePlist);
    tamperedCore[10] = (tamperedCore[10] as number) ^ 0xff;
    expect(() => buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      corePlist: tamperedCore,
      tunnelPlist: null,
    })).toThrow();
  });

  it('buildManifest refuses tunnel presence that mismatches the config flag', () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const corePlist = expectedPlistBytes(config, 'core');
    if (corePlist === null) throw new Error('expected core plist');
    // Config tunnel is disabled, yet a tunnel plist is supplied.
    const foreignTunnel = Buffer.from('foreign-tunnel-plist', 'utf8');
    expect(() => buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      corePlist,
      tunnelPlist: foreignTunnel,
    })).toThrow();
    // Empty tunnel buffer is never a real render.
    expect(() => buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      corePlist,
      tunnelPlist: Buffer.alloc(0),
    })).toThrow();
  });

  it('uid/gid domain stays 1..0xfffffffe / 0..0xfffffffe with integer typing', () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const corePlist = expectedPlistBytes(config, 'core');
    if (corePlist === null) throw new Error('expected core plist');
    const base = {
      configBytes,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      corePlist,
      tunnelPlist: null as Buffer | null,
    };
    // Boundary-valid identities build and validate.
    for (const runtime of [
      { name: 'gram-agent' as const, uid: 1, gid: 0 },
      { name: 'gram-agent' as const, uid: 0xffff_fffe, gid: 0xffff_fffe },
    ]) {
      expect(validateManifestBytes(buildManifest({ ...base, runtime }).bytes)).toBe(true);
    }
    // Out-of-domain identities never build.
    for (const runtime of [
      { name: 'gram-agent' as const, uid: 0, gid: 0 },
      { name: 'gram-agent' as const, uid: 0xffff_ffff, gid: 0 },
      { name: 'gram-agent' as const, uid: 501, gid: -1 },
      { name: 'gram-agent' as const, uid: 501, gid: 0xffff_ffff },
      { name: 'gram-agent' as const, uid: 501.5, gid: 0 },
    ]) {
      expect(() => buildManifest({ ...base, runtime })).toThrow();
    }
    // Wire-level tampering is refused even when the builder was bypassed.
    const parsed = JSON.parse(goodManifest().toString('utf8')) as Record<string, unknown>;
    const bad = (mutate: (runtime: Record<string, unknown>) => void): boolean => {
      const copy = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
      mutate(copy.runtime as Record<string, unknown>);
      return validateManifestBytes(Buffer.from(JSON.stringify(copy), 'utf8'));
    };
    expect(bad((r) => { r.uid = 0; })).toBe(false);
    expect(bad((r) => { r.uid = '501'; })).toBe(false);
    expect(bad((r) => { r.uid = 1.5; })).toBe(false);
    expect(bad((r) => { r.uid = 0xffff_ffff; })).toBe(false);
    expect(bad((r) => { r.gid = -1; })).toBe(false);
    expect(bad((r) => { r.gid = '0'; })).toBe(false);
    expect(bad((r) => { r.name = 'root'; })).toBe(false);
  });

  it('rejects malformed UTF-8, oversize, and extra-key manifests', () => {
    expect(validateManifestBytes(Buffer.from([0xff, 0xfe, 0x00]))).toBe(false);
    expect(validateManifestBytes(Buffer.from('x'.repeat(300000), 'utf8'))).toBe(false);
    const parsed = JSON.parse(goodManifest().toString('utf8')) as Record<string, unknown>;
    (parsed as Record<string, unknown>).extra = true;
    expect(validateManifestBytes(Buffer.from(JSON.stringify(parsed), 'utf8'))).toBe(false);
  });

  it('intermediate journal inventory is a duplicate-free fixed-name allowlist', () => {
    const next = 'a'.repeat(64);
    expect(() => buildIntermediateJournal('STOPPED', {
      previousDigest: null,
      nextDigest: next,
      inventory: ['config/service.json', 'config/service.json'],
    })).toThrow();
  });
});

describe('B4 honest fixture: restore replaces target bytes (#149)', () => {
  it('restorePrior brings back pre-operation live bytes', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const publish = f.ports.publish();
    const before = await publish.readLive('core');
    if (before === null) throw new Error('expected live core bytes');
    const tampered = Buffer.from(before);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await publish.stageFile('core', tampered);
    await publish.publishFile('core', tampered);
    await f.ports.restore().restorePrior();
    expect((await publish.readLive('core'))?.equals(before)).toBe(true);
  });
});

describe('B4 provisioning: unknown durability reconciles, never rewrites (#149)', () => {
  it('existing install with unknown execution state is PARTIAL_INSTALL', () => {
    expect(decideProvisioning({ isNewInstall: false, execution: 'unknown' })).toEqual({
      ok: false,
      code: 'PARTIAL_INSTALL',
    });
  });
});

describe('B4 closed schema: oversize sets never match (#149)', () => {
  it('rejects version lists beyond the bounded input size', () => {
    const big = Array.from({ length: 2000 }, (_, i) => i + 1);
    expect(schemaCompatible(big, [big])).toBe(false);
  });
});
