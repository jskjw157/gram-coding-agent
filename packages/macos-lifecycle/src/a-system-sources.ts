import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import type { CoreCredentials } from './health-probe.js';
import { copyRuntimeReview, type RuntimeReview } from './runtime-review.js';
import { inspectRelease } from './release-inspection.js';
import { FIXED_FILES, shaBytes, validateManifestBytes } from './adapters/install-files.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type { RecordFiles } from './telemetry-store.js';
import { checkMacAcl } from './adapters/macos-acl.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';

const SECRET_FILE = 'mcp-internal-secret';
const MAX_SECRET_BYTES = 65_536;
const HEX64 = /^[a-f0-9]{64}$/u;

export const systemBootstrapPaths = Object.freeze({
  aclHelper: `${root}/bootstrap/bin/file-acl`,
  installation: `${root}/config/installation.json`,
  config: `${root}/config/service.json`,
  secret: `${root}/secrets/${SECRET_FILE}`,
});

function safeRelative(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.startsWith('/') || value.includes('\\')) throw new Error('UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..'
    || [...part].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) {
    throw new Error('UNSAFE_PATH');
  }
  return parts;
}

async function sameStat(file: FileHandle, path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
  const [held, current] = await Promise.all([file.stat(), lstat(path)]);
  return held.dev === before.dev && held.ino === before.ino && held.mode === before.mode
    && held.uid === before.uid && held.gid === before.gid && held.nlink === before.nlink
    && held.size === before.size && current.dev === before.dev && current.ino === before.ino
    && current.mode === before.mode && current.uid === before.uid && current.gid === before.gid
    && current.nlink === before.nlink && current.size === before.size;
}

/**
 * Bootstrap trust anchor for the ACL verifier itself. This intentionally does
 * NOT use the candidate release's bin/file-acl. Every ancestor and the fixed
 * helper must be root-owned and non-writable by group/other; the helper must be
 * a single-link executable regular file. Root/admin remains the trust anchor.
 */
export function createSystemBootstrapAclProbe(
  helperPath = systemBootstrapPaths.aclHelper,
): AclProbe {
  const fixed = resolve(helperPath);
  return async (target: FileHandle): Promise<boolean> => {
    const held: FileHandle[] = [];
    try {
      if (process.platform !== 'darwin' || fixed !== helperPath || !fixed.startsWith('/')) return false;
      const parts = fixed.split('/').filter(Boolean);
      let path = '/';
      for (let index = 0; index < parts.length; index++) {
        path = join(path, parts[index] as string);
        const leaf = index === parts.length - 1;
        const before = await lstat(path);
        if (before.uid !== 0 || (before.mode & 0o022) !== 0
          || (leaf ? (!before.isFile() || before.nlink !== 1 || (before.mode & 0o111) === 0)
            : !before.isDirectory())) return false;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
          | (leaf ? 0 : constants.O_DIRECTORY) | constants.O_NONBLOCK);
        held.push(file);
        if (!await sameStat(file, path, before)) return false;
      }
      return await checkMacAcl(target, fixed) === true;
    } catch {
      return false;
    } finally {
      await Promise.all(held.map(async file => { await file.close().catch(() => undefined); }));
    }
  };
}

export interface BootstrapSourceLayout {
  readonly anchor: string;
  readonly relative: string;
  readonly ownerUid: number;
  readonly runtimeUid: number;
  readonly acl: AclProbe;
}

export interface InstalledRuntimeReviewSource {
  read(signal: AbortSignal): Promise<Readonly<RuntimeReview> | null>;
}

function data(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    out[key] = descriptor.value;
  }
  return out;
}

