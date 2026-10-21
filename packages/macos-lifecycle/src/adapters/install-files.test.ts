import { describe, expect, it } from 'vitest';
import { buildCommittedJournal, buildManifest, canonicalConfigBytes, expectedPlistBytes, FIXED_FILES, shaBytes, validateCommittedJournal, validateManifestBytes } from './install-files.js';
import { labConfig } from '../test-support/fixtures.js';

describe('install-files byte binding', () => {
  it('manifest exact keys, disabled snapshot, hash-bound', () => {
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const core = expectedPlistBytes(config, 'core');
    if (core === null) throw new Error('expected core plist');
    const built = buildManifest({ runtime: { name: 'gram-agent', uid: 501, gid: 501 }, configBytes, releaseId: config.releaseId, releaseDigest: config.releaseDigest, corePlist: core, tunnelPlist: null });
    expect(validateManifestBytes(built.bytes)).toBe(true);
    const parsed = JSON.parse(built.bytes.toString('utf8'));
    expect(parsed).toMatchObject({ schemaVersion: 1, state: 'COMMITTED', desiredEnabled: { core: false, tunnel: false } });
    expect(parsed.configSha256).toBe(shaBytes(configBytes));
    expect(parsed.plistSha256.core).toBe(shaBytes(core));
    expect(parsed.plistSha256.tunnel).toBeNull();
    expect(built.sha).toBe(shaBytes(built.bytes));
    // committed journal binds manifest sha
    const journal = buildCommittedJournal(built.bytes);
    expect(validateCommittedJournal(journal, built.bytes)).toBe(true);
    expect(Object.values(FIXED_FILES)).toHaveLength(5);
  });

  it('rejects foreign manifest bytes', () => {
    expect(validateManifestBytes(Buffer.from('{"schemaVersion":1}', 'utf8'))).toBe(false);
    expect(validateManifestBytes(Buffer.from('x'.repeat(300000), 'utf8'))).toBe(false);
  });
});
