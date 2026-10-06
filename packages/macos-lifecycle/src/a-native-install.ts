import type { ServiceConfig } from './contracts.js';
import { root } from './contracts.js';
import { parseConfig } from './config.js';
import { preview } from './preflight.js';
import { inspectInstallation, type InstallFile, type InstallationIO } from './installation-inspection.js';
import { inspectRelease } from './release-inspection.js';
import { inspectMacAccount } from './adapters/macos-inspection.js';
import { inspectMacRegistry, type RegistryObservation } from './adapters/macos-service-probes.js';
import { createMacInspector } from './adapters/native-inspector.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { buildCommittedJournal, buildManifest, canonicalConfigBytes, expectedPlistBytes } from './adapters/install-files.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type {
  ClosedSchemaReading,
  InstallPorts,
  InstallResult,
  RestorePort,
  PriorInstall,
  PublishKind,
  Revalidation,
} from './installation-transaction/contracts.js';
import { createSystemBootstrapAclProbe } from './a-system-sources.js';
import {
  createSystemNativeInstallStorage,
  type NativeInstallStorage,
} from './a-native-storage.js';
import { createSystemServiceHandle, normalizeAbsentSystemServiceOverride } from './a-native-services.js';
import { createInstalledHealthObserver } from './a-native-observer.js';

const fileMap: Readonly<Record<InstallFile, PublishKind>> = Object.freeze({
  configuration: 'configuration',
  manifest: 'manifest',
  journal: 'journal',
  core: 'core',
  tunnel: 'tunnel',
});

function missingCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && Object.getOwnPropertyDescriptor(error, 'message')?.value === code;
}

async function priorFromStorage(
  storage: NativeInstallStorage,
  acl: AclProbe,
  registryReader: () => Promise<RegistryObservation | null> = inspectMacRegistry,
): Promise<PriorInstall> {
  const account = await inspectMacAccount();
  if (account === null || account.admin !== false) throw new Error('ACCOUNT_INVALID');

  const io: InstallationIO = {
    presence: async file => storage.presence(fileMap[file]),
    read: async (file, limit) => {
      const bytes = await storage.readLive(fileMap[file]);
      if (bytes === null || bytes.length === 0 || bytes.length > limit) throw new Error('FOREIGN_SERVICE');
      return Buffer.from(bytes);
    },
    registry: registryReader,
    async verifyRelease(input) {
      try {
        const config = parseConfig(input);
        const files = createTrustedFiles(
          '/',
          0,
          acl,
          `${root.slice(1)}/releases/${config.releaseId}`,
        );
        const result = await inspectRelease(config, config.releaseDigest, files);
        return result.verified === true && result.digest === config.releaseDigest;
      } catch {
        return false;
      }
    },
  };

  const evidence = await inspectInstallation(account, io);
  const manifest = await storage.readLive('manifest');
  const configBytes = await storage.readLive('configuration');
  const corePlist = await storage.readLive('core');
  const tunnelPlist = await storage.readLive('tunnel');

  if (evidence.digest === null) {
    return {
      digest: null,
      manifest: null,
      config: null,
      corePlist: null,
      tunnelPlist: null,
      enabled: { ...evidence.enabled },
      present: { ...evidence.present },
      releaseId: null,
      releaseDigest: null,
    };
  }
  if (manifest === null || configBytes === null || corePlist === null) throw new Error('FOREIGN_SERVICE');
  const config = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
  return {
    digest: evidence.digest,
    manifest: Buffer.from(manifest),
    config: Buffer.from(configBytes),
    corePlist: Buffer.from(corePlist),
    tunnelPlist: tunnelPlist === null ? null : Buffer.from(tunnelPlist),
    enabled: { ...evidence.enabled },
    present: { ...evidence.present },
    releaseId: config.releaseId,
    releaseDigest: config.releaseDigest,
  };
}

