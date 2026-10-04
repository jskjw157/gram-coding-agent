/**
 * RED contract tests for MAC-02 sealed release packaging (lane C, #141 repair).
 *
 * The #141 contract is the source of truth: platform/macos/package-release.mjs
 * must export packageRelease(options) producing release.json with the EXACT keys
 * the existing inspectRelease consumer reads — no new manifest consumer is made
 * here. Runs with: node --test platform/macos/package-release.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRelease, publishRelease } from './package-release.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const COMMIT = 'a'.repeat(40);
const LOCK = 'lockfile-version: 10.34.5\nfixture-lock\n';
// Required entries per #141: base four + tunnel-client (tunnel) + helper outputs.
const BASE_REQUIRED = [
  'bin/node',
  'apps/agent/dist/main.js',
  'packages/macos-lifecycle/dist/supervisor-cli.js',
  'pnpm-lock.yaml',
];
const HELPERS = ['bin/file-acl', 'bin/peer-owner'];
const TUNNEL_BIN = 'bin/tunnel-client';

function writeSource({ tunnel = false } = {}) {
  const source = mkdtempSync(join(tmpdir(), 'mac02-release-src-'));
  const files = [...BASE_REQUIRED, ...HELPERS, ...(tunnel ? [TUNNEL_BIN] : [])];
  for (const rel of files) {
    const abs = join(source, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    const body = rel === 'pnpm-lock.yaml' ? LOCK : `fixture:${rel}\n`;
    writeFileSync(abs, body);
    chmodSync(abs, rel.startsWith('bin/') ? 0o755 : 0o644);
  }
  return source;
}

function pack(source, overrides = {}) {
  return packageRelease({
    sourceDir: source,
    stagingDir: join(tmpdir(), `mac02-staging-${process.pid}-${Math.random().toString(36).slice(2)}`),
    releaseId: 'lab-001',
    sourceCommit: COMMIT,
    schemaCompatibility: { minimum: 1, maximum: 1 },
    tunnel: overrides.tunnel ?? { enabled: false },
    ...overrides,
  });
}

test('schema: release.json carries the exact consumer keys, no tunnel key when disabled', () => {
  const out = pack(writeSource());
  const manifest = JSON.parse(out.releaseJson);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'releaseId',
    'sourceCommit',
    'lockDigest',
    'files',
    'coreTools',
    'schemaCompatibility',
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.releaseId, 'lab-001');
  assert.equal(manifest.sourceCommit, COMMIT);
  assert.deepEqual(manifest.coreTools, ['agent_health']);
  assert.deepEqual(manifest.schemaCompatibility, { minimum: 1, maximum: 1 });
});

test('schema: tunnel build adds exactly tunnelCompatibilityDigest', () => {
  const digest = 'b'.repeat(64);
  const out = pack(writeSource({ tunnel: true }), {
    tunnel: { enabled: true, compatibilityDigest: digest },
  });
  const manifest = JSON.parse(out.releaseJson);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'releaseId',
    'sourceCommit',
    'lockDigest',
    'files',
    'coreTools',
    'schemaCompatibility',
    'tunnelCompatibilityDigest',
  ]);
  assert.equal(manifest.tunnelCompatibilityDigest, digest);
});

test('entries: all required paths present with actual hashes and bin-executable flags', () => {
  const source = writeSource({ tunnel: true });
  const out = pack(source, { tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64) } });
  const manifest = JSON.parse(out.releaseJson);
  const byPath = new Map(manifest.files.map((e) => [e.path, e]));
  const want = [...BASE_REQUIRED, ...HELPERS, TUNNEL_BIN];
  for (const rel of want) {
    const entry = byPath.get(rel);
    assert.ok(entry, `missing ${rel}`);
    assert.deepEqual(Object.keys(entry), ['path', 'sha256', 'executable']);
    assert.equal(entry.sha256, sha(readFileSync(join(source, rel))));
    assert.equal(entry.executable, rel.startsWith('bin/'), rel);
  }
  const paths = manifest.files.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
});

test('binding: lockDigest is the actual lock bytes; override mismatch refused', () => {
  const source = writeSource();
  const out = pack(source);
  assert.equal(JSON.parse(out.releaseJson).lockDigest, sha(LOCK));
  assert.throws(() => pack(source, { lockBytes: 'tampered-lock\n' }), /LOCK_MISMATCH/);
  assert.throws(() => pack(source, { sourceCommit: 'not-a-commit' }), /SOURCE_COMMIT/);
  assert.throws(() => pack(source, { schemaCompatibility: { minimum: 2, maximum: 1 } }), /SCHEMA_COMPATIBILITY/);
  assert.throws(() => pack(source, { releaseId: '../evil' }), /RELEASE_ID/);
});

test('refusal: dirty source (.git, .env, pem) is refused', () => {
  const gitSource = writeSource();
  mkdirSync(join(gitSource, '.git'), { recursive: true });
  writeFileSync(join(gitSource, '.git', 'config'), '[core]\n');
  assert.throws(() => pack(gitSource), /DIRTY_SOURCE/);

  const envSource = writeSource();
  writeFileSync(join(envSource, '.env'), 'TOKEN=x\n');
  assert.throws(() => pack(envSource), /DIRTY_SOURCE/);

  const pemSource = writeSource();
  writeFileSync(join(pemSource, 'tls.pem'), 'x\n');
  assert.throws(() => pack(pemSource), /DIRTY_SOURCE/);
});

test('refusal: extra undeclared file is refused', () => {
  const source = writeSource();
  writeFileSync(join(source, 'scratch.txt'), 'x\n');
  assert.throws(() => pack(source), /EXTRA_FILE/);
});

test('refusal: missing required entries fail one by one', async () => {
  const { default: fs } = await import('node:fs');
  const want = [...BASE_REQUIRED, ...HELPERS];
  for (const rel of want) {
    const source = writeSource();
    fs.rmSync(join(source, rel));
    assert.throws(() => pack(source), /MISSING_FILE/, rel);
  }
  const noTunnel = writeSource({ tunnel: false });
  assert.throws(
    () => pack(noTunnel, { tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64) } }),
    /MISSING_FILE/,
  );
});

test('refusal: wrong executable flag fails both directions', () => {
  const execOff = writeSource();
  chmodSync(join(execOff, 'bin/node'), 0o644);
  assert.throws(() => pack(execOff), /EXECUTABLE/);

  const execOn = writeSource();
  chmodSync(join(execOn, 'apps/agent/dist/main.js'), 0o755);
  assert.throws(() => pack(execOn), /EXECUTABLE/);
});

test('refusal: symlink escape is refused', () => {
  const abs = writeSource();
  symlinkSync('/etc/hostname', join(abs, 'evil-abs'));
  assert.throws(() => pack(abs, { additionalLinks: [{ path: 'evil-abs', target: '/etc/hostname' }] }), /SYMLINK/);

  const esc = writeSource();
  symlinkSync('../outside', join(esc, 'evil-esc'));
  assert.throws(() => pack(esc, { additionalLinks: [{ path: 'evil-esc', target: '../outside' }] }), /SYMLINK/);
});

test('canonical: same input yields identical bytes and digest', () => {
  const a = pack(writeSource());
  const b = pack(writeSource());
  assert.equal(a.releaseJson, b.releaseJson);
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, sha(a.releaseJson));
  const onDisk = readFileSync(join(a.stagingDir, 'release.json'), 'utf8');
  assert.equal(onDisk, a.releaseJson);
});

test('publication: staging and final are separate; existing output is protected', () => {
  const source = writeSource();
  const stagingParent = mkdtempSync(join(tmpdir(), 'mac02-pub-'));
  const stagingDir = join(stagingParent, 'staging');
  const destDir = join(stagingParent, 'final');
  const out = packageRelease({
    sourceDir: source,
    stagingDir,
    releaseId: 'lab-001',
    sourceCommit: COMMIT,
    schemaCompatibility: { minimum: 1, maximum: 1 },
    tunnel: { enabled: false },
  });
  assert.ok(!((() => { try { readFileSync(join(destDir, 'release.json')); return true; } catch { return false; } })()));
  const published = publishRelease({ stagingDir, destDir });
  assert.equal(published.digest, out.digest);
  assert.equal(readFileSync(join(destDir, 'release.json'), 'utf8'), out.releaseJson);
  assert.throws(() => publishRelease({ stagingDir, destDir }), /OUTPUT_EXISTS/);
  assert.equal(readFileSync(join(destDir, 'release.json'), 'utf8'), out.releaseJson);
});
