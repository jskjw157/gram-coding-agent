import { describe, expect, it } from 'vitest';
import { reconcileJournal } from './journal.js';
import { buildCommittedJournal, buildManifest, canonicalConfigBytes, expectedPlistBytes } from '../adapters/install-files.js';
import { labConfig } from '../test-support/fixtures.js';

describe('reconcileJournal', () => {
  it('absent+absent fresh, committed match clean, else partial', () => {
    expect(reconcileJournal(null, null)).toEqual({ state: 'clean-absent' });
    const config = labConfig();
    const configBytes = canonicalConfigBytes(config);
    const core = expectedPlistBytes(config, 'core');
    if (core === null) throw new Error('expected core plist');
    const manifest = buildManifest({ runtime: { name: 'gram-agent', uid: 501, gid: 501 }, configBytes, releaseId: config.releaseId, releaseDigest: config.releaseDigest, corePlist: core, tunnelPlist: null });
    const journal = buildCommittedJournal(manifest.bytes);
    expect(reconcileJournal(journal, manifest.bytes)).toEqual({ state: 'clean-committed' });
    expect(reconcileJournal(Buffer.from('{"stage":"PREPARED"}', 'utf8'), manifest.bytes)).toEqual({ state: 'partial' });
    expect(reconcileJournal(journal, null)).toEqual({ state: 'partial' });
  });
});