function entryDigest(releaseJson: unknown, path: string): string | null {
  const manifest = data(releaseJson, ['schemaVersion', 'releaseId', 'sourceCommit', 'lockDigest',
    'files', 'coreTools', 'schemaCompatibility',
    ...(data(releaseJson, ['schemaVersion', 'releaseId', 'sourceCommit', 'lockDigest',
      'files', 'coreTools', 'schemaCompatibility', 'tunnelCompatibilityDigest']) !== null
      ? ['tunnelCompatibilityDigest']
      : [])]);
  if (manifest === null || !Array.isArray(manifest.files)) return null;
  const matches = manifest.files.filter((value) => {
    const item = data(value, ['path', 'sha256', 'executable']);
    return item?.path === path && typeof item.sha256 === 'string' && HEX64.test(item.sha256)
      && item.executable === true;
  });
  if (matches.length !== 1) return null;
  const item = data(matches[0], ['path', 'sha256', 'executable']);
  return typeof item?.sha256 === 'string' ? item.sha256 : null;
}

/**
 * Build the runtime review from already-installed root-owned evidence:
 * installation.json approves the config bytes + exact sealed release digest;
 * release.json (verified by inspectRelease) supplies the exact helper/node pins.
 * The candidate release therefore never self-approves its own trust.
 */
