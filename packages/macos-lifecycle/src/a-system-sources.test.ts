import { chmod, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInstalledRuntimeReviewSource,
  createRuntimeCoreCredentials,
  createSystemBootstrapSources,
  systemBootstrapPaths,
} from './a-system-sources.js';
import {
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
} from './adapters/install-files.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

async function installedFixture() {
  const f = await fixture();
  roots.push(f.anchor);
  const configBytes = canonicalConfigBytes(f.review.config);
  const corePlist = expectedPlistBytes(f.review.config, 'core');
  if (corePlist === null) throw new Error('missing core plist');
  const tunnelPlist = expectedPlistBytes(f.review.config, 'tunnel');
  const built = buildManifest({
    runtime: { name: 'gram-agent', uid: f.uid, gid: f.gid },
    configBytes,
    releaseId: f.review.config.releaseId,
    releaseDigest: f.review.config.releaseDigest,
    corePlist,
    tunnelPlist,
  });
  await writeFile(`${f.base}/config/service.json`, configBytes, { mode: 0o600 });
  await writeFile(`${f.base}/config/installation.json`, built.bytes, { mode: 0o600 });
  return f;
}

describe('A fixed bootstrap trust sources', () => {
  it('derives reviewed node/helper pins from root-owned installation + sealed release state', async () => {
    const f = await installedFixture();
    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });

    expect(await source.read(new AbortController().signal)).toEqual(f.review);
  });

  it('uses the core secret only inside the callback and rejects unsafe permissions', async () => {
    const f = await installedFixture();
    const secretPath = `${f.base}/secrets/mcp-internal-secret`;
    await writeFile(secretPath, 'SYNTHETIC_CORE_SECRET\n', { mode: 0o600 });

    const credentials = createRuntimeCoreCredentials({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });

    let observed = '';
    expect(await credentials.withValue(async secret => {
      observed = secret;
      return 'ok';
    })).toBe('ok');
    expect(observed).toBe('SYNTHETIC_CORE_SECRET');

    await chmod(secretPath, 0o644);
    await expect(credentials.withValue(async () => 'unexpected')).rejects.toThrow(/^AUTH_BLOCKED$/);
  });

  it('fails closed when installation approval no longer binds the actual config bytes', async () => {
    const f = await installedFixture();
    await writeFile(`${f.base}/config/service.json`, '{"tampered":true}', { mode: 0o600 });
    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });

    expect(await source.read(new AbortController().signal)).toBeNull();
  });

  it('returns null on cancellation before reading reviewed installed state', async () => {
    const f = await installedFixture();
    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });
    const abort = new AbortController();
    abort.abort();
    expect(await source.read(abort.signal)).toBeNull();
  });

  it('constructs production sources without IO and pins only canonical system paths', () => {
    expect(systemBootstrapPaths).toEqual({
      aclHelper: '/Library/Application Support/HAAR/GramAgent/bootstrap/bin/file-acl',
      installation: '/Library/Application Support/HAAR/GramAgent/config/installation.json',
      config: '/Library/Application Support/HAAR/GramAgent/config/service.json',
      secret: '/Library/Application Support/HAAR/GramAgent/secrets/mcp-internal-secret',
    });
    expect(() => createSystemBootstrapSources()).not.toThrow();
  });
});
