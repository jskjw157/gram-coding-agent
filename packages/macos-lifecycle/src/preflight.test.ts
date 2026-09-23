import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import type { Inspector, PreflightFacts } from './inspection-contracts.js';
import { firstRefusal, preview } from './preflight.js';
import { labConfig, makeInspector } from './test-support/fixtures.js';

const yes: PreflightFacts = { nativeMac: true, node24: true, validAccount: true,
  trustedRelease: true, safePaths: true, ownedInstallation: true, freeOrOwnedPorts: true };
const installed = { owned: true, safePaths: true, digest: 'b'.repeat(64),
  present: { core: true, tunnel: false }, enabled: { core: true, tunnel: false } };

describe('read-only preflight decisions', () => {
  it.each([
    ['nativeMac', 'UNSUPPORTED_HOST'], ['node24', 'UNSUPPORTED_HOST'],
    ['validAccount', 'ACCOUNT_INVALID'], ['trustedRelease', 'UNTRUSTED_RELEASE'],
    ['safePaths', 'UNSAFE_PATH'], ['ownedInstallation', 'FOREIGN_SERVICE'],
    ['freeOrOwnedPorts', 'PORT_IN_USE'],
  ] as const)('refuses a missing %s condition', (key, code) => {
    expect(firstRefusal({ ...yes, [key]: false })).toBe(code);
    expect(firstRefusal({ ...yes, [key]: undefined } as unknown as PreflightFacts)).toBe(code);
    expect(firstRefusal({ ...yes, [key]: 'true' } as unknown as PreflightFacts)).toBe(code);
  });
  it('returns OK only when all required conditions are affirmative', () => {
    expect(firstRefusal(yes)).toBe('OK');
    expect(firstRefusal({ ...yes, nativeMac: false, validAccount: false })).toBe('UNSUPPORTED_HOST');
  });
  it('produces a review digest using only read ports and leaves config unchanged', async () => {
    const config = labConfig(); const before = JSON.stringify(config); const inspector = makeInspector();
    const result = await preview(config, config.releaseDigest, inspector);
    expect(result).toMatchObject({ ok: true, code: 'OK', previousInstallDigest: null,
      releaseDigest: config.releaseDigest, roles: ['core'] });
    expect(result.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(inspector.reads).toEqual(['host', 'account', 'release', 'installation', 'ports', 'plistValidity']);
    expect(JSON.stringify(config)).toBe(before);
  });
  it.each([
    ['wrong architecture', 'host', { platform: 'darwin', arch: 'x64', nodeVersion: '24.20.0' }, 'UNSUPPORTED_HOST'],
    ['other platform', 'host', { platform: 'linux', arch: 'arm64', nodeVersion: '24.20.0' }, 'UNSUPPORTED_HOST'],
    ['wrong node', 'host', { platform: 'darwin', arch: 'arm64', nodeVersion: '22.0.0' }, 'UNSUPPORTED_HOST'],
    ['root account', 'account', { name: 'gram-agent', uid: 0, gid: 501, admin: false, groupsComplete: true }, 'ACCOUNT_INVALID'],
    ['administrator', 'account', { name: 'gram-agent', uid: 501, gid: 501, admin: true, groupsComplete: true }, 'ACCOUNT_INVALID'],
    ['unknown membership', 'account', { name: 'gram-agent', uid: 501, gid: 501, admin: false, groupsComplete: false }, 'ACCOUNT_INVALID'],
    ['missing account', 'account', null, 'ACCOUNT_INVALID'],
    ['fractional UID', 'account', { name: 'gram-agent', uid: 1.5, gid: 501, admin: false, groupsComplete: true }, 'ACCOUNT_INVALID'],
    ['non-numeric GID', 'account', { name: 'gram-agent', uid: 501, gid: '501', admin: false, groupsComplete: true }, 'ACCOUNT_INVALID'],
    ['untrusted release', 'release', { verified: false, safePaths: true, digest: 'a'.repeat(64) }, 'UNTRUSTED_RELEASE'],
    ['wrong release hash', 'release', { verified: true, safePaths: true, digest: 'b'.repeat(64) }, 'UNTRUSTED_RELEASE'],
    ['unsafe release paths', 'release', { verified: true, safePaths: false, digest: 'a'.repeat(64) }, 'UNSAFE_PATH'],
    ['foreign job', 'installation', { ...installed, owned: false }, 'FOREIGN_SERVICE'],
    ['unsafe installation', 'installation', { ...installed, safePaths: false }, 'UNSAFE_PATH'],
    ['invalid install hash', 'installation', { ...installed, digest: 'not-a-digest' }, 'FOREIGN_SERVICE'],
    ['enabled absent job', 'installation', { ...installed, present: { core: false, tunnel: false } }, 'FOREIGN_SERVICE'],
    ['orphan tunnel', 'installation', { ...installed, present: { core: false, tunnel: true }, enabled: { core: false, tunnel: true } }, 'FOREIGN_SERVICE'],
    ['missing role state', 'installation', { ...installed, enabled: { core: true } }, 'FOREIGN_SERVICE'],
    ['foreign core port', 'ports', { core: 'foreign', tunnel: 'free' }, 'PORT_IN_USE'],
    ['unknown core port', 'ports', { core: 'unknown', tunnel: 'free' }, 'PORT_IN_USE'],
    ['invalid plist', 'plistValidity', false, 'INVALID_CONFIG'],
    ['unknown plist validity', 'plistValidity', undefined, 'INVALID_CONFIG'],
  ] as const)('refuses %s', async (_name, key, value, code) => {
    const result = await preview(labConfig(), 'a'.repeat(64), makeInspector({ [key]: value }));
    expect(result).toMatchObject({ ok: false, code, roles: [] });
  });
  it('does not read release contents when host verification fails', async () => {
    const inspector = makeInspector({ host: null });
    expect((await preview(labConfig(), 'a'.repeat(64), inspector)).code).toBe('UNSUPPORTED_HOST');
    expect(inspector.reads).toEqual(['host']);
  });
  it('refuses a changed trusted digest before doing inspection', async () => {
    const inspector = makeInspector();
    expect((await preview(labConfig(), 'b'.repeat(64), inspector)).code).toBe('UNTRUSTED_RELEASE');
    expect(inspector.reads).toEqual([]);
  });
  it('does not mistake an unregistered listener for our running job', async () => {
    const inspector = makeInspector({ ports: { core: 'owned', tunnel: 'free' } });
    expect((await preview(labConfig(), 'a'.repeat(64), inspector)).code).toBe('PORT_IN_USE');
  });
  it('allows a separately verified already-owned registered core', async () => {
    const inspector = makeInspector({ installation: installed, ports: { core: 'owned', tunnel: 'free' } });
    expect((await preview(labConfig(), 'a'.repeat(64), inspector)).ok).toBe(true);
  });
  it('does not reserve the unused tunnel port for a core-only preview', async () => {
    const inspector = makeInspector({ ports: { core: 'free', tunnel: 'foreign' } });
    expect((await preview(labConfig(), 'a'.repeat(64), inspector)).ok).toBe(true);
  });
  it('checks the tunnel port when the reviewed config enables it', async () => {
    const config = parseConfig({ ...labConfig(), tunnel: { enabled: true,
      compatibilityDigest: 'c'.repeat(64), credentialRef: 'test-tunnel-key' } });
    expect((await preview(config, 'a'.repeat(64), makeInspector({ ports: { core: 'free', tunnel: 'foreign' } }))).code)
      .toBe('PORT_IN_USE');
    expect((await preview(config, 'a'.repeat(64), makeInspector())).roles).toEqual(['core', 'tunnel']);
  });
  it('binds the preview token to both configuration and prior installation', async () => {
    const a = await preview(labConfig(), 'a'.repeat(64), makeInspector());
    const b = await preview(labConfig(), 'a'.repeat(64), makeInspector({ installation: installed }));
    const c = await preview(parseConfig({ ...labConfig(), releaseId: 'lab-002' }), 'a'.repeat(64), makeInspector());
    expect(a.configDigest).not.toBe(b.configDigest);
    expect(a.configDigest).not.toBe(c.configDigest);
    expect(a.configDigest).toBe((await preview(labConfig(), 'a'.repeat(64), makeInspector())).configDigest);
  });
  it.each(['host', 'account', 'release', 'installation', 'ports', 'plistValidity'] as const)(
    'contains a %s inspection error without disclosing its text', async key => {
      const inspector: Inspector = makeInspector();
      inspector[key] = async () => { throw new Error('synthetic-private-value'); };
      const result = await preview(labConfig(), 'a'.repeat(64), inspector);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
      expect(result.roles).toEqual([]);
    });
});