export function createInstalledRuntimeReviewSource(
  layout: BootstrapSourceLayout,
): InstalledRuntimeReviewSource {
  const configFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.relative}/config`,
  );

  return Object.freeze({
    async read(signal: AbortSignal): Promise<Readonly<RuntimeReview> | null> {
      try {
        if (signal.aborted) return null;
        const [configBytes, installationBytes] = await Promise.all([
          configFiles.read('service.json', 262_144),
          configFiles.read('installation.json', 262_144),
        ]);
        if (signal.aborted || !validateManifestBytes(installationBytes)) return null;

        const config = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
        const installation = data(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(installationBytes)),
          ['schemaVersion', 'state', 'runtime', 'configSha256', 'releaseId', 'releaseDigest', 'plistSha256', 'desiredEnabled'],
        );
        const runtime = data(installation?.runtime, ['name', 'uid', 'gid']);
        if (installation === null || runtime === null
          || installation.schemaVersion !== 1 || installation.state !== 'COMMITTED'
          || runtime.name !== 'gram-agent'
          || installation.configSha256 !== shaBytes(configBytes)
          || installation.releaseId !== config.releaseId
          || installation.releaseDigest !== config.releaseDigest) return null;

        const releaseFiles = createTrustedFiles(
          layout.anchor,
          layout.ownerUid,
          layout.acl,
          `${layout.relative}/releases/${config.releaseId}`,
        );
        await inspectRelease(config, config.releaseDigest, releaseFiles);
        if (signal.aborted) return null;
        const releaseBytes = await releaseFiles.read('release.json', 1024 * 1024);
        if (signal.aborted || shaBytes(releaseBytes) !== config.releaseDigest) return null;
        const releaseJson: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes));

        const nodeDigest = entryDigest(releaseJson, 'bin/node');
        const fileAclDigest = entryDigest(releaseJson, 'bin/file-acl');
        const peerOwnerDigest = entryDigest(releaseJson, 'bin/peer-owner');
        if (nodeDigest === null || fileAclDigest === null || peerOwnerDigest === null) return null;

        return copyRuntimeReview({
          config,
          configDigest: configDigest(config),
          nodeDigest,
          fileAclDigest,
          peerOwnerDigest,
        });
      } catch {
        return null;
      }
    },
  });
}

export interface RuntimeRecordProvisioner {
  ensure(review: Readonly<RuntimeReview>, signal: AbortSignal): Promise<boolean>;
}

function missingCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && Object.getOwnPropertyDescriptor(error, 'message')?.value === code;
}

function freshPublishedJournal(bytes: Buffer, installationBytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const journal = data(value, ['schemaVersion', 'stage', 'previousDigest', 'nextDigest', 'inventory']);
    if (journal === null || journal.schemaVersion !== 1 || journal.stage !== 'PUBLISHED'
      || journal.previousDigest !== null || journal.nextDigest !== shaBytes(installationBytes)
      || !Array.isArray(journal.inventory)) return false;
    const expected = Object.values(FIXED_FILES);
    return journal.inventory.length === expected.length
      && journal.inventory.every((entry, index) => entry === expected[index]);
  } catch {
    return false;
  }
}

function pristineExecution(value: Awaited<ReturnType<ExecutionLeaseStore['read']>>): boolean {
  return value.state === 'FREE' && value.revision === 0 && value.token === null
    && value.generation === null && value.configDigest === null && value.releaseDigest === null;
}

/**
 * Create-only first-install record provisioning. Existing complete records are
 * left untouched. Missing records are created only while the root-owned
 * installer journal proves a fresh PUBLISHED transaction (previousDigest=null)
 * bound to the current installation manifest. Upgrades with missing history
 * fail closed instead of silently manufacturing new history.
 */
export function createRuntimeRecordProvisioner(
  layout: BootstrapSourceLayout,
): RuntimeRecordProvisioner {
  const configFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.relative}/config`,
  );

  return Object.freeze({
    async ensure(review: Readonly<RuntimeReview>, signal: AbortSignal): Promise<boolean> {
      try {
        if (signal.aborted) return false;
        const directories = await inspectRuntimeDirectories(
          { anchor: layout.anchor, relative: layout.relative, ownerUid: layout.ownerUid },
          layout.runtimeUid,
          layout.acl,
          signal,
        );
        if (signal.aborted) return false;

        const guardRecords = (raw: RecordFiles): RecordFiles => Object.freeze({
          async read(role) {
            await directories.verify();
            const result = await raw.read(role);
            await directories.verify();
            return result;
          },
          async compareAndSwap(role, expected, slot, bytes) {
            await directories.verify();
            await raw.compareAndSwap(role, expected, slot, bytes);
            await directories.verify();
          },
        });

        const execution = new ExecutionLeaseStore(
          guardRecords(createExecutionFilesAt(directories.runPolicy)),
        );
        const lifecycle = createRuntimeStores(directories).lifecycle;
        const roles = review.config.tunnel.enabled
          ? (['core', 'tunnel'] as const)
          : (['core'] as const);

        const state = new Map<'core' | 'tunnel', {
          execution: 'missing' | 'present';
          lifecycle: 'missing' | 'present';
          pristineExecution: boolean;
          pristineLifecycle: boolean;
        }>();

        for (const role of roles) {
          let executionState: 'missing' | 'present' = 'present';
          let executionPristine = false;
          try {
            executionPristine = pristineExecution(await execution.read(role));
          } catch (error) {
            if (!missingCode(error, 'MISSING_EXECUTION')) return false;
            executionState = 'missing';
          }

          let lifecycleState: 'missing' | 'present' = 'present';
          let lifecyclePristine = false;
          try {
            const history = (await lifecycle.read(role)).history;
            lifecyclePristine = history.blocked === false
              && history.lastGeneration === null
              && history.activeAttempt === null
              && history.exitsMs.length === 0;
          } catch (error) {
            if (!missingCode(error, 'MISSING_HISTORY')) return false;
            lifecycleState = 'missing';
          }

          state.set(role, {
            execution: executionState,
            lifecycle: lifecycleState,
            pristineExecution: executionPristine,
            pristineLifecycle: lifecyclePristine,
          });
        }

        const missing = [...state.values()].some(value =>
          value.execution === 'missing' || value.lifecycle === 'missing');
        if (!missing) return true;

        // Never fill a hole next to non-pristine existing state.
        if ([...state.values()].some(value =>
          value.execution === 'present' && !value.pristineExecution
          || value.lifecycle === 'present' && !value.pristineLifecycle)) return false;

        const [journalBytes, installationBytes] = await Promise.all([
          configFiles.read('install-journal.json', 262_144),
          configFiles.read('installation.json', 262_144),
        ]);
        if (signal.aborted || !validateManifestBytes(installationBytes)
          || !freshPublishedJournal(journalBytes, installationBytes)) return false;

        const now = Date.now();
        if (!Number.isSafeInteger(now) || now < 0) return false;
        for (const role of roles) {
          const current = state.get(role);
          if (!current) return false;
          if (current.execution === 'missing') await execution.initializeNew(role);
          if (current.lifecycle === 'missing') await lifecycle.initializeNew(role, now);
        }

        // Re-read exact create-only state before allowing runtime bind.
        for (const role of roles) {
          if (!pristineExecution(await execution.read(role))) return false;
          const history = (await lifecycle.read(role)).history;
          if (history.blocked !== false || history.lastGeneration !== null
            || history.activeAttempt !== null || history.exitsMs.length !== 0) return false;
        }
        return !signal.aborted;
      } catch {
        return false;
      }
    },
  });
}

