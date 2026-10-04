import type { SafeCode } from './contracts.js';
import { buildIntermediateJournal, FIXED_FILES, validateManifestBytes } from './adapters/install-files.js';
import { guardRollbackSchema } from './installation-transaction/schema-guard.js';
import type {
  InstallPorts,
  InstallResult,
} from './installation-transaction/contracts.js';
import { isRollbackDigest, resolveRollbackTarget } from './rollback-contracts.js';

/** B2 rollback-target service. Standalone narrow rollback to the reviewed
 * installed identity: malformed or unreviewed digests never mutate, schema
 * is read only after both services are confirmed stopped with DB closure,
 * and both releases stay stopped when safe rollback cannot be proven. Never
 * copies a live SQLite/WAL pair, deletes the DB, or runs a migration probe.
 * install-service.ts is not imported here and stays read-only on this lane.
 */
function fail(code: SafeCode): InstallResult {
  return { ok: false, code };
}

async function withLock(ports: InstallPorts, use: () => Promise<InstallResult>): Promise<InstallResult> {
  let session;
  try {
    session = await ports.lock();
  } catch {
    return fail('PARTIAL_INSTALL');
  }
  if (!session.acquired) return fail('BUSY');
  let result: InstallResult;
  try {
    result = await use();
  } catch {
    try {
      await session.release();
    } catch { /* already failing; preserve bounded failure */ }
    return fail('PARTIAL_INSTALL');
  }
  try {
    await session.release();
  } catch {
    if (result.ok) return result.stage === undefined
      ? { ok: false, code: 'PARTIAL_INSTALL' }
      : { ok: false, code: 'PARTIAL_INSTALL', stage: result.stage };
    return result;
  }
  return result;
}

async function authorizeAdmin(ports: InstallPorts): Promise<boolean> {
  try {
    return (await ports.authorizeLocalAdmin()) === true;
  } catch {
    return false;
  }
}

export async function rollbackToTarget(
  targetDigest: string,
  ports: InstallPorts,
): Promise<InstallResult> {
  // Malformed targets never reach auth, lock, or any mutating port.
  if (!isRollbackDigest(targetDigest)) return fail('ROLLBACK_BLOCKED_SCHEMA');
  if (!(await authorizeAdmin(ports))) return fail('NOT_AUTHORIZED');

  const locked = await withLock(ports, async (): Promise<InstallResult> => {
    let prior;
    try {
      prior = await ports.readPrior();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    const resolved = resolveRollbackTarget(targetDigest, prior);
    if (!resolved.ok) return fail(resolved.code);

    const services = ports.services();
    try {
      const stopTunnel = await services.stop('tunnel');
      if (!stopTunnel.ok) return { ok: false, code: stopTunnel.code, stage: 'STOPPED' };
      const stopCore = await services.stop('core');
      if (!stopCore.ok) return { ok: false, code: stopCore.code, stage: 'STOPPED' };
      let stoppedTunnel: boolean;
      let stoppedCore: boolean;
      try {
        stoppedTunnel = await services.isStopped('tunnel');
        stoppedCore = await services.isStopped('core');
      } catch {
        return fail('PARTIAL_INSTALL');
      }
      if (stoppedTunnel !== true || stoppedCore !== true) return fail('PARTIAL_INSTALL');
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
      try {
        await ports.restore().restorePrior(prior);
      } catch {
        return fail('PARTIAL_INSTALL');
      }
      let after;
      try {
        after = await ports.readPrior();
      } catch {
        return fail('PARTIAL_INSTALL');
      }
      if (after.digest !== resolved.target.digest || after.manifest === null
        || !validateManifestBytes(after.manifest)) {
        return fail('ROLLBACK_BLOCKED_SCHEMA');
      }
      const journal = ports.journal();
      const liveManifest = await ports.publish().readLive('manifest');
      if (liveManifest !== null && validateManifestBytes(liveManifest)) {
        await journal.writeStage('STOPPED', buildIntermediateJournal('STOPPED', {
          previousDigest: prior.digest, nextDigest: resolved.target.digest,
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
