import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { renderPlist } from './launchd-plist.js';
import type { Role } from './contracts.js';

const input = { schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } };

describe('configuration boundary regressions', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', '\t'])(
    'rejects trailing release delimiter %j', suffix => {
      expect(() => parseConfig({ ...input, releaseId: `lab${suffix}` })).toThrow(/^INVALID_CONFIG$/);
    });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', '\t'])(
    'rejects trailing digest delimiter %j', suffix => {
      expect(() => parseConfig({ ...input, releaseDigest: `${input.releaseDigest}${suffix}` })).toThrow(/^INVALID_CONFIG$/);
    });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects trailing compatibility digest delimiter %j', suffix => {
      expect(() => parseConfig({ ...input, tunnel: { enabled: true,
        compatibilityDigest: `${'b'.repeat(64)}${suffix}`, credentialRef: 'test-tunnel-key' } }))
        .toThrow(/^INVALID_CONFIG$/);
    });
  it.each(['other', '../core', 'core\n', '', '__proto__'])('rejects a forged role %j', role => {
    expect(() => renderPlist(parseConfig(input), role as Role)).toThrow(/^INVALID_CONFIG$/);
  });
  it('rejects a nested accessor without using the accessor', () => {
    let reads = 0;
    const tunnel = Object.defineProperty({}, 'enabled', {
      enumerable: true, get() { reads += 1; return false; },
    });
    expect(() => parseConfig({ ...input, tunnel })).toThrow(/^INVALID_CONFIG$/);
    expect(reads).toBe(0);
  });
  it('does not leak an exception thrown by object inspection', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('synthetic-private-value'); } });
    expect(() => parseConfig(hostile)).toThrow(/^INVALID_CONFIG$/);
  });
});
