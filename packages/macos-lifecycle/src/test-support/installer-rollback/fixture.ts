import type { ServiceConfig } from '../../contracts.js';
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

export type { ServiceConfig };

export interface RollbackFixtureOptions {
  installed?: boolean;
  foreignPrior?: boolean;
  closedSchema?: 'unknown' | 'corrupt' | 'unreadable' | 'missing' | number[];
  acceptedSets?: readonly (readonly number[])[];
  authDenied?: boolean;
  lockHeld?: boolean;
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

export interface RollbackFixture {
  config: ServiceConfig;
  ports: InstallPorts;
  installedDigest(): Promise<string>;
  snapshotBytes(): Buffer;
  databaseBytes(): Buffer;
  serviceMutations: string[];
}

/** Rollback-scoped fixture. Independent of the installer fixture: builds a
 * committed lab install (or a chosen prior shape) with byte-level live maps
 * plus a stopped lab DB that is never copied or deleted by rollback.
 */
export function makeRollbackFixture(options: RollbackFixtureOptions = {}): RollbackFixture {
  const installed = options.installed ?? true;
  const config: ServiceConfig = labConfig();
  const configBytes = canonicalConfigBytes(config);
  const corePlist = expectedPlistBytes(config, 'core') as Buffer;
  const tunnelPlist = expectedPlistBytes(config, 'tunnel');

  const live = new Map<PublishKind, Buffer | null>([
    ['configuration', null], ['core', null], ['tunnel', null], ['manifest', null], ['journal', null],
  ]);
  const staged = new Map<PublishKind, Buffer | null>([
    ['configuration', null], ['core', null], ['tunnel', null], ['manifest', null], ['journal', null],
  ]);

  if (installed && !options.foreignPrior) {
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

  const serviceMutations: string[] = [];
  const stopped = new Map<string, boolean>([['core', true], ['tunnel', true]]);
  let lockHeld = options.lockHeld ?? false;

  const dbPrimary = Buffer.from('lab-db-bytes-v1:' + 'a'.repeat(64), 'utf8');
  const dbWal = Buffer.from('lab-wal-bytes-v1:' + 'b'.repeat(32), 'utf8');
  const dbShm = Buffer.from('lab-shm-bytes-v1', 'utf8');

  const readPrior = async (): Promise<PriorInstall> => {
    const manifest = live.get('manifest') ?? null;
    const configuration = live.get('configuration') ?? null;
    const core = live.get('core') ?? null;
    const tunnel = live.get('tunnel') ?? null;
    const digest = manifestDigestOf(live);
    return {
      digest,
      manifest: manifest ? Buffer.from(manifest) : null,
      config: configuration ? Buffer.from(configuration) : null,
      corePlist: core ? Buffer.from(core) : null,
      tunnelPlist: tunnel ? Buffer.from(tunnel) : null,
      enabled: { core: false, tunnel: false },
      present: {
        core: core !== null && digest !== null,
        tunnel: tunnel !== null && digest !== null,
      },
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
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
      const prior = await readPrior();
      return {
        ok: true, code: 'OK', previewToken: '', priorDigest: prior.digest,
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
          if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 262144) {
            throw new Error('INVALID_CONFIG');
          }
          live.set('journal', Buffer.from(body));
        },
      };
    },
    publish() {
      return {
        async stageFile(kind, bytes): Promise<void> {
          if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw new Error('INVALID_CONFIG');
          staged.set(kind, Buffer.from(bytes));
        },
        async publishFile(kind, bytes): Promise<void> {
          if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw new Error('INVALID_CONFIG');
          const stagedBytes = staged.get(kind) ?? null;
          if (stagedBytes === null || !stagedBytes.equals(bytes)) throw new Error('PARTIAL_INSTALL');
          live.set(kind, Buffer.from(bytes));
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
        async restorePrior(): Promise<void> {
          // No-op in fixture: live bytes already hold the reviewed target.
        },
        async removeManifestOwned(kind, expectedBytes): Promise<boolean> {
          const liveBytes = kind === 'core' ? live.get('core') : live.get('tunnel');
          if (liveBytes === null || liveBytes === undefined) return true;
          if (!liveBytes.equals(expectedBytes)) return false;
          if (kind === 'core') live.set('core', null);
          else live.set('tunnel', null);
          return true;
        },
        async resetExecutionRecords(): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          return { ok: true, code: 'OK' };
        },
        async ensureExecutionAbsentOnly(): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          return { ok: true, code: 'OK' };
        },
      };
    },
    services() {
      return {
        async stop(role): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' | 'FOREIGN_SERVICE' }> {
          serviceMutations.push(`stop:${role}`);
          stopped.set(role, true);
          return { ok: true, code: 'OK' };
        },
        async start(role): Promise<{ ok: boolean; code: 'OK' | 'PARTIAL_INSTALL' }> {
          serviceMutations.push(`start:${role}`);
          stopped.set(role, false);
          return { ok: true, code: 'OK' };
        },
        async isStopped(role): Promise<boolean> {
          return stopped.get(role) ?? true;
        },
        async ownedHealthy(role): Promise<boolean> {
          void role;
          return stopped.get(role) === false;
        },
      };
    },
    async readClosedSchema(): Promise<ClosedSchemaReading> {
      const spec = options.closedSchema ?? [1];
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
      return [[1]];
    },
  };

  return {
    config,
    ports,
    async installedDigest(): Promise<string> {
      const prior = await readPrior();
      if (prior.digest === null) throw new Error('expected installed digest');
      return prior.digest;
    },
    snapshotBytes(): Buffer {
      const entries: Array<[string, string | null]> = (['configuration', 'core', 'tunnel', 'manifest', 'journal'] as PublishKind[])
        .map((kind) => {
          const value = live.get(kind) ?? null;
          return [kind, value ? shaBytes(value) : null] as [string, string | null];
        });
      return Buffer.from(JSON.stringify({ files: entries, prior: manifestDigestOf(live) }), 'utf8');
    },
    databaseBytes(): Buffer {
      return Buffer.concat([dbPrimary, dbWal, dbShm]);
    },
    serviceMutations,
  };
}
