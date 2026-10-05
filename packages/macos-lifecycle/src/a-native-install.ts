import type { ServiceConfig } from './contracts.js';
import { root } from './contracts.js';
import { parseConfig } from './config.js';
import { preview } from './preflight.js';
import { inspectInstallation, type InstallFile, type InstallationIO } from './installation-inspection.js';
import { inspectRelease } from './release-inspection.js';
import { inspectMacAccount } from './adapters/macos-inspection.js';
import { inspectMacRegistry } from './adapters/macos-service-probes.js';
import { createMacInspector } from './adapters/native-inspector.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type {
  ClosedSchemaReading,
  InstallPorts,
  InstallResult,
  PriorInstall,
  PublishKind,
  Revalidation,
} from './installation-transaction/contracts.js';
import { createSystemBootstrapAclProbe } from './a-system-sources.js';
import {
  createNativeInstallStorageAt,
  createSystemNativeInstallStorage,
  type NativeInstallStorage,
} from './a-native-storage.js';
import { createSystemServiceHandle } from './a-native-services.js';

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
    registry: inspectMacRegistry,
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
    restore() {
      return {
        async restorePrior() {
          throw new Error('PARTIAL_INSTALL');
        },
        async removeManifestOwned(kind, expectedBytes) {
          return storage.removeLiveIfMatches(kind, expectedBytes);
        },
        async resetExecutionRecords() {
          return { ok: false, code: 'PARTIAL_INSTALL' };
        },
        async ensureExecutionAbsentOnly(isNewInstall) {
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
