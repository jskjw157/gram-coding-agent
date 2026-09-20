import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';

const input = {
  schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false },
};

describe('strict lifecycle configuration', () => {
  it('returns a fresh normalized configuration without mutating input', () => {
    const before = JSON.stringify(input);
    const result = parseConfig(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.tunnel).not.toBe(input.tunnel);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    ['null', null], ['array', []], ['string', 'secret-like-input'],
    ['extra command', { ...input, command: 'anything' }],
    ['extra port', { ...input, port: 9999 }],
    ['extra root', { ...input, root: '/tmp' }],
    ['wrong schema', { ...input, schemaVersion: 2 }],
    ['production mode', { ...input, mode: 'PRODUCTION' }],
    ['root runtime', { ...input, runtimeUser: 'root' }],
    ['admin runtime', { ...input, runtimeUser: 'admin' }],
    ['missing digest', { ...input, releaseDigest: undefined }],
    ['nonhex digest', { ...input, releaseDigest: 'g'.repeat(64) }],
    ['short digest', { ...input, releaseDigest: 'a'.repeat(63) }],
    ['uppercase digest', { ...input, releaseDigest: 'A'.repeat(64) }],
    ['string boolean', { ...input, tunnel: { enabled: 'false' } }],
    ['numeric boolean', { ...input, tunnel: { enabled: 0 } }],
    ['missing tunnel field', { ...input, tunnel: {} }],
    ['disabled extras', { ...input, tunnel: { enabled: false, credentialRef: 'test-tunnel-key' } }],
    ['enabled missing proof', { ...input, tunnel: { enabled: true, credentialRef: 'test-tunnel-key' } }],
    ['enabled wrong reference', { ...input, tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'live-key' } }],
    ['nested key value', { ...input, tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key', apiKey: 'not-a-real-key' } }],
  ])('rejects %s with a fixed error only', (_name, value) => {
    expect(() => parseConfig(value)).toThrow(/^INVALID_CONFIG$/);
  });
  it.each(['', '.', '..', '../lab', 'lab/path', 'lab\\path', 'lab\nkey', 'a'.repeat(65), '<lab>', 'lab space'])
    ('rejects unsafe release identifier %j', releaseId => {
      expect(() => parseConfig({ ...input, releaseId })).toThrow(/^INVALID_CONFIG$/);
    });
  it.each(['a', 'a'.repeat(64), 'Lab_01.2-3'])('accepts bounded release identifier %s', releaseId => {
    expect(parseConfig({ ...input, releaseId }).releaseId).toBe(releaseId);
  });
  it('requires all keys, including an own schemaVersion', () => {
    const value = { ...input };
    Reflect.deleteProperty(value, 'schemaVersion');
    expect(() => parseConfig(value)).toThrow(/^INVALID_CONFIG$/);
    expect(() => parseConfig(Object.assign(Object.create({ schemaVersion: 1 }), value)))
      .toThrow(/^INVALID_CONFIG$/);
  });
  it('rejects symbol keys and accessors without invoking a getter', () => {
    expect(() => parseConfig({ ...input, [Symbol('extra')]: true })).toThrow(/^INVALID_CONFIG$/);
    let reads = 0;
    const value = { ...input };
    Object.defineProperty(value, 'mode', { get() { reads += 1; return 'LAB_ONLY'; } });
    expect(() => parseConfig(value)).toThrow(/^INVALID_CONFIG$/);
    expect(reads).toBe(0);
  });
  it('accepts only the explicit test-tunnel reference with compatibility identity', () => {
    expect(parseConfig({ ...input, tunnel: {
      enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key',
    } }).tunnel).toEqual({ enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' });
  });
  it('hashes canonical fields rather than input key order', () => {
    const a = parseConfig(input);
    const b = parseConfig({ tunnel: { enabled: false }, releaseDigest: input.releaseDigest,
      releaseId: input.releaseId, runtimeUser: input.runtimeUser, mode: input.mode, schemaVersion: 1 });
    expect(configDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(configDigest(a)).toBe(configDigest(b));
    expect(configDigest(a)).toBe(createHash('sha256').update(JSON.stringify(a)).digest('hex'));
    expect(configDigest(a)).not.toBe(configDigest(parseConfig({ ...input, releaseId: 'lab-002' })));
  });
});
