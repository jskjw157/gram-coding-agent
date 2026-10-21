import type { Role, ServiceConfig } from '../../contracts.js';
import type {
  CurrentRelease,
  ReviewedRelease,
  RollbackPorts,
} from '../../rollback-contracts.js';
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
  ServiceHandle,
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
  /** Live release lane: 'current' (default, release B) or 'retained' (live already equals the reviewed target). */
  liveRelease?: 'current' | 'retained';
  /** When true the reviewed retained release is absent (nothing to roll back to). */
  retainedAbsent?: boolean;
  /** Accepted schema sets owned by the retained target release. */
  retainedAccepted?: readonly (readonly number[])[];
  /** When true the database is still open (confirmDatabaseClosed must fail). */
  dbOpen?: boolean;
  /** When true restore writes tampered bytes so reread/verify must fail. */
  restoreCorrupt?: boolean;
}

export type { CurrentRelease, ReviewedRelease, RollbackPorts };
export type ReviewedRollbackPorts = RollbackPorts;

function buildReleaseJsonBytes(input: {
  releaseId: string; sourceCommit: string; lockDigest: string;
  schemaMinimum: number; schemaMaximum: number; tunnelDigest?: string;
}): Buffer {
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    lockDigest: input.lockDigest,
    files: [{ path: 'bin/node', sha256: input.lockDigest, executable: true }],
    coreTools: ['agent_health'],
    schemaCompatibility: { minimum: input.schemaMinimum, maximum: input.schemaMaximum },
  };
  if (input.tunnelDigest !== undefined) manifest.tunnelCompatibilityDigest = input.tunnelDigest;
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
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
  rollbackPorts: ReviewedRollbackPorts;
  calls: string[];
  installedDigest(): Promise<string>;
  currentDigest(): string;
  retainedDigest(): string;
  liveReleaseBytes(): Buffer | null;
  retainedBytes(): Buffer | null;
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
  const calls: string[] = [];
  const stopped = new Map<string, boolean>([['core', true], ['tunnel', true]]);
  let lockHeld = options.lockHeld ?? false;

  const lockDigest = shaBytes(Buffer.from('lab-lock-bytes', 'utf8'));
  const releaseA = buildReleaseJsonBytes({
    releaseId: 'lab-001', sourceCommit: 'a'.repeat(40), lockDigest,
    schemaMinimum: 1, schemaMaximum: 1,
  });
  const releaseB = buildReleaseJsonBytes({
    releaseId: 'lab-002', sourceCommit: 'b'.repeat(40), lockDigest,
    schemaMinimum: 1, schemaMaximum: 1,
  });
  let liveRelease: Buffer | null = !installed
    ? null
    : Buffer.from(options.liveRelease === 'retained' ? releaseA : releaseB);
  const retainedRelease: Buffer | null = installed && !options.retainedAbsent
    ? Buffer.from(releaseA)
    : null;
  const retainedAccepted: readonly (readonly number[])[] = options.retainedAccepted ?? [[1]];
  const digestOfRelease = (bytes: Buffer): string => shaBytes(bytes);

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

  const sharedServices: ServiceHandle = {
    async stop(role: Role) {
      serviceMutations.push(`stop:${role}`);
      calls.push(`stop:${role}`);
      stopped.set(role, true);
      return { ok: true, code: 'OK' as const };
    },
    async start(role: Role) {
      serviceMutations.push(`start:${role}`);
      stopped.set(role, false);
      return { ok: true, code: 'OK' as const };
    },
    async isStopped(role: Role): Promise<boolean> {
      return stopped.get(role) ?? true;
    },
    async ownedHealthy(role: Role): Promise<boolean> {
      return stopped.get(role) === false;
    },
  };

  const rollbackPorts: RollbackPorts = {
    async authorizeLocalAdmin(): Promise<boolean> {
      calls.push('authorize');
      return options.authDenied ? false : true;
    },
    async lock() {
      calls.push('lock');
      if (lockHeld) return { acquired: false, release: async () => undefined };
      lockHeld = true;
      return {
        acquired: true,
        release: async () => { lockHeld = false; },
      };
    },
    async readCurrentRelease(): Promise<CurrentRelease> {
      calls.push('readCurrent');
      return {
        digest: liveRelease === null ? null : digestOfRelease(liveRelease),
        releaseJson: liveRelease === null ? null : Buffer.from(liveRelease),
      };
    },
    async readRetainedRelease(targetReleaseDigest: string): Promise<ReviewedRelease | null> {
      calls.push('readRetained');
      if (retainedRelease === null || digestOfRelease(retainedRelease) !== targetReleaseDigest) return null;
      return {
        digest: digestOfRelease(retainedRelease),
        releaseJson: Buffer.from(retainedRelease),
        acceptedSchema: retainedAccepted,
      };
    },
    services() {
      return sharedServices;
    },
    async confirmDatabaseClosed(): Promise<boolean> {
      calls.push('confirmDb');
      return options.dbOpen === true ? false : true;
    },
    async readClosedSchema(): Promise<ClosedSchemaReading> {
      calls.push('readSchema');
      return ports.readClosedSchema();
    },
    async restoreRetained(target: ReviewedRelease): Promise<void> {
      calls.push('restore');
      if (options.restoreCorrupt === true) {
        const tampered = Buffer.from(target.releaseJson);
        tampered[20] = (tampered[20] as number) ^ 0xff;
        liveRelease = tampered;
        return;
      }
      liveRelease = Buffer.from(target.releaseJson);
    },
    async rereadLiveRelease(): Promise<CurrentRelease> {
      calls.push('verify');
      return {
        digest: liveRelease === null ? null : digestOfRelease(liveRelease),
        releaseJson: liveRelease === null ? null : Buffer.from(liveRelease),
      };
    },
    async readLiveManifest(): Promise<Buffer | null> {
      return ports.publish().readLive('manifest');
    },
    journal() {
      return {
        async read(): Promise<Buffer | null> {
          return ports.journal().read();
        },
        async writeStage(stage: never, body: Buffer): Promise<void> {
          calls.push('journal');
          return ports.journal().writeStage(stage, body);
        },
      };
    },
  };

  return {
    config,
    ports,
    rollbackPorts,
    calls,
    async installedDigest(): Promise<string> {
      const prior = await readPrior();
      if (prior.digest === null) throw new Error('expected installed digest');
      return prior.digest;
    },
    currentDigest(): string {
      if (liveRelease === null) throw new Error('expected live release');
      return digestOfRelease(liveRelease);
    },
    retainedDigest(): string {
      if (retainedRelease === null) throw new Error('expected retained release');
      return digestOfRelease(retainedRelease);
    },
    liveReleaseBytes(): Buffer | null {
      return liveRelease === null ? null : Buffer.from(liveRelease);
    },
    retainedBytes(): Buffer | null {
      return retainedRelease === null ? null : Buffer.from(retainedRelease);
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