async function runningPriorFromStorage(
  storage: NativeInstallStorage,
  acl: AclProbe,
  input: ServiceConfig,
): Promise<PriorInstall> {
  const config = parseConfig(input);
  const before = await inspectMacRegistry();
  if (before === null
    || before.jobs.core !== 'present'
    || before.overrides.core !== false
    || (config.tunnel.enabled
      ? before.jobs.tunnel !== 'present' || before.overrides.tunnel !== false
      : before.jobs.tunnel !== 'absent' || before.overrides.tunnel === true)) {
    throw new Error('FOREIGN_SERVICE');
  }

  // Reconstruct the exact stopped/disabled registry snapshot that produced the
  // review token before start. An absent tunnel may carry the measured inert
  // explicit enabled/false override; preserve that value in the baseline.
  const baseline: RegistryObservation = {
    jobs: { core: 'absent', tunnel: 'absent' },
    overrides: {
      core: true,
      tunnel: config.tunnel.enabled ? true : before.overrides.tunnel,
    },
  };
  const prior = await priorFromStorage(storage, acl, async () => structuredClone(baseline));
  if (prior.digest === null || prior.releaseId !== config.releaseId
    || prior.releaseDigest !== config.releaseDigest) throw new Error('FOREIGN_SERVICE');

  const observer = createInstalledHealthObserver(acl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    if (await observer.healthy('core', controller.signal) !== true) throw new Error('FOREIGN_SERVICE');
    if (config.tunnel.enabled
      && await observer.healthy('tunnel', controller.signal) !== true) throw new Error('FOREIGN_SERVICE');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  const after = await inspectMacRegistry();
  if (after === null || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('FOREIGN_SERVICE');
  }
  return prior;
}

async function executionState(
  config: ServiceConfig,
  acl: AclProbe,
  isNewInstall: boolean,
): Promise<InstallResult> {
  const account = await inspectMacAccount();
  if (account === null || account.admin !== false) return { ok: false, code: 'ACCOUNT_INVALID' };
  try {
    const directories = await inspectRuntimeDirectories(
      { anchor: '/', relative: root.slice(1), ownerUid: 0 },
      account.uid,
      acl,
      new AbortController().signal,
    );
    const execution = new ExecutionLeaseStore(createExecutionFilesAt(directories.runPolicy));
    const lifecycle = createRuntimeStores(directories).lifecycle;
    const roles = parseConfig(config).tunnel.enabled
      ? (['core', 'tunnel'] as const)
      : (['core'] as const);

    for (const role of roles) {
      let executionMissing = false;
      try {
        await execution.read(role);
      } catch (error) {
        if (!missingCode(error, 'MISSING_EXECUTION')) return { ok: false, code: 'PARTIAL_INSTALL' };
        executionMissing = true;
      }
      let lifecycleMissing = false;
      try {
        await lifecycle.read(role);
      } catch (error) {
        if (!missingCode(error, 'MISSING_HISTORY')) return { ok: false, code: 'PARTIAL_INSTALL' };
        lifecycleMissing = true;
      }

      if (isNewInstall) {
        if (!executionMissing || !lifecycleMissing) return { ok: false, code: 'PARTIAL_INSTALL' };
      } else if (executionMissing || lifecycleMissing) {
        return { ok: false, code: 'PARTIAL_INSTALL' };
      }
    }
    return { ok: true, code: 'OK' };
  } catch {
    return { ok: false, code: 'PARTIAL_INSTALL' };
  }
}

export interface NativeInstallPortsOptions {
  readonly config: ServiceConfig;
  readonly acl: AclProbe;
  readonly storage: NativeInstallStorage;
}

export function createNativeInstallPortsAt(options: NativeInstallPortsOptions): InstallPorts {
  const config = parseConfig(options.config);
  const acl = options.acl;
  const storage = options.storage;
  const services = createSystemServiceHandle(acl);

  const currentPreview = async () => preview(
    config,
    config.releaseDigest,
    createMacInspector(acl),
  );

  return Object.freeze({
    async authorizeLocalAdmin() {
      return process.platform === 'darwin'
        && process.arch === 'arm64'
        && (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;
    },
    lock: () => storage.lock(),
    async revalidate(): Promise<Revalidation> {
      const account = await inspectMacAccount();
      const result = await currentPreview();
      if (account === null || account.admin !== false || result.ok !== true) {
        return {
          ok: false,
          code: result.ok ? 'ACCOUNT_INVALID' : result.code,
          previewToken: '',
          priorDigest: null,
          releaseId: config.releaseId,
          releaseDigest: config.releaseDigest,
          runtime: { name: 'gram-agent', uid: 0, gid: 0 },
        };
      }
      return {
        ok: true,
        code: 'OK',
        previewToken: result.configDigest,
        priorDigest: result.previousInstallDigest,
        releaseId: config.releaseId,
        releaseDigest: config.releaseDigest,
        runtime: { name: 'gram-agent', uid: account.uid, gid: account.gid },
      };
    },
    readPrior: () => priorFromStorage(storage, acl),
    journal: () => storage.journal,
    publish: () => storage.publish,
    restore(): RestorePort {
      return {
        async restorePrior(prior: PriorInstall): Promise<void> {
          void prior;
          throw new Error('PARTIAL_INSTALL');
        },
        async removeManifestOwned(kind: 'core' | 'tunnel', expectedBytes: Buffer): Promise<boolean> {
          const finalRole = config.tunnel.enabled ? 'tunnel' : 'core';
          let cleanup: {
            configBytes: Buffer;
            manifestBytes: Buffer;
            journalBytes: Buffer;
          } | null = null;

          if (kind === finalRole) {
            const account = await inspectMacAccount();
            if (account === null || account.admin !== false) return false;
            const configBytes = canonicalConfigBytes(config);
            const corePlist = expectedPlistBytes(config, 'core');
            const tunnelPlist = expectedPlistBytes(config, 'tunnel');
            if (corePlist === null) return false;
            const manifest = buildManifest({
              runtime: { name: 'gram-agent', uid: account.uid, gid: account.gid },
              configBytes,
              releaseId: config.releaseId,
              releaseDigest: config.releaseDigest,
              corePlist,
              tunnelPlist,
            });
            const journalBytes = buildCommittedJournal(manifest.bytes);
            const expectedMetadata: readonly [PublishKind, Buffer][] = [
              ['configuration', configBytes],
              ['manifest', manifest.bytes],
              ['journal', journalBytes],
            ];
            for (const [metadataKind, expected] of expectedMetadata) {
              const current = await storage.readLive(metadataKind);
              if (current === null || !current.equals(expected)) return false;
            }
            cleanup = {
              configBytes,
              manifestBytes: manifest.bytes,
              journalBytes,
            };
          }

          const normalized = await normalizeAbsentSystemServiceOverride(kind);
          if (normalized.ok !== true) return false;
          if (await storage.removeLiveIfMatches(kind, expectedBytes) !== true) return false;
          if (cleanup === null) return true;

          return await storage.removeLiveIfMatches('journal', cleanup.journalBytes)
            && await storage.removeLiveIfMatches('manifest', cleanup.manifestBytes)
            && await storage.removeLiveIfMatches('configuration', cleanup.configBytes);
        },
        async resetExecutionRecords(): Promise<InstallResult> {
          return { ok: false, code: 'PARTIAL_INSTALL' };
        },
        async ensureExecutionAbsentOnly(isNewInstall: boolean): Promise<InstallResult> {
          return executionState(config, acl, isNewInstall);
        },
      };
    },
    services: () => services,
    async readClosedSchema(): Promise<ClosedSchemaReading> {
      // Native exact-schema rollback remains unavailable until the DB-closure
      // + exact accepted-set source is wired. Never approve by min/max metadata.
      return { state: 'unreadable', versions: null, raw: null };
    },
    async trustedAcceptedSets() {
      return null;
    },
  });
}

export function createSystemNativeInstallPorts(config: ServiceConfig): InstallPorts {
  const acl = createSystemBootstrapAclProbe();
  return createNativeInstallPortsAt({
    config,
    acl,
    storage: createSystemNativeInstallStorage(acl),
  });
}


export function createSystemNativeRunningControlPorts(config: ServiceConfig): InstallPorts {
  const normalized = parseConfig(config);
  const acl = createSystemBootstrapAclProbe();
  const storage = createSystemNativeInstallStorage(acl);
  const base = createNativeInstallPortsAt({ config: normalized, acl, storage });
  return Object.freeze({
    ...base,
    readPrior: () => runningPriorFromStorage(storage, acl, normalized),
  });
}
