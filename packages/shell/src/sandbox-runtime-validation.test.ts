import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { RUNTIME_RECEIPT, SANDBOX_RUNTIME_MANIFEST_GOLDEN, SANDBOX_RUNTIME_MANIFEST_GOLDEN_SHA256 } from './sandbox-runtime-contract.js';
import { runtimeManifestDigest, validateRuntimeReceipt } from './sandbox-runtime-validation.js';

it('agrees with the independently generated Python manifest bytes and digest', () => {
  const manifest = JSON.parse(SANDBOX_RUNTIME_MANIFEST_GOLDEN) as Array<[string, string, number, number, string]>;
  expect(runtimeManifestDigest(manifest)).toBe(SANDBOX_RUNTIME_MANIFEST_GOLDEN_SHA256);
  expect(createHash('sha256').update(SANDBOX_RUNTIME_MANIFEST_GOLDEN).digest('hex')).toBe(SANDBOX_RUNTIME_MANIFEST_GOLDEN_SHA256);
});

it('accepts only the exact pinned artifact receipt', () => {
  expect(() => validateRuntimeReceipt({ ...RUNTIME_RECEIPT })).not.toThrow();
  for (const key of Object.keys(RUNTIME_RECEIPT)) {
    const value = { ...RUNTIME_RECEIPT, [key]: 'forged' };
    expect(() => validateRuntimeReceipt(value)).toThrow();
  }
  expect(() => validateRuntimeReceipt({ ...RUNTIME_RECEIPT, source: '/home/user/runtime' })).toThrow();
  expect(() => validateRuntimeReceipt({ nodeSha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c' })).toThrow();
});

it('binds the full manifest to content, type, mode, name and unexpected files', () => {
  const directory: [string, string, number, number, string] = ['bin', 'directory', 493, 0, ''];
  const original: Array<[string, string, number, number, string]> = [directory, ['bin/node', 'file', 493, 3, 'abc']];
  const digest = runtimeManifestDigest(original);
  for (const row of [['bin/node', 'file', 493, 3, 'def'], ['bin/node', 'symlink', 511, 3, 'abc'],
    ['bin/node', 'file', 511, 3, 'abc'], ['bin/payload', 'file', 493, 3, 'abc']] as Array<[string, string, number, number, string]>) {
    expect(runtimeManifestDigest([directory, row])).not.toBe(digest);
  }
  expect(runtimeManifestDigest([...original, ['secret', 'file', 420, 4, 'canary']])).not.toBe(digest);
});
