import { createHash } from 'node:crypto';
import { parseConfig } from '../../config.js';
import type { Preview, ServiceConfig } from '../../contracts.js';
import { renderPlist } from '../../launchd-plist.js';
import {
  buildCommittedJournal,
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  shaBytes,
  validateManifestBytes,
} from '../../adapters/install-files.js';
import type {
  ClosedSchemaReading,
  InstallPorts,
  PriorInstall,
  PublishKind,
  Revalidation,
} from '../../installation-transaction/contracts.js';
import { labConfig } from '../fixtures.js';

export { labConfig };

export interface InstallFixtureOptions {
  changedAfterPreview?: boolean;
  closedSchema?: 'unknown' | 'corrupt' | 'missing' | 'unreadable' | number[];
  acceptedSets?: readonly (readonly number[])[];
  interruptAt?: string;
  foreignPrior?: boolean;
  partialPrior?: boolean;
  existingInstall?: boolean;
  tunnelEnabled?: boolean;
  authDenied?: boolean;
  bootstrapFailure?: boolean;
  healthFailure?: boolean;
  lockHeld?: boolean;
  execution?: 'absent' | 'held' | 'ready';
}

function tokenOf(config: ServiceConfig, releaseDigest: string, previousInstallDigest: string | null): string {
  const normalized = parseConfig(config);
  return createHash('sha256').update(JSON.stringify({
    config: normalized, releaseDigest, previousInstallDigest,
  }), 'utf8').digest('hex');
}

function manifestDigestOf(live: Map<PublishKind, Buffer | null>): string | null {
  const manifest = live.get('manifest') ?? null;
  if (manifest === null || !validateManifestBytes(manifest)) return null;
  const config = live.get('configuration') ?? null;
  const core = live.get('core') ?? null;
  const tunnel = live.get('tunnel') ?? null;
  const journal = live.get('journal') ?? null;
  void journal;
  const parsed: unknown = JSON.parse(manifest.toString('utf8'));
  const m = parsed as { configSha256: string; plistSha256: { core: string; tunnel: string | null } };
  if (config === null || shaBytes(config) !== m.configSha256) return null;
  if (core === null || shaBytes(core) !== m.plistSha256.core) return null;
  if (m.plistSha256.tunnel === null) {
    if (tunnel !== null) return null;
  } else if (tunnel === null || shaBytes(tunnel) !== m.plistSha256.tunnel) {
    return null;
  }
  // R7: digest mirrors the unchanged installation reader
  // (inspectInstallation): files in reader order with the real registry
  // observation object (jobs absent + overrides), never a parallel string.
  const tunnelPresent = m.plistSha256.tunnel !== null;
  const registry = {
    jobs: { core: 'absent', tunnel: 'absent' },
    overrides: { core: true, tunnel: tunnelPresent ? true : null },
  };
  const files: Array<[string, string | null]> = [
    ['configuration', config ? shaBytes(config) : null],
    ['manifest', shaBytes(manifest)],
    ['journal', journal ? shaBytes(journal) : null],
    ['core', core ? shaBytes(core) : null],
    ['tunnel', tunnel ? shaBytes(tunnel) : null],
  ];
  return shaBytes(Buffer.from(JSON.stringify({ files, registry }), 'utf8'));
}

export interface InstallFixture {
  preview: Preview;
  config: ServiceConfig;
  ports: InstallPorts;
  snapshotBytes(): Buffer;
  databaseBytes(): Buffer;
  serviceMutations: string[];
  startedPreviousRelease: boolean;
}

