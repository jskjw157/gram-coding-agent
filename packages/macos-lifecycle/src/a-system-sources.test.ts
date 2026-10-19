import { chmod, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { ExecutionLeaseStore, decodeExecution } from './execution-lease.js';
import { decodeHistory, LifecycleStore } from './lifecycle-store.js';
import { createCircuitFilesAt } from './adapters/service-files.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
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

  it('caps the complete installed source read while a configuration ACL read is unresolved', async () => {
    const f = await installedFixture();
    let enter!: () => void; const entered = new Promise<void>(done => { enter = done; });
    let release!: (value: boolean) => void; const gate = new Promise<boolean>(done => { release = done; });
    const source = createInstalledRuntimeReviewSource({ anchor: f.anchor, relative: 'installed',
      ownerUid: f.uid, runtimeUid: f.uid, runtimeGid: f.gid,
      acl: async () => { enter(); return gate; } });
    vi.useFakeTimers();
    const work = source.read(new AbortController().signal);
    await entered;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await work).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    release(true);
    // An already-dispatched read may unwind; no release review is authorized.
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toBeNull();
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

  it('does not create lifecycle history after an in-flight execution creation completes on cancellation', async () => {
    const f = await installedFixture(); await unlink(`${f.base}/run/core.execution.json`);
    await writePublishedJournal(f, null); const controller = new AbortController();
    const initialize = ExecutionLeaseStore.prototype.initializeNew;
    vi.spyOn(ExecutionLeaseStore.prototype, 'initializeNew').mockImplementation(async function(role) {
      await initialize.call(this, role); controller.abort();
    });
    const provisioner = createRuntimeRecordProvisioner({ anchor: f.anchor, relative: 'installed',
      ownerUid: f.uid, runtimeUid: f.uid, runtimeGid: f.gid, acl: f.acl });
    expect(await provisioner.ensure(f.review, controller.signal)).toBe(false);
    expect(decodeExecution(await readFile(`${f.base}/run/core.execution.json`))).toMatchObject({ state: 'FREE', revision: 0 });
    await expect(readFile(`${f.base}/run/core.circuit.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['execution', 'lifecycle'] as const)('does not dispatch a %s CAS when directory revalidation observes cancellation', async kind => {
    const f = await installedFixture(); await unlink(`${f.base}/run/core.execution.json`);
    await writePublishedJournal(f, null); const controller = new AbortController(); let initializing = false;
    if (kind === 'execution') {
      const initialize = ExecutionLeaseStore.prototype.initializeNew;
      vi.spyOn(ExecutionLeaseStore.prototype, 'initializeNew').mockImplementation(async function(role) {
        initializing = true; return initialize.call(this, role);
      });
    } else {
      const initialize = LifecycleStore.prototype.initializeNew;
      vi.spyOn(LifecycleStore.prototype, 'initializeNew').mockImplementation(async function(role, now) {
        initializing = true; return initialize.call(this, role, now);
      });
    }
    const provisioner = createRuntimeRecordProvisioner({ anchor: f.anchor, relative: 'installed',
      ownerUid: f.uid, runtimeUid: f.uid, runtimeGid: f.gid,
      acl: async () => { if (initializing) controller.abort(); return true; } });
    expect(await provisioner.ensure(f.review, controller.signal)).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    const path = kind === 'execution' ? 'core.execution.json' : 'core.circuit.json';
    await expect(readFile(`${f.base}/run/${path}`)).rejects.toMatchObject({ code: 'ENOENT' });
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
