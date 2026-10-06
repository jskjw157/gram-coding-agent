import { chmod, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInstalledRuntimeReviewSource,
  createRuntimeCoreCredentials,
  createRuntimeRecordProvisioner,
  createSystemBootstrapSources,
  systemBootstrapPaths,
} from './a-system-sources.js';
import {
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  buildIntermediateJournal,
  FIXED_FILES,
  shaBytes,
} from './adapters/install-files.js';
import { decodeExecution } from './execution-lease.js';
import { decodeHistory, LifecycleStore } from './lifecycle-store.js';
import { createCircuitFilesAt } from './adapters/service-files.js';
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


async function writePublishedJournal(
  f: Awaited<ReturnType<typeof installedFixture>>,
  previousDigest: string | null,
) {
  const installation = await readFile(`${f.base}/config/installation.json`);
  const journal = buildIntermediateJournal('PUBLISHED', {
    previousDigest,
    nextDigest: shaBytes(installation),
    inventory: Object.values(FIXED_FILES),
  });
  await writeFile(`${f.base}/config/install-journal.json`, journal, { mode: 0o600 });
}

describe('A fixed bootstrap trust sources', () => {
  it('derives reviewed node/helper pins from root-owned installation + sealed release state', async () => {
    const f = await installedFixture();
    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
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
      runtimeGid: f.gid,
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
      runtimeGid: f.gid,
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
      runtimeGid: f.gid,
      acl: f.acl,
    });
    const abort = new AbortController();
    abort.abort();
    expect(await source.read(abort.signal)).toBeNull();
  });


  it('create-only provisions missing first-install execution/circuit records under a fresh PUBLISHED journal', async () => {
    const f = await installedFixture();
    await unlink(`${f.base}/run/core.execution.json`);
    await writePublishedJournal(f, null);

    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    const review = await source.read(new AbortController().signal);
    if (review === null) throw new Error('missing reviewed install');

    const provisioner = createRuntimeRecordProvisioner({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    expect(await provisioner.ensure(review, new AbortController().signal)).toBe(true);

    expect(decodeExecution(await readFile(`${f.base}/run/core.execution.json`))).toMatchObject({
      role: 'core',
      state: 'FREE',
      revision: 0,
      token: null,
      generation: null,
    });
    expect(decodeHistory(await readFile(`${f.base}/run/core.circuit.json`))).toMatchObject({
      blocked: false,
      exitsMs: [],
      lastGeneration: null,
      activeAttempt: null,
    });

    const executionBefore = await readFile(`${f.base}/run/core.execution.json`);
    const circuitBefore = await readFile(`${f.base}/run/core.circuit.json`);
    expect(await provisioner.ensure(review, new AbortController().signal)).toBe(true);
    expect(await readFile(`${f.base}/run/core.execution.json`)).toEqual(executionBefore);
    expect(await readFile(`${f.base}/run/core.circuit.json`)).toEqual(circuitBefore);
  });

  it('does not manufacture missing history for an upgrade journal', async () => {
    const f = await installedFixture();
    await unlink(`${f.base}/run/core.execution.json`);
    await writePublishedJournal(f, 'a'.repeat(64));

    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    const review = await source.read(new AbortController().signal);
    if (review === null) throw new Error('missing reviewed install');

    const provisioner = createRuntimeRecordProvisioner({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    expect(await provisioner.ensure(review, new AbortController().signal)).toBe(false);
    await expect(readFile(`${f.base}/run/core.execution.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${f.base}/run/core.circuit.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts complete existing durable records without requiring a fresh-install journal', async () => {
    const f = await installedFixture();
    const lifecycle = new LifecycleStore(createCircuitFilesAt(f.runPolicy));
    await lifecycle.initializeNew('core', 1);

    const source = createInstalledRuntimeReviewSource({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    const review = await source.read(new AbortController().signal);
    if (review === null) throw new Error('missing reviewed install');

    const provisioner = createRuntimeRecordProvisioner({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      runtimeGid: f.gid,
      acl: f.acl,
    });
    expect(await provisioner.ensure(review, new AbortController().signal)).toBe(true);
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
