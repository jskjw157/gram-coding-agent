import { afterEach, describe, expect, it } from 'vitest';
import { chmod, chown, link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseConfig } from './config.js';
import {
  buildCommittedJournal,
  buildIntermediateJournal,
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  FIXED_FILES,
  shaBytes,
} from './adapters/install-files.js';
import { createNativeInstallStorageAt } from './a-native-storage.js';
import { createPublishedResumePortsAt, type PublishedResumeOptions } from './a-published-resume.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { resumeFreshPublished } from './published-resume.js';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const uid = process.getuid?.() ?? -1;
const gid = process.getgid?.() ?? -1;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gram native resume ')));
  roots.push(root);
  const layout = { anchor: root, relative: 'app', ownerUid: uid };
  const acl = async () => true;
  for (const name of ['app/config', 'app/run', 'app/state', 'app/logs', 'app/secrets', 'launchd'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const paths = [
    'bin/node',
    'apps/agent/dist/main.js',
    'packages/macos-lifecycle/dist/supervisor-cli.js',
    'pnpm-lock.yaml',
  ];
  const release = join(root, 'app/releases/lab-resume');
  for (const name of paths) {
    await mkdir(dirname(join(release, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(release, name), name, { mode: name === 'bin/node' ? 0o700 : 0o600 });
  }
  const releaseBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      releaseId: 'lab-resume',
      sourceCommit: 'a'.repeat(40),
      lockDigest: sha('pnpm-lock.yaml'),
      files: paths.map((path) => ({ path, sha256: sha(path), executable: path === 'bin/node' })),
      coreTools: ['agent_health'],
      schemaCompatibility: { minimum: 1, maximum: 1 },
    }),
  );
  await writeFile(join(release, 'release.json'), releaseBytes, { mode: 0o600 });
  const config = parseConfig({
    schemaVersion: 1,
    mode: 'LAB_ONLY',
    runtimeUser: 'gram-agent',
    releaseId: 'lab-resume',
    releaseDigest: sha(releaseBytes),
    tunnel: { enabled: false },
  });
  const configuration = canonicalConfigBytes(config);
  const core = expectedPlistBytes(config, 'core');
  if (!core) throw new Error('FIXTURE');
  const manifest = buildManifest({
    runtime: { name: 'gram-agent', uid, gid },
    configBytes: configuration,
    releaseId: config.releaseId,
    releaseDigest: config.releaseDigest,
    corePlist: core,
    tunnelPlist: null,
  });
  const journal = buildIntermediateJournal('PUBLISHED', {
    previousDigest: null,
    nextDigest: manifest.sha,
    inventory: Object.values(FIXED_FILES),
  });
  const storage = createNativeInstallStorageAt({
    anchor: root,
    ownerUid: uid,
    appRelative: 'app',
    launchdRelative: 'launchd',
    acl,
  });
  for (const [kind, bytes] of [
    ['configuration', configuration],
    ['core', core],
    ['manifest', manifest.bytes],
  ] as const) {
    await storage.publish.stageFile(kind, bytes);
    await storage.publish.publishFile(kind, bytes);
  }
  await storage.publish.stageFile('journal', buildCommittedJournal(manifest.bytes));
  await storage.journal.writeStage('PUBLISHED', journal);
  await writeFile(join(root, 'app/secrets/mcp-internal-secret'), 'SYNTHETIC_UNREAD_KEY', { mode: 0o600 });
  // Darwin inherits the external parent GID; model the service key's actual
  // primary group explicitly inside this owned synthetic fixture.
  await chown(join(root, 'app/secrets/mcp-internal-secret'), uid, gid);
  const directories = await inspectRuntimeDirectories(layout, uid, acl, new AbortController().signal);
  const execution = new ExecutionLeaseStore(createExecutionFilesAt(directories.runPolicy));
  await execution.initializeNew('core');
  await createRuntimeStores(directories).lifecycle.initializeNew('core', Date.now());
  let running = false;
  let stoppedProof = true;
  const mutations: string[] = [];
  const options: PublishedResumeOptions = {
    layout,
    acl,
    storage,
    pins: { manifestDigest: manifest.sha, journalDigest: shaBytes(journal), releaseDigest: config.releaseDigest },
    account: async () => ({ name: 'gram-agent' as const, uid, gid, admin: false, groupsComplete: true }),
    registry: async () => ({
      jobs: { core: running ? ('present' as const) : ('absent' as const), tunnel: 'absent' as const },
      overrides: { core: !running, tunnel: null },
    }),
    ports: async () => ({ core: running ? ('occupied' as const) : ('free' as const), tunnel: 'free' as const }),
    authorizeLocalAdmin: async () => true,
    services: {
      async start() {
        mutations.push('start:core');
        running = true;
        return { ok: true, code: 'OK' as const };
      },
      async stop() {
        mutations.push('stop:core');
        running = false;
        return { ok: true, code: 'OK' as const };
      },
      async isStopped() {
        return !running;
      },
      async ownedHealthy() {
        return running;
      },
    },
    startAttempt: {
      async capture() {
        return running ? 'c'.repeat(64) : null;
      },
      async current(_pin: string, expected: 'OWNED' | 'FOREIGN') {
        return expected === 'OWNED' ? running : !running;
      },
    },
    proof: {
      async capture() {
        return running ? 'b'.repeat(64) : null;
      },
      async current(_pin: string, expected: 'OWNED' | 'FOREIGN') {
        return expected === 'OWNED' ? running : !running && stoppedProof;
      },
    },
  };
  return {
    root,
    storage,
    options,
    mutations,
    execution,
    setStoppedProof: (value: boolean) => {
      stoppedProof = value;
    },
    journal,
    manifest,
  };
}
describe('native fresh PUBLISHED byte and metadata review', () => {
  it('uses the actual consumed-stage layout, proves health/stop, and commits only the journal', async () => {
    const f = await fixture();
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    expect(review).not.toBeNull();
    const before = await f.storage.readLive('manifest');
    const staged = await f.storage.publish.readStaged('journal');
    const result = await resumeFreshPublished(review?.transactionDigest ?? '', ports);
    expect(result).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    expect(await f.storage.readLive('journal')).toEqual(staged);
    expect(await f.storage.publish.readStaged('journal')).toBeNull();
    expect(await f.storage.readLive('manifest')).toEqual(before);
    expect(f.mutations).toEqual(['start:core', 'stop:core']);
  });
  it('drains residual sockets after exact stopped proof without repeating stop', async () => {
    const f = await fixture();
    let stopped = false;
    let observations = 0;
    const stop = f.options.services.stop;
    f.options.services.stop = async (role) => {
      const result = await stop(role);
      stopped = true;
      return result;
    };
    const ports = f.options.ports;
    f.options.ports = async () => (stopped && observations++ < 2 ? { core: 'occupied', tunnel: 'free' } : ports());
    const resume = createPublishedResumePortsAt(f.options);
    const review = await resume.review();
    expect((await resumeFreshPublished(review?.transactionDigest ?? '', resume)).ok).toBe(true);
    expect(f.mutations).toEqual(['start:core', 'stop:core']);
  });
  it('refuses stale public pins without any service mutation', async () => {
    const f = await fixture();
    f.options.pins.manifestDigest = '0'.repeat(64);
    expect(await createPublishedResumePortsAt(f.options).review()).toBeNull();
    expect(f.mutations).toEqual([]);
  });
  it('refuses leftover non-journal staging instead of rewriting or deleting it', async () => {
    const f = await fixture();
    await f.storage.publish.stageFile('core', Buffer.from('foreign'));
    expect(await createPublishedResumePortsAt(f.options).review()).toBeNull();
    expect(await f.storage.readLive('journal')).toEqual(f.journal);
    expect(f.mutations).toEqual([]);
  });
  it('keeps STARTED evidence when exact stopped proof is unknown', async () => {
    const f = await fixture();
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    f.setStoppedProof(false);
    expect((await resumeFreshPublished(review?.transactionDigest ?? '', ports)).ok).toBe(false);
    expect(JSON.parse((await f.storage.readLive('journal'))?.toString() ?? '{}').stage).toBe('STARTED');
    expect(await f.storage.publish.readStaged('journal')).toEqual(buildCommittedJournal(f.manifest.bytes));
  });
  it('does not stop a label after Core ownership becomes unknown', async () => {
    const f = await fixture();
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    await ports.startCore();
    const pin = await ports.ownedCore();
    await ports.markStarted(review?.transactionDigest ?? '');
    f.options.proof.current = async () => false;
    expect(await ports.parkCore(pin ?? '')).toBe(false);
    expect(f.mutations).toEqual(['start:core']);
  });
  it('does not attempt compensation when neither Core nor supervisor start-attempt ownership is known', async () => {
    const f = await fixture();
    const ports = createPublishedResumePortsAt(f.options);
    await ports.review();
    await ports.startCore();
    f.options.proof.capture = async () => null;
    f.options.startAttempt.current = async () => false;
    expect(await ports.compensateCore()).toBe(false);
    expect(f.mutations).toEqual(['start:core']);
  });

  it.each(['mode', 'hardlink'])('refuses unsafe synthetic key metadata: %s', async (kind) => {
    const f = await fixture();
    const key = join(f.root, 'app/secrets/mcp-internal-secret');
    if (kind === 'mode') await chmod(key, 0o640);
    else await link(key, join(f.root, 'app/secrets/key-alias'));
    expect(await createPublishedResumePortsAt(f.options).review()).toBeNull();
    expect(f.mutations).toEqual([]);
  });
  it('binds key metadata to the reviewed token across authorized revalidation', async () => {
    const f = await fixture();
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    await writeFile(join(f.root, 'app/secrets/mcp-internal-secret'), 'CHANGED_SYNTHETIC_KEY');
    expect((await resumeFreshPublished(review?.transactionDigest ?? '', ports)).code).toBe('CONFIG_CHANGED');
    expect(f.mutations).toEqual([]);
  });
  it('refuses an existing execution reservation instead of resetting it', async () => {
    const f = await fixture();
    await f.execution.acquire('core', 'existing-generation', 'a'.repeat(64), f.options.pins.releaseDigest);
    const before = await f.execution.read('core');
    expect(await createPublishedResumePortsAt(f.options).review()).toBeNull();
    expect(await f.execution.read('core')).toEqual(before);
    expect(f.mutations).toEqual([]);
  });
  it.each(['STARTED', 'COMMITTED'])(
    'reports an uncertain %s write when durable publication precedes a readback failure',
    async (stage) => {
      const f = await fixture();
      let failReads = 0;
      const storage = {
        ...f.storage,
        journal: {
          ...f.storage.journal,
          async read() {
            if (failReads > 0) {
              failReads--;
              throw new Error('SYNTHETIC_READBACK_FAILURE');
            }
            return f.storage.journal.read();
          },
          async writeStage(name: Parameters<typeof f.storage.journal.writeStage>[0], bytes: Buffer) {
            await f.storage.journal.writeStage(name, bytes);
            if (stage === 'STARTED' && name === 'STARTED') failReads = 1;
          },
        },
        publish: {
          ...f.storage.publish,
          async publishFile(kind: Parameters<typeof f.storage.publish.publishFile>[0], bytes: Buffer) {
            await f.storage.publish.publishFile(kind, bytes);
            if (stage === 'COMMITTED' && kind === 'journal') failReads = 1;
          },
        },
      };
      const ports = createPublishedResumePortsAt({ ...f.options, storage });
      const review = await ports.review();
      const result = await resumeFreshPublished(review?.transactionDigest ?? '', ports);
      expect(result).toEqual({ ok: false, code: 'PARTIAL_INSTALL', uncertain: true });
      expect(JSON.parse((await f.storage.readLive('journal'))?.toString() ?? '{}').stage).toBe(stage);
    },
  );
  it.each(['refused', 'throw'] as const)('never repeats a park stop after %s outcome', async (kind) => {
    const f = await fixture();
    let attempts = 0;
    f.options.services.stop = async () => {
      attempts++;
      if (kind === 'throw') throw new Error('SYNTHETIC_STOP');
      return { ok: false, code: 'PARTIAL_INSTALL' };
    };
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    const result = await resumeFreshPublished(review?.transactionDigest ?? '', ports);
    expect(result.ok).toBe(false);
    expect(result.compensationUnknown).toBe(true);
    expect(attempts).toBe(1);
    expect(JSON.parse((await f.storage.readLive('journal'))?.toString() ?? '{}').stage).toBe('STARTED');
  });
  it('reports failed compensation without pretending the started Core was stopped', async () => {
    const f = await fixture();
    f.options.services.ownedHealthy = async () => false;
    f.options.services.stop = async () => ({ ok: false, code: 'PARTIAL_INSTALL' });
    const ports = createPublishedResumePortsAt(f.options);
    const review = await ports.review();
    const result = await resumeFreshPublished(review?.transactionDigest ?? '', ports);
    expect(result.compensationUnknown).toBe(true);
    expect(result.ok).toBe(false);
    expect(await f.storage.readLive('journal')).toEqual(f.journal);
  });
});
