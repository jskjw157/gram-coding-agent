import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configDigest } from './config.js';
import { labConfig } from './test-support/fixtures.js';
import { copyRuntimeReview, decodeRuntimeReview, encodeRuntimeReview } from './runtime-review.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const config = labConfig();
  return { config, configDigest: configDigest(config), nodeDigest: 'b'.repeat(64),
    fileAclDigest: 'c'.repeat(64), peerOwnerDigest: 'd'.repeat(64) };
}
function golden() { return Buffer.from(JSON.stringify({ schemaVersion: 1, review: fixture() }) + '\n'); }

describe('immutable reviewed runtime metadata', () => {
  it('copies valid review metadata and freezes nested configuration', () => {
    const input = fixture(); const value = copyRuntimeReview(input);
    expect(value).toEqual(input); expect(value).not.toBe(input); expect(value.config).not.toBe(input.config);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.config)).toBe(true);
    expect(Object.isFrozen(value.config.tunnel)).toBe(true);
    input.nodeDigest = 'e'.repeat(64); input.config.releaseId = 'changed';
    expect(value.nodeDigest).toBe('b'.repeat(64)); expect(value.config.releaseId).not.toBe('changed');
  });
  it('keeps the existing tunnel configuration reference without using it', () => {
    const f = fixture(); const config = { ...f.config,
      tunnel: { enabled: true as const, compatibilityDigest: 'e'.repeat(64), credentialRef: 'test-tunnel-key' as const } };
    const value = copyRuntimeReview({ ...f, config, configDigest: configDigest(config) });
    expect(value.config.tunnel).toEqual(config.tunnel);
    expect(Object.isFrozen(value.config.tunnel)).toBe(true);
  });
  it.each(['', 'A'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), 'b'.repeat(64) + '\n', 42, null])('refuses malformed binary pin %#', pin => {
    expect(() => copyRuntimeReview({ ...fixture(), nodeDigest: pin })).toThrow('INVALID_RUNTIME_REVIEW');
  });
  it('does not confuse the normalized config digest with another hash', () => {
    expect(() => copyRuntimeReview({ ...fixture(), configDigest: 'f'.repeat(64) })).toThrow('INVALID_RUNTIME_REVIEW');
  });
  it('refuses accessors without invoking them', () => {
    const value = fixture(); let reads = 0;
    Object.defineProperty(value, 'nodeDigest', { enumerable: true, get() { reads++; return 'b'.repeat(64); } });
    expect(() => copyRuntimeReview(value)).toThrow('INVALID_RUNTIME_REVIEW'); expect(reads).toBe(0);
  });
  it.each([null, [], 'review', { ...fixture(), extra: true }, Object.create(fixture())])('refuses non-record or unexpected fields %#', input => {
    expect(() => copyRuntimeReview(input)).toThrow('INVALID_RUNTIME_REVIEW');
  });
  it('does not invoke a hostile serializer on caller data', () => {
    let calls = 0;
    expect(() => encodeRuntimeReview({ ...fixture(), toJSON() { calls++; return fixture(); } })).toThrow('INVALID_RUNTIME_REVIEW');
    expect(calls).toBe(0);
  });
});

describe('canonical bootstrap review envelope', () => {
  it('encodes exact deterministic bytes with the original RuntimeReview contract', () => {
    expect(encodeRuntimeReview(fixture())).toEqual(golden());
    expect(encodeRuntimeReview(copyRuntimeReview(fixture()))).toEqual(golden());
  });
  it('decodes only the independently expected exact bytes and detaches the buffer', () => {
    const bytes = golden(); const value = decodeRuntimeReview(bytes, sha(bytes));
    expect(value).toEqual(fixture()); bytes.fill(0);
    expect(value?.nodeDigest).toBe('b'.repeat(64)); expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(['', 'e'.repeat(64), 'A'.repeat(64), 'b'.repeat(64) + '\n'])('refuses a missing, different or malformed expected digest %#', pin => {
    expect(decodeRuntimeReview(golden(), pin)).toBeNull();
  });
  it('rejects a replaced candidate even when its internal metadata is consistent', () => {
    const expected = sha(golden()); const replacement = fixture(); replacement.nodeDigest = 'f'.repeat(64);
    const changed = Buffer.from(JSON.stringify({ schemaVersion: 1, review: replacement }) + '\n');
    expect(decodeRuntimeReview(changed, expected)).toBeNull();
  });
  it.each([
    { name: 'BOM', make: () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), golden()]) },
    { name: 'extra newline', make: () => Buffer.concat([golden(), Buffer.from('\n')]) },
    { name: 'duplicate version', make: () => Buffer.from(golden().toString().replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')) },
    { name: 'wrong version', make: () => Buffer.from(JSON.stringify({ schemaVersion: 2, review: fixture() }) + '\n') },
    { name: 'extra envelope field', make: () => Buffer.from(JSON.stringify({ schemaVersion: 1, review: fixture(), extra: true }) + '\n') },
    { name: 'reordered envelope', make: () => Buffer.from(JSON.stringify({ review: fixture(), schemaVersion: 1 }) + '\n') },
    { name: 'unknown review field', make: () => Buffer.from(JSON.stringify({ schemaVersion: 1, review: { ...fixture(), extra: true } }) + '\n') },
    { name: 'invalid UTF-8', make: () => Buffer.from([0xff, 0xfe]) },
    { name: 'empty bytes', make: () => Buffer.alloc(0) },
    { name: 'oversized input', make: () => Buffer.alloc(65537, 32) },
  ])('refuses $name even with a matching digest', ({ make }) => {
    const bytes = make(); expect(decodeRuntimeReview(bytes, sha(bytes))).toBeNull();
  });
  it('canonicalizes an input object before producing a record', () => {
    const f = fixture(); const reversed = { peerOwnerDigest: f.peerOwnerDigest, fileAclDigest: f.fileAclDigest,
      nodeDigest: f.nodeDigest, configDigest: f.configDigest, config: f.config };
    expect(encodeRuntimeReview(reversed)).toEqual(golden());
  });
  it('returns fixed failures without attaching untrusted objects', () => {
    try { encodeRuntimeReview({ privateDiagnostic: 'SYNTHETIC_UNTRUSTED_VALUE' }); throw new Error('expected failure'); }
    catch (error) { expect(error).toEqual(new Error('INVALID_RUNTIME_REVIEW')); expect(JSON.stringify(error)).toBe('{}'); }
    expect(decodeRuntimeReview('not a buffer' as unknown as Buffer, 'a'.repeat(64))).toBeNull();
  });
});
