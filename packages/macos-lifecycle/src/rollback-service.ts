import type { SafeCode } from './contracts.js';
import { buildIntermediateJournal, FIXED_FILES, validateManifestBytes } from './adapters/install-files.js';
import { guardRollbackSchema } from './installation-transaction/schema-guard.js';
import type { InstallResult } from './installation-transaction/contracts.js';
import {
  confirmDatabaseClosed,
  resolveRollbackTarget,
  rollbackBlocked,
  type RollbackPorts,
} from './rollback-contracts.js';

/** B2 reviewed-target service (T8 repair). Narrow rollback to the retained
 * reviewed release: malformed digests never reach auth, lock, or mutation;
 * identity (current + retained release.json binding) precedes any stop;
 * tunnel then core stop with both confirmed stopped; the database is
 * confirmed closed before the closed schema is read; the schema gate uses
 * the target-owned accepted sets; retained bytes are actually restored and
 * reread/verified before the journal commits — unrestored bytes never
 * report OK. Both releases stay stopped. Never copies a live SQLite/WAL
 * pair, deletes the DB, or runs a migration probe. install-service.ts is
 * not imported here and stays read-only on this lane.
 */
function fail(code: SafeCode): InstallResult {
  return rollbackBlocked(code);
}

async function withLock(
  ports: Pick<RollbackPorts, 'lock'>,
  use: () => Promise<InstallResult>,
): Promise<InstallResult> {
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

async function authorizeAdmin(ports: Pick<RollbackPorts, 'authorizeLocalAdmin'>): Promise<boolean> {
  try {
    return (await ports.authorizeLocalAdmin()) === true;
  } catch {
    return false;
  }
}

export async function rollbackToReviewedTarget(
  targetReleaseDigest: string,
  ports: RollbackPorts,
): Promise<InstallResult> {
  const resolved = resolveRollbackTarget(targetReleaseDigest);
  if (!resolved.ok) return fail(resolved.code);
  if (!(await authorizeAdmin(ports))) return fail('NOT_AUTHORIZED');

  return withLock(ports, async (): Promise<InstallResult> => {
    let currentDigest: string | null;
    try {
      currentDigest = (await ports.readCurrentRelease()).digest;
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    let retained;
    try {
      retained = await ports.readRetainedRelease(resolved.target.digest);
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    if (retained === null) return fail('FOREIGN_SERVICE');

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
      if (!(await confirmDatabaseClosed(ports))) return fail('ROLLBACK_BLOCKED_SCHEMA');
      let reading;
      try {
        reading = await ports.readClosedSchema();
      } catch {
        return fail('ROLLBACK_BLOCKED_SCHEMA');
      }
      if (!guardRollbackSchema(reading, retained.acceptedSchema).ok) {
        return fail('ROLLBACK_BLOCKED_SCHEMA');
      }
      try {
        await ports.restoreRetained(retained);
      } catch {
        return fail('PARTIAL_INSTALL');
      }
      let after;
      try {
        after = await ports.rereadLiveRelease();
      } catch {
        return fail('PARTIAL_INSTALL');
      }
      if (after.digest !== retained.digest || after.releaseJson === null
        || !after.releaseJson.equals(retained.releaseJson)) {
        return fail('ROLLBACK_BLOCKED_SCHEMA');
      }
      const journal = ports.journal();
      const liveManifest = await ports.readLiveManifest();
      if (liveManifest !== null && validateManifestBytes(liveManifest)) {
        await journal.writeStage('STOPPED', buildIntermediateJournal('STOPPED', {
          previousDigest: currentDigest !== null && /^[a-f0-9]{64}$/.test(currentDigest)
            ? currentDigest
            : null,
          nextDigest: retained.digest,
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
}
