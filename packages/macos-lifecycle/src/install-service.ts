import { createHash } from 'node:crypto';
import type { Preview, SafeCode, ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import {
  buildCommittedJournal,
  buildIntermediateJournal,
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  FIXED_FILES,
  shaBytes,
  validateManifestBytes,
} from './adapters/install-files.js';
import { guardRollbackSchema } from './installation-transaction/schema-guard.js';
import { reconcileJournal } from './installation-transaction/journal.js';
import type {
  InstallPorts,
  InstallResult,
  PriorInstall,
} from './installation-transaction/contracts.js';

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function compositeToken(config: ServiceConfig, releaseDigest: string, previousInstallDigest: string | null): string {
  const normalized = parseConfig(config);
  return createHash('sha256').update(JSON.stringify({
    config: normalized, releaseDigest, previousInstallDigest,
  }), 'utf8').digest('hex');
}

function fail(code: SafeCode): InstallResult {
  return { ok: false, code };
}

async function withLock(ports: InstallPorts, use: () => Promise<InstallResult>): Promise<InstallResult> {
  const session = await ports.lock();
  if (!session.acquired) return fail('BUSY');
  try {
    return await use();
  } finally {
    await session.release().catch(() => undefined);
  }
}

function manifestMatchesPrior(prior: PriorInstall, config: ServiceConfig, configBytes: Buffer): boolean {
  try {
    const normalized = parseConfig(config);
    if (prior.releaseId !== normalized.releaseId || prior.releaseDigest !== normalized.releaseDigest) return false;
    if (prior.manifest === null || !validateManifestBytes(prior.manifest)) return false;
    const parsed: unknown = JSON.parse(prior.manifest.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const m = parsed as Record<string, unknown>;
    if (m.configSha256 !== shaBytes(configBytes)) return false;
    const hashes = m.plistSha256 as Record<string, unknown>;
    const coreExpected = expectedPlistBytes(normalized, 'core');
    if (coreExpected === null || prior.corePlist === null) return false;
    if (hashes.core !== shaBytes(coreExpected) || !prior.corePlist.equals(coreExpected)) return false;
    const tunnelExpected = expectedPlistBytes(normalized, 'tunnel');
    if (tunnelExpected === null) {
      if (hashes.tunnel !== null || prior.tunnelPlist !== null) return false;
    } else {
      if (prior.tunnelPlist === null || hashes.tunnel !== shaBytes(tunnelExpected)
        || !prior.tunnelPlist.equals(tunnelExpected)) return false;
    }
    if (!prior.config?.equals(configBytes)) return false;
    return prior.enabled.core === false && prior.enabled.tunnel === false;
  } catch {
    return false;
  }
}

/** Journaled apply. Ordering: admin -> lock -> revalidate -> PREPARED ->
 * tunnel disable/bootout -> core stop/verify -> STOPPED -> same-filesystem
 * stage -> FILES_STAGED -> per-file publish -> PUBLISHED -> core owned health
 * (+ optional tunnel) -> STARTED/COMMITTED. No multi-file atomicity is
 * claimed; journal + idempotent recovery cover rename gaps.
 */
export async function apply(
  preview: Preview,
  config: ServiceConfig,
  ports: InstallPorts,
): Promise<InstallResult> {
  let normalized: ServiceConfig;
  try {
    normalized = parseConfig(config);
  } catch {
    return fail('INVALID_CONFIG');
  }
  if (!preview || preview.ok !== true || preview.code !== 'OK') return fail('CONFIG_CHANGED');
  if (!isDigest(preview.configDigest) || !isDigest(preview.releaseDigest)) return fail('CONFIG_CHANGED');
  if (!(preview.previousInstallDigest === null || isDigest(preview.previousInstallDigest))) {
    return fail('CONFIG_CHANGED');
  }
  if (preview.releaseDigest !== normalized.releaseDigest) return fail('CONFIG_CHANGED');
  let expectedToken: string;
  try {
    expectedToken = compositeToken(normalized, preview.releaseDigest, preview.previousInstallDigest);
  } catch {
    return fail('INVALID_CONFIG');
  }
  if (preview.configDigest !== expectedToken) return fail('CONFIG_CHANGED');

  if (await ports.authorizeLocalAdmin() !== true) return fail('NOT_AUTHORIZED');

  const locked = await withLock(ports, async (): Promise<InstallResult> => {
    let revalidated;
    try {
      revalidated = await ports.revalidate();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    if (!revalidated || revalidated.ok !== true) return fail(revalidated?.code ?? 'PARTIAL_INSTALL');
    if (revalidated.previewToken !== preview.configDigest
      || revalidated.priorDigest !== preview.previousInstallDigest) {
      return fail('CONFIG_CHANGED');
    }

    let prior: PriorInstall;
    try {
      prior = await ports.readPrior();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    if (prior.digest !== preview.previousInstallDigest) return fail('CONFIG_CHANGED');
    // Foreign / partial prior: digest null must mean fully absent.
    if (prior.digest === null) {
      if (prior.manifest !== null || prior.config !== null || prior.corePlist !== null
        || prior.tunnelPlist !== null || prior.present.core || prior.present.tunnel) {
        return fail('FOREIGN_SERVICE');
      }
    } else {
      if (prior.manifest === null || !validateManifestBytes(prior.manifest)) return fail('FOREIGN_SERVICE');
    }

    let liveJournal: Buffer | null;
    let liveManifest: Buffer | null;
    try {
      liveJournal = await ports.journal().read();
      const publish = ports.publish();
      liveManifest = await publish.readLive('manifest');
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    const reconciled = reconcileJournal(liveJournal, liveManifest);
    if (reconciled.state === 'partial') return fail('PARTIAL_INSTALL');

    const configBytes = canonicalConfigBytes(normalized);
    const corePlist = expectedPlistBytes(normalized, 'core');
    if (corePlist === null) return fail('INVALID_CONFIG');
    const tunnelPlist = expectedPlistBytes(normalized, 'tunnel');

    // Duplicate apply is a no-op only if installed identity + desired state match.
    if (prior.digest !== null && manifestMatchesPrior(prior, normalized, configBytes)) {
      if (reconciled.state === 'clean-committed') return { ok: true, code: 'OK', stage: 'COMMITTED' };
      return fail('PARTIAL_INSTALL');
    }

    const isNewInstall = prior.digest === null;
    try {
      const provision = await ports.restore().ensureExecutionAbsentOnly(isNewInstall);
      if (!provision.ok) return fail(provision.code);
    } catch {
      return fail('PARTIAL_INSTALL');
    }

    const inventory = Object.values(FIXED_FILES);
    const nextHint = shaBytes(configBytes);
    const journal = ports.journal();
    const publish = ports.publish();
    const services = ports.services();

    try {
      await journal.writeStage('PREPARED', buildIntermediateJournal('PREPARED', {
        previousDigest: prior.digest, nextDigest: nextHint, inventory,
      }));

      const stopTunnel = await services.stop('tunnel');
      if (!stopTunnel.ok) return { ok: false, code: stopTunnel.code, stage: 'PREPARED' };
      const stopCore = await services.stop('core');
      if (!stopCore.ok) return { ok: false, code: stopCore.code, stage: 'PREPARED' };
      if (await services.isStopped('tunnel') !== true) return fail('PARTIAL_INSTALL');
      if (await services.isStopped('core') !== true) return fail('PARTIAL_INSTALL');

      await journal.writeStage('STOPPED', buildIntermediateJournal('STOPPED', {
        previousDigest: prior.digest, nextDigest: nextHint, inventory,
      }));

      // Same-filesystem staging via narrow publish port (no arbitrary paths).
      const manifestBuilt = buildManifest({
        runtime: revalidated.runtime,
        configBytes, releaseId: normalized.releaseId, releaseDigest: normalized.releaseDigest,
        corePlist, tunnelPlist,
      });
      await publish.stageFile('configuration', configBytes);
      await publish.stageFile('core', corePlist);
      if (tunnelPlist !== null) await publish.stageFile('tunnel', tunnelPlist);
      await publish.stageFile('manifest', manifestBuilt.bytes);
      const committedJournal = buildCommittedJournal(manifestBuilt.bytes);
      await publish.stageFile('journal', committedJournal);

      await journal.writeStage('FILES_STAGED', buildIntermediateJournal('FILES_STAGED', {
        previousDigest: prior.digest, nextDigest: manifestBuilt.sha, inventory,
      }));

      await publish.publishFile('configuration', configBytes);
      await publish.publishFile('core', corePlist);
      if (tunnelPlist !== null) await publish.publishFile('tunnel', tunnelPlist);
      await publish.publishFile('manifest', manifestBuilt.bytes);

      await journal.writeStage('PUBLISHED', buildIntermediateJournal('PUBLISHED', {
        previousDigest: prior.digest, nextDigest: manifestBuilt.sha, inventory,
      }));

      const startCore = await services.start('core');
      if (!startCore.ok) return { ok: false, code: startCore.code, stage: 'PUBLISHED' };
      if (await services.ownedHealthy('core') !== true) {
        return { ok: false, code: 'HEALTH_UNKNOWN', stage: 'PUBLISHED' };
      }
      if (tunnelPlist !== null) {
        const startTunnel = await services.start('tunnel');
        if (!startTunnel.ok) return { ok: false, code: startTunnel.code, stage: 'PUBLISHED' };
        if (await services.ownedHealthy('tunnel') !== true) {
          return { ok: false, code: 'HEALTH_UNKNOWN', stage: 'PUBLISHED' };
        }
      }

      await journal.writeStage('STARTED', buildIntermediateJournal('STARTED', {
        previousDigest: prior.digest, nextDigest: manifestBuilt.sha, inventory,
      }));
      await publish.publishFile('journal', committedJournal);
      await journal.writeStage('COMMITTED', committedJournal);
      return { ok: true, code: 'OK', stage: 'COMMITTED' };
    } catch (error) {
      if (error instanceof Error && error.message === 'INTERRUPTED') {
        return { ok: false, code: 'PARTIAL_INSTALL' };
      }
      return fail('PARTIAL_INSTALL');
    }
  });

  return locked;
}

/** Rollback to a reviewed target digest. Reads schema_migrations from the
 * stopped lab DB via the injected closed-schema port and compares the full
 * set against independently trusted accepted sets. Never copies a live
 * SQLite/WAL pair, deletes the DB, or runs a migration probe. Both releases
 * stay stopped when safe rollback cannot be proven.
 */
export async function rollback(targetDigest: string, ports: InstallPorts): Promise<InstallResult> {
  if (!isDigest(targetDigest)) return fail('ROLLBACK_BLOCKED_SCHEMA');
  if (await ports.authorizeLocalAdmin() !== true) return fail('NOT_AUTHORIZED');

  const locked = await withLock(ports, async (): Promise<InstallResult> => {
    let prior: PriorInstall;
    try {
      prior = await ports.readPrior();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    if (prior.digest === null || prior.manifest === null) return fail('FOREIGN_SERVICE');

    let reading;
    let accepted: readonly (readonly number[])[] | null;
    try {
      reading = await ports.readClosedSchema();
      accepted = await ports.trustedAcceptedSets();
    } catch {
      return fail('ROLLBACK_BLOCKED_SCHEMA');
    }
    const decision = guardRollbackSchema(reading, accepted);
    if (!decision.ok) return fail('ROLLBACK_BLOCKED_SCHEMA');

    const services = ports.services();
    try {
      const stopTunnel = await services.stop('tunnel');
      if (!stopTunnel.ok) return { ok: false, code: stopTunnel.code, stage: 'STOPPED' };
      const stopCore = await services.stop('core');
      if (!stopCore.ok) return { ok: false, code: stopCore.code, stage: 'STOPPED' };
      if (await services.isStopped('tunnel') !== true) return fail('PARTIAL_INSTALL');
      if (await services.isStopped('core') !== true) return fail('PARTIAL_INSTALL');
      // Compatible rollback proven; executables stay stopped in the lab
      // disabled snapshot. No DB copy/delete, no migration invocation, and the
      // previous release is not auto-started here (integrator A sequences a
      // reviewed re-apply). Journal the verified stop.
      const journal = ports.journal();
      const liveManifest = await ports.publish().readLive('manifest');
      if (liveManifest !== null && validateManifestBytes(liveManifest)) {
        await journal.writeStage('STOPPED', buildIntermediateJournal('STOPPED', {
          previousDigest: prior.digest, nextDigest: targetDigest,
          inventory: Object.values(FIXED_FILES),
        }));
      }
      return { ok: true, code: 'OK', stage: 'STOPPED' };
    } catch (error) {
      if (error instanceof Error && error.message === 'INTERRUPTED') {
        return { ok: false, code: 'PARTIAL_INSTALL' };
      }
      return fail('PARTIAL_INSTALL');
    }
  });

  return locked;
}