export function makeInstallFixture(options: InstallFixtureOptions = {}): InstallFixture {
  const tunnelEnabled = options.tunnelEnabled ?? false;
  const base = labConfig();
  const config: ServiceConfig = tunnelEnabled
    ? parseConfig({ ...base, tunnel: { enabled: true, compatibilityDigest: 'c'.repeat(64), credentialRef: 'test-tunnel-key' } })
    : base;
  const configBytes = canonicalConfigBytes(config);
  const corePlist = expectedPlistBytes(config, 'core') as Buffer;
  const tunnelPlist = expectedPlistBytes(config, 'tunnel');

  const live = new Map<PublishKind, Buffer | null>([
    ['configuration', null], ['core', null], ['tunnel', null], ['manifest', null], ['journal', null],
  ]);
  const staged = new Map<PublishKind, Buffer | null>([
    ['configuration', null], ['core', null], ['tunnel', null], ['manifest', null], ['journal', null],
  ]);

  if (options.existingInstall) {
    const built = buildManifest({
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      configBytes, releaseId: config.releaseId, releaseDigest: config.releaseDigest,
      corePlist, tunnelPlist,
    });
    live.set('configuration', Buffer.from(configBytes));
    live.set('core', Buffer.from(corePlist));
    if (tunnelPlist !== null) live.set('tunnel', Buffer.from(tunnelPlist));
    live.set('manifest', Buffer.from(built.bytes));
    live.set('journal', Buffer.from(buildCommittedJournal(built.bytes)));
  }
  if (options.foreignPrior) {
    live.set('core', Buffer.from(corePlist));
  }
  if (options.partialPrior) {
    live.set('manifest', Buffer.from('{"schemaVersion":1,"broken":true}', 'utf8'));
    live.set('configuration', Buffer.from(configBytes));
    live.set('core', Buffer.from(corePlist));
  }

  const initialPrior = manifestDigestOf(live);
  const preview: Preview = {
    ok: true, code: 'OK',
    configDigest: tokenOf(config, config.releaseDigest, initialPrior),
    previousInstallDigest: initialPrior,
    releaseDigest: config.releaseDigest,
    roles: tunnelEnabled ? ['core', 'tunnel'] : ['core'],
  };

  if (options.changedAfterPreview) {
    // Tamper after review: plant a foreign manifest so revalidation mismatches.
    live.set('manifest', Buffer.from('{"schemaVersion":1,"state":"COMMITTED","tampered":true}', 'utf8'));
  }

  const serviceMutations: string[] = [];
  const stopped = new Map<string, boolean>([['core', true], ['tunnel', true]]);
  const healthyDefault = true;
  let lockHeld = options.lockHeld ?? false;
  let execution = options.execution
    ?? (options.existingInstall ? 'ready' : 'absent');

  const dbPrimary = Buffer.from('lab-db-bytes-v1:' + 'a'.repeat(64), 'utf8');
  const dbWal = Buffer.from('lab-wal-bytes-v1:' + 'b'.repeat(32), 'utf8');
  const dbShm = Buffer.from('lab-shm-bytes-v1', 'utf8');

  const kinds: readonly PublishKind[] = ['configuration', 'core', 'tunnel', 'manifest', 'journal'];
  const copyLive = (): Map<PublishKind, Buffer | null> => new Map(
    kinds.map(kind => {
      const value = live.get(kind) ?? null;
      return [kind, value ? Buffer.from(value) : null] as [PublishKind, Buffer | null];
    }),
  );
  // Pre-operation byte baseline. restorePrior prefers the reviewed prior it
  // is given; when called without one it falls back to these bytes so a
  // restore is always a real byte replacement, never a silent no-op.
  const baseline = copyLive();

  const shouldInterrupt = (point: string): boolean => options.interruptAt === point;

  const checkInterrupt = (point: string): void => {
    if (shouldInterrupt(point)) throw new Error('INTERRUPTED');
  };

  const readPrior = async (): Promise<PriorInstall> => {
    const manifest = live.get('manifest') ?? null;
    const configuration = live.get('configuration') ?? null;
    const core = live.get('core') ?? null;
    const tunnel = live.get('tunnel') ?? null;
    const digest = manifestDigestOf(live);
    let releaseId: string | null = null;
    let releaseDigest: string | null = null;
    if (manifest !== null && validateManifestBytes(manifest)) {
      try {
        const parsed = JSON.parse(manifest.toString('utf8')) as {
          releaseId: string; releaseDigest: string;
          desiredEnabled: { core: boolean; tunnel: boolean };
        };
        releaseId = parsed.releaseId;
        releaseDigest = parsed.releaseDigest;
      } catch { /* foreign below */ }
    }
    const present = {
      core: core !== null && digest !== null,
      tunnel: tunnel !== null && digest !== null,
    };
    // Foreign signals: bytes present without a valid digest.
    if (digest === null && (manifest !== null || configuration !== null
      || (core !== null && !options.foreignPrior) || tunnel !== null)) {
      // foreignPrior case has core without manifest -> present false, digest null.
    }
    return {
      digest,
      manifest: manifest ? Buffer.from(manifest) : null,
      config: configuration ? Buffer.from(configuration) : null,
      corePlist: core ? Buffer.from(core) : null,
      tunnelPlist: tunnel ? Buffer.from(tunnel) : null,
      enabled: { core: false, tunnel: false },
      present,
      releaseId,
      releaseDigest,
    };
  };

  const ports: InstallPorts = {
    async authorizeLocalAdmin(): Promise<boolean> {
      return options.authDenied ? false : true;
    },
    async lock() {
      if (lockHeld) return { acquired: false, release: async () => undefined };
      lockHeld = true;
      return {
        acquired: true,
        release: async () => { lockHeld = false; },
      };
    },
    async revalidate(): Promise<Revalidation> {
      checkInterrupt('revalidate:before');
      const prior = await readPrior();
      const token = tokenOf(config, config.releaseDigest, prior.digest);
      checkInterrupt('revalidate:after');
      return {
        ok: true, code: 'OK', previewToken: token, priorDigest: prior.digest,
        releaseId: config.releaseId, releaseDigest: config.releaseDigest,
        runtime: { name: 'gram-agent', uid: 501, gid: 501 },
      };
    },
    async readPrior(): Promise<PriorInstall> {
      return readPrior();
    },
    journal() {
      return {
        async read(): Promise<Buffer | null> {
          const value = live.get('journal') ?? null;
          return value ? Buffer.from(value) : null;
        },
        async writeStage(stage, body): Promise<void> {
          checkInterrupt(`${stage}:before`);
          if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 262144) {
            throw new Error('INVALID_CONFIG');
          }
          live.set('journal', Buffer.from(body));
          checkInterrupt(`${stage}:after`);
        },
      };
    },
    publish() {
      return {
        async stageFile(kind, bytes): Promise<void> {
          checkInterrupt(`stage:${kind}:before`);
          if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw new Error('INVALID_CONFIG');
          staged.set(kind, Buffer.from(bytes));
          checkInterrupt(`stage:${kind}:after`);
        },
        async publishFile(kind, bytes): Promise<void> {
          checkInterrupt(`publish:${kind}:before`);
          if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw new Error('INVALID_CONFIG');
          const stagedBytes = staged.get(kind) ?? null;
          if (stagedBytes === null || !stagedBytes.equals(bytes)) throw new Error('PARTIAL_INSTALL');
          live.set(kind, Buffer.from(bytes));
          checkInterrupt(`publish:${kind}:after`);
        },
        async readStaged(kind): Promise<Buffer | null> {
          const value = staged.get(kind) ?? null;
          return value ? Buffer.from(value) : null;
        },
        async readLive(kind): Promise<Buffer | null> {
          const value = live.get(kind) ?? null;
          return value ? Buffer.from(value) : null;
        },
      };
    },
    restore() {
      return {
        async restorePrior(prior?: PriorInstall): Promise<void> {
          checkInterrupt('restore:before');
          const source = prior ?? {
            manifest: baseline.get('manifest') ?? null,
            config: baseline.get('configuration') ?? null,
            corePlist: baseline.get('core') ?? null,
            tunnelPlist: baseline.get('tunnel') ?? null,
          };
          const pairs: Array<[PublishKind, Buffer | null]> = [
            ['configuration', source.config ?? null],
            ['core', source.corePlist ?? null],
            ['tunnel', source.tunnelPlist ?? null],
            ['manifest', source.manifest ?? null],
          ];
          for (const [kind, bytes] of pairs) {
            live.set(kind, bytes ? Buffer.from(bytes) : null);
          }
          if (prior === undefined) {
            const journalBytes = baseline.get('journal') ?? null;
            live.set('journal', journalBytes ? Buffer.from(journalBytes) : null);
          }
          staged.clear();
          checkInterrupt('restore:after');
        },
        async removeManifestOwned(kind, expectedBytes): Promise<boolean> {
          checkInterrupt(`remove:${kind}:before`);
          const liveBytes = kind === 'core' ? live.get('core') : live.get('tunnel');
          if (liveBytes === null) return true;
          if (!liveBytes.equals(expectedBytes)) return false;
          if (kind === 'core') live.set('core', null);
          else live.set('tunnel', null);
          // Manifest/config/journal/state/credentials preserved; only the
          // manifest-owned plist is removed. Second uninstall is a no-op OK.
          checkInterrupt(`remove:${kind}:after`);
          return true;
        },
        async resetExecutionRecords(): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          checkInterrupt('reset:before');
          if (await ports.services().isStopped('core') !== true) return { ok: false, code: 'PARTIAL_INSTALL' };
          execution = 'ready';
          checkInterrupt('reset:after');
          return { ok: true, code: 'OK' };
        },
        async ensureExecutionAbsentOnly(isNewInstall): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          if (isNewInstall) {
            return execution === 'absent'
              ? { ok: true, code: 'OK' }
              : { ok: false, code: 'PARTIAL_INSTALL' };
          }
          return execution !== 'absent'
            ? { ok: true, code: 'OK' }
            : { ok: false, code: 'PARTIAL_INSTALL' };
        },
      };
    },
    services() {
      return {
        async stop(role): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' | 'FOREIGN_SERVICE' }> {
          serviceMutations.push(`stop:${role}`);
          checkInterrupt(`stop:${role}:before`);
          stopped.set(role, true);
          checkInterrupt(`stop:${role}:after`);
          return { ok: true, code: 'OK' };
        },
        async start(role): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          serviceMutations.push(`start:${role}`);
          checkInterrupt(`start:${role}:before`);
          if (options.bootstrapFailure) return { ok: false, code: 'PARTIAL_INSTALL' };
          stopped.set(role, false);
          checkInterrupt(`start:${role}:after`);
          return { ok: true, code: 'OK' };
        },
        async isStopped(role): Promise<boolean> {
          return stopped.get(role) ?? true;
        },
        async ownedHealthy(role): Promise<boolean> {
          void role;
          if (options.healthFailure) return false;
          return healthyDefault && stopped.get(role) === false;
        },
      };
    },
    async readClosedSchema(): Promise<ClosedSchemaReading> {
      const spec = options.closedSchema ?? 'absent';
      if (spec === 'unknown') {
        return { state: 'present', versions: null, raw: Buffer.from(dbPrimary) };
      }
      if (spec === 'corrupt') return { state: 'corrupt', versions: null, raw: Buffer.from(dbPrimary) };
      if (spec === 'unreadable') return { state: 'unreadable', versions: null, raw: null };
      if (spec === 'missing') return { state: 'absent', versions: null, raw: null };
      return { state: 'present', versions: [...spec], raw: Buffer.from(dbPrimary) };
    },
    async trustedAcceptedSets(): Promise<readonly (readonly number[])[] | null> {
      if (options.acceptedSets !== undefined) return options.acceptedSets;
      if (options.closedSchema === 'unknown' || options.closedSchema === 'corrupt'
        || options.closedSchema === 'unreadable' || options.closedSchema === 'missing') {
        return [[1]];
      }
      return [[1]];
    },
  };

  return {
    preview,
    config,
    ports,
    snapshotBytes(): Buffer {
      const entries: Array<[string, string | null]> = (['configuration', 'core', 'tunnel', 'manifest', 'journal'] as PublishKind[])
        .map(kind => {
          const value = live.get(kind) ?? null;
          return [kind, value ? shaBytes(value) : null] as [string, string | null];
        });
      return Buffer.from(JSON.stringify({
        files: entries,
        prior: manifestDigestOf(live),
        services: { core: stopped.get('core') ?? true, tunnel: stopped.get('tunnel') ?? true },
        execution,
      }), 'utf8');
    },
    databaseBytes(): Buffer {
      return Buffer.concat([dbPrimary, dbWal, dbShm]);
    },
    serviceMutations,
    startedPreviousRelease: false,
  };
}

export function previewTokenFor(config: ServiceConfig, previousInstallDigest: string | null): string {
  return tokenOf(config, parseConfig(config).releaseDigest, previousInstallDigest);
}

export function renderExpectedPlist(config: ServiceConfig, role: 'core' | 'tunnel'): Buffer | null {
  return expectedPlistBytes(config, role);
}

export { renderPlist };
