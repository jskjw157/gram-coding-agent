/**
 * Round-trip acceptance for the #141 sealed release packager.
 *
 * Builds a complete temporary fixture source, seals it with the lane-owned
 * platform/macos/package-release.mjs packager (the only writer under test),
 * then verifies the staged bundle through the EXISTING inspectRelease consumer
 * plus the real trusted-files adapter. No new manifest consumer is created:
 * assertions observe inspectRelease verdicts only. A single mutated
 * file/link/hash must turn the same verdict into UNTRUSTED_RELEASE.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageRelease } from '../../../platform/macos/package-release.mjs';
import { parseConfig } from './config.js';
import { inspectRelease } from './release-inspection.js';
import { createTrustedFiles } from './adapters/trusted-files.js';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const COMMIT = 'c'.repeat(40);
const BASE = [
  'bin/node',
  'apps/agent/dist/main.js',
  'packages/macos-lifecycle/dist/supervisor-cli.js',
  'pnpm-lock.yaml',
  'bin/file-acl',
  'bin/peer-owner',
] as const;

let work: string;

beforeEach(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), 'gram packaging boundary ')));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function fixtureSource(tunnel: boolean): Promise<{ sourceDir: string; lockDigest: string }> {
  const sourceDir = join(work, 'source');
  const paths = [...BASE, ...(tunnel ? ['bin/tunnel-client'] : [])];
  for (const path of paths) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true, mode: 0o700 });
    const body = path === 'pnpm-lock.yaml' ? 'boundary-lock\n' : `boundary:${path}\n`;
    await writeFile(join(sourceDir, path), body, { mode: path.startsWith('bin/') ? 0o700 : 0o600 });
  }
  return { sourceDir, lockDigest: sha('boundary-lock\n') };
}

function seal(sourceDir: string, tunnel: boolean, releaseId = 'lab-001') {
  return packageRelease({
    sourceDir,
    stagingDir: join(work, `staging-${releaseId}`),
    releaseId,
    sourceCommit: COMMIT,
    schemaCompatibility: { minimum: 1, maximum: 1 },
    tunnel: tunnel
      ? { enabled: true, compatibilityDigest: 'd'.repeat(64) }
      : { enabled: false },
  });
}

async function verify(stagingDir: string, releaseId: string, digest: string, tunnel: boolean) {
  const config = parseConfig({
    schemaVersion: 1,
    mode: 'LAB_ONLY',
    runtimeUser: 'gram-agent',
    releaseId,
    releaseDigest: digest,
    tunnel: tunnel
      ? { enabled: true, compatibilityDigest: 'd'.repeat(64), credentialRef: 'test-tunnel-key' }
      : { enabled: false },
  });
  const files = createTrustedFiles(stagingDir, process.getuid?.() ?? -1, async () => true);
  return inspectRelease(config, digest, files);
}

describe('packaging boundary round-trip', () => {
  it.each([false, true])('accepts a sealed bundle through inspectRelease (tunnel=%s)', async (tunnel) => {
    const { sourceDir, lockDigest } = await fixtureSource(tunnel);
    const sealed = seal(sourceDir, tunnel);
    const before = await readFile(join(sealed.stagingDir, 'release.json'));
    const evidence = await verify(sealed.stagingDir, 'lab-001', sealed.digest, tunnel);
    expect(evidence).toEqual({
      verified: true,
      safePaths: true,
      digest: sealed.digest,
      sourceCommit: COMMIT,
      lockDigest,
      entries: [...BASE, ...(tunnel ? ['bin/tunnel-client'] : [])].sort(),
    });
    expect(await readFile(join(sealed.stagingDir, 'release.json'))).toEqual(before);
  });

  it('refuses a single mutated payload byte after sealing', async () => {
    const { sourceDir } = await fixtureSource(false);
    const sealed = seal(sourceDir, false);
    await writeFile(join(sealed.stagingDir, 'apps/agent/dist/main.js'), 'altered\n');
    await expect(verify(sealed.stagingDir, 'lab-001', sealed.digest, false)).rejects.toThrow(
      /^UNTRUSTED_RELEASE$/,
    );
  });

  it('refuses a flipped executable bit after sealing', async () => {
    const { sourceDir } = await fixtureSource(false);
    const sealed = seal(sourceDir, false);
    await chmod(join(sealed.stagingDir, 'apps/agent/dist/main.js'), 0o700);
    await expect(verify(sealed.stagingDir, 'lab-001', sealed.digest, false)).rejects.toThrow(
      /^UNTRUSTED_RELEASE$/,
    );
  });

  it('refuses an unlisted file added after sealing', async () => {
    const { sourceDir } = await fixtureSource(false);
    const sealed = seal(sourceDir, false);
    await writeFile(join(sealed.stagingDir, 'extra.txt'), 'x\n', { mode: 0o600 });
    await expect(verify(sealed.stagingDir, 'lab-001', sealed.digest, false)).rejects.toThrow(
      /^UNTRUSTED_RELEASE$/,
    );
  });

  it('refuses a tampered manifest hash without touching payload', async () => {
    const { sourceDir } = await fixtureSource(false);
    const sealed = seal(sourceDir, false);
    const manifest = JSON.parse(sealed.releaseJson) as {
      files: Array<{ path: string; sha256?: string }>;
    };
    const target = manifest.files.find((e) => e.path === 'pnpm-lock.yaml');
    if (target?.sha256 === undefined) throw new Error('MISSING_FIXTURE');
    target.sha256 = '0'.repeat(64);
    await writeFile(join(sealed.stagingDir, 'release.json'), JSON.stringify(manifest));
    await expect(verify(sealed.stagingDir, 'lab-001', sealed.digest, false)).rejects.toThrow(
      /^UNTRUSTED_RELEASE$/,
    );
  });

  it('accepts an allowlisted internal link end to end', async () => {
    const { sourceDir } = await fixtureSource(false);
    await mkdir(join(sourceDir, 'node_modules'), { mode: 0o700 });
    await symlink('../packages/macos-lifecycle', join(sourceDir, 'node_modules/local'));
    const sealed = packageRelease({
      sourceDir,
      stagingDir: join(work, 'staging-links'),
      releaseId: 'lab-001',
      sourceCommit: COMMIT,
      schemaCompatibility: { minimum: 1, maximum: 1 },
      tunnel: { enabled: false },
      additionalLinks: [{ path: 'node_modules/local', target: '../packages/macos-lifecycle' }],
    });
    const evidence = await verify(sealed.stagingDir, 'lab-001', sealed.digest, false);
    expect(evidence.verified).toBe(true);
    expect(evidence.entries).toContain('node_modules/local');
  });
});