async function readRuntimeSecret(
  layout: BootstrapSourceLayout,
  use: (secret: string) => Promise<unknown>,
): Promise<unknown> {
  const anchor = resolve(layout.anchor);
  if (anchor !== layout.anchor || !Number.isSafeInteger(layout.runtimeUid) || layout.runtimeUid < 1) {
    throw new Error('AUTH_BLOCKED');
  }
  const parts = [...safeRelative(layout.relative), 'secrets', SECRET_FILE];
  const held: FileHandle[] = [];
  try {
    let path = anchor;
    const anchorStat = await lstat(path);
    if (!anchorStat.isDirectory() || anchorStat.uid !== layout.ownerUid || (anchorStat.mode & 0o022) !== 0) {
      throw new Error('AUTH_BLOCKED');
    }
    const anchorFile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
    held.push(anchorFile);
    if (!await sameStat(anchorFile, path, anchorStat) || await layout.acl(anchorFile) !== true) {
      throw new Error('AUTH_BLOCKED');
    }

    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index] as string);
      const leaf = index === parts.length - 1;
      const secretDir = index === parts.length - 2;
      const before = await lstat(path);
      const expectedUid = secretDir || leaf ? layout.runtimeUid : layout.ownerUid;
      if (before.uid !== expectedUid
        || (before.mode & (leaf ? 0o177 : secretDir ? 0o077 : 0o022)) !== 0
        || (leaf ? (!before.isFile() || before.nlink !== 1)
          : !before.isDirectory())) throw new Error('AUTH_BLOCKED');
      if (leaf && (before.size <= 0 || before.size > MAX_SECRET_BYTES)) throw new Error('AUTH_BLOCKED');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
        | (leaf ? 0 : constants.O_DIRECTORY) | constants.O_NONBLOCK);
      held.push(file);
      if (!await sameStat(file, path, before) || await layout.acl(file) !== true
        || !await sameStat(file, path, before)) throw new Error('AUTH_BLOCKED');
      if (leaf) {
        const bytes = Buffer.alloc(before.size);
        try {
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== bytes.length || !await sameStat(file, path, before)) throw new Error('AUTH_BLOCKED');
          let value = bytes.toString('utf8');
          if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('AUTH_BLOCKED');
          value = value.replace(/\r?\n$/u, '');
          if (value.length === 0) throw new Error('AUTH_BLOCKED');
          return await use(value);
        } finally {
          bytes.fill(0);
        }
      }
    }
    throw new Error('AUTH_BLOCKED');
  } catch {
    throw new Error('AUTH_BLOCKED');
  } finally {
    await Promise.all(held.map(async file => { await file.close().catch(() => undefined); }));
  }
}

export function createRuntimeCoreCredentials(layout: BootstrapSourceLayout): CoreCredentials {
  return Object.freeze({
    async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
      return await readRuntimeSecret(layout, use) as T;
    },
  });
}

/** Production fixed paths. Construction performs no IO. */
export function createSystemBootstrapSources(): {
  acl: AclProbe;
  review: InstalledRuntimeReviewSource;
  records: RuntimeRecordProvisioner;
  credentials: CoreCredentials;
} {
  const uid = process.getuid?.() ?? 0;
  const acl = createSystemBootstrapAclProbe();
  const layout: BootstrapSourceLayout = {
    anchor: '/',
    relative: root.slice(1),
    ownerUid: 0,
    runtimeUid: uid,
    acl,
  };
  return Object.freeze({
    acl,
    review: createInstalledRuntimeReviewSource(layout),
    records: createRuntimeRecordProvisioner(layout),
    credentials: createRuntimeCoreCredentials(layout),
  });
}
