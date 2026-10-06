import { describe, expect, it } from 'vitest';
import type { Role } from './contracts.js';
import type { Inspector } from './inspection-contracts.js';
import { preview } from './preflight.js';
import { labConfig, makeInspector } from './test-support/fixtures.js';

describe('preflight input isolation', () => {
  it('does not render adapter-mutated release configuration', async () => {
    const inspector: Inspector = makeInspector();
    const plists: string[] = [];
    inspector.release = async config => {
      config.releaseId = 'other-release';
      config.tunnel = { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' };
      return { verified: true, safePaths: true, digest: 'a'.repeat(64) };
    };
    inspector.plistValidity = async values => { plists.push(...values); return true; };
    const result = await preview(labConfig(), 'a'.repeat(64), inspector);
    const baseline = await preview(labConfig(), 'a'.repeat(64), makeInspector());
    expect(result).toEqual(baseline);
    expect(plists).toHaveLength(1);
    expect(plists[0]).toContain('/releases/lab-001/');
    expect(plists[0]).not.toContain('other-release');
  });
  it('cannot skip a conflicting port by changing the adapter input array', async () => {
    const inspector: Inspector = makeInspector();
    inspector.ports = async roles => {
      (roles as Role[]).splice(0);
      return { core: 'foreign', tunnel: 'free' };
    };
    expect(await preview(labConfig(), 'a'.repeat(64), inspector))
      .toMatchObject({ ok: false, code: 'PORT_IN_USE', roles: [] });
  });
  it.each([
    ['host', 'UNSUPPORTED_HOST'], ['account', 'ACCOUNT_INVALID'],
    ['release', 'UNTRUSTED_RELEASE'], ['installation', 'FOREIGN_SERVICE'],
    ['ports', 'PORT_IN_USE'], ['plistValidity', 'INVALID_CONFIG'],
  ] as const)('actually invokes and contains a failing %s adapter', async (key, code) => {
    const inspector: Inspector = makeInspector(); let calls = 0;
    inspector[key] = async () => { calls += 1; throw new Error('synthetic-private-value'); };
    const result = await preview(labConfig(), 'a'.repeat(64), inspector);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, code, roles: [] });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
  });
});
