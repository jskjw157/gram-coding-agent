/**
 * RED spec for MAC-02 deterministic release packaging (lane C, #141).
 *
 * Covers: bundle layout, manifest determinism/integrity, no-secrets scan,
 * file permissions. Runs with: node --test platform/macos/packaging/
 *
 * No real secrets in this file: credential-shaped fixtures are built
 * programmatically from repeated characters and are non-functional canaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_LAYOUT_VERSION,
  sha256Hex,
  scanForSecrets,
  assertNoSecrets,
  planRelease,
  writeReleaseBundle,
} from './release-packaging.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'mac02-packaging-'));

// Synthetic credential canaries (non-functional: repeated characters only).
const canary = {
  githubToken: () => 'ghp_' + 'A'.repeat(36),
  awsAccessKey: () => 'AKIA' + 'A'.repeat(16),
  pemPrivateKey: () => '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + 'A'.repeat(64),
  slackToken: () => 'xoxb-' + '1'.repeat(13),
  openaiKey: () => 'sk-' + 'A'.repeat(32),
  googleKey: () => 'AIza' + 'A'.repeat(35),
};

const cleanFiles = () => [
  { path: 'packages/macos-lifecycle/dist/supervisor-cli.js', content: "'use strict';\n" },
  { path: 'config/service.json', content: '{"schemaVersion":1}\n', mode: '0600' },
  { path: 'plists/core.plist', content: '<?xml version="1.0"?>\n' },
];

test('layout: bundle creates manifest.json plus payload tree', () => {
  const dest = tmp();
  const manifest = writeReleaseBundle({ destDir: dest, releaseId: 'lab-001', files: cleanFiles() });
  assert.equal(manifest.schemaVersion, RELEASE_LAYOUT_VERSION);
  assert.equal(manifest.releaseId, 'lab-001');
  assert.equal(manifest.fileCount, 3);
  const onDisk = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk, manifest);
  for (const entry of manifest.entries) {
    const body = readFileSync(join(dest, 'payload', entry.path), 'utf8');
    assert.equal(sha(body), entry.sha256);
    assert.equal(body.length, entry.bytes);
  }
  assert.deepEqual(readdirSync(join(dest, 'payload')).sort(), ['config', 'packages', 'plists']);
});

test('layout: entries are sorted and parent dirs are created', () => {
  const dest = tmp();
  const reversed = cleanFiles().reverse();
  const manifest = writeReleaseBundle({ destDir: dest, releaseId: 'lab-001', files: reversed });
  const paths = manifest.entries.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(
    manifest.totalBytes,
    reversed.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0),
  );
});

test('manifest: digests match sha256 and digest is deterministic', () => {
  const first = planRelease({ releaseId: 'lab-001', files: cleanFiles() });
  const shuffled = planRelease({ releaseId: 'lab-002', files: cleanFiles().reverse() });
  const byPath = new Map(cleanFiles().map((f) => [f.path, f.content]));
  for (const entry of first.entries) {
    assert.equal(entry.sha256, sha(byPath.get(entry.path)));
  }
  assert.equal(first.manifestDigest, sha256Hex(JSON.stringify({
    schemaVersion: first.schemaVersion,
    releaseId: first.releaseId,
    entries: first.entries,
  })));
  // Same file set, different input order -> same entries and per-entry digests.
  assert.deepEqual(
    shuffled.entries,
    first.entries.map((e) => ({ ...e })),
  );
  // Different release id -> different manifest digest, same entry digests.
  assert.notEqual(shuffled.manifestDigest, first.manifestDigest);
  // Rewrite is byte-identical.
  const a = tmp();
  const b = tmp();
  writeReleaseBundle({ destDir: a, releaseId: 'lab-001', files: cleanFiles() });
  writeReleaseBundle({ destDir: b, releaseId: 'lab-001', files: cleanFiles() });
  assert.equal(
    readFileSync(join(a, 'manifest.json'), 'utf8'),
    readFileSync(join(b, 'manifest.json'), 'utf8'),
  );
});

test('manifest: rejects invalid release ids, paths, modes, duplicates', () => {
  assert.throws(() => planRelease({ releaseId: '', files: cleanFiles() }), /RELEASE_ID/);
  assert.throws(() => planRelease({ releaseId: '../evil', files: cleanFiles() }), /RELEASE_ID/);
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: '/abs.js', content: 'x' }] }),
    /PATH/,
  );
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: 'a/../../b.js', content: 'x' }] }),
    /PATH/,
  );
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: 'a\\b.js', content: 'x' }] }),
    /PATH/,
  );
  assert.throws(
    () => planRelease({
      releaseId: 'lab-001',
      files: [{ path: 'dup.js', content: 'a' }, { path: 'dup.js', content: 'b' }],
    }),
    /DUPLICATE/,
  );
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: 'x.js', content: 'x', mode: '0777' }] }),
    /MODE/,
  );
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: '.env', content: 'A=1' }] }),
    /SECRET_PATH/,
  );
  assert.throws(
    () => planRelease({ releaseId: 'lab-001', files: [{ path: 'tls/server.pem', content: 'x' }] }),
    /SECRET_PATH/,
  );
});

test('no-secrets scan: flags each credential canary by rule name only', () => {
  const cases = [
    [canary.githubToken(), 'github-token'],
    [canary.awsAccessKey(), 'aws-access-key'],
    [canary.pemPrivateKey(), 'pem-private-key'],
    [canary.slackToken(), 'slack-token'],
    [canary.openaiKey(), 'openai-key'],
    [canary.googleKey(), 'google-api-key'],
  ];
  for (const [text, rule] of cases) {
    const findings = scanForSecrets(`prefix ${text} suffix`);
    assert.equal(findings.length, 1, rule);
    assert.equal(findings[0].rule, rule);
    assert.ok(!JSON.stringify(findings).includes(text), 'finding must not echo credential');
  }
  assert.deepEqual(scanForSecrets(cleanFiles().map((f) => f.content).join('\n')), []);
  assert.deepEqual(scanForSecrets(''), []);
});

test('no-secrets scan: bundle write rejects credential content and 0.0.0.0 binds', () => {
  const dest = tmp();
  assert.throws(
    () => writeReleaseBundle({
      destDir: dest,
      releaseId: 'lab-001',
      files: [{ path: 'config/service.json', content: `{"token":"${canary.githubToken()}"}` }],
    }),
    /SECRETS_DETECTED github-token/,
  );
  assert.throws(
    () => writeReleaseBundle({
      destDir: dest,
      releaseId: 'lab-001',
      files: [{ path: 'bin/run.sh', content: 'listen 0.0.0.0:8080\n' }],
    }),
    /FORBIDDEN_BIND/,
  );
  assert.throws(() => assertNoSecrets([{ path: 'k', content: canary.pemPrivateKey() }]), /pem-private-key/);
});

test('permissions: fixed modes, no world-writable bits, manifest 0644', () => {
  const dest = tmp();
  const manifest = writeReleaseBundle({ destDir: dest, releaseId: 'lab-001', files: cleanFiles() });
  const modeOf = (p) => statSync(p).mode & 0o777;
  assert.equal(modeOf(join(dest, 'manifest.json')), 0o644);
  for (const entry of manifest.entries) {
    const got = modeOf(join(dest, 'payload', entry.path));
    const want = entry.mode === '0600' ? 0o600 : 0o644;
    assert.equal(got, want, entry.path);
    assert.equal(got & 0o002, 0, `world-writable: ${entry.path}`);
  }
  assert.equal(modeOf(join(dest, 'payload')), 0o755);
  assert.equal(modeOf(join(dest, 'payload', 'config')), 0o755);
});
