import type { SafeCode } from './contracts.js';
import type {
  ClosedSchemaReading,
  InstallResult,
  JournalPort,
  LockSession,
  ServiceHandle,
} from './installation-transaction/contracts.js';

/** B2 reviewed-target contracts (T8 repair). The rollback target is the
 * retained reviewed release bound to its release.json exact-bytes digest
 * (sha256 of the canonical bytes per the T7 sealed packager); the
 * prior-digest-only rule is discarded — a bare prior digest proves nothing
 * about reviewed bytes and is refused as foreign. Resolution owns format
 * gating only; binding is proven at identity time via readRetainedRelease.
 * Execution lives in rollback-service.ts; install-service.ts is never
 * imported here.
 */
export interface RollbackTarget {
  digest: string;
}

export type RollbackTargetReason = 'malformed-target';

export type RollbackTargetResolution =
  | { ok: true; target: RollbackTarget }
  | { ok: false; code: 'ROLLBACK_BLOCKED_SCHEMA'; reason: RollbackTargetReason };

export interface ReviewedRelease {
  digest: string;
  releaseJson: Buffer;
  acceptedSchema: readonly (readonly number[])[];
}

export interface CurrentRelease {
  digest: string | null;
  releaseJson: Buffer | null;
}

export interface RollbackPorts {
  authorizeLocalAdmin(): Promise<boolean>;
  lock(): Promise<LockSession>;
  readCurrentRelease(): Promise<CurrentRelease>;
  readRetainedRelease(targetReleaseDigest: string): Promise<ReviewedRelease | null>;
  services(): ServiceHandle;
  confirmDatabaseClosed(): Promise<boolean>;
  readClosedSchema(): Promise<ClosedSchemaReading>;
  restoreRetained(target: ReviewedRelease): Promise<void>;
  rereadLiveRelease(): Promise<CurrentRelease>;
  readLiveManifest(): Promise<Buffer | null>;
  journal(): JournalPort;
}

export function isRollbackDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function resolveRollbackTarget(targetReleaseDigest: unknown): RollbackTargetResolution {
  if (!isRollbackDigest(targetReleaseDigest)) {
    return { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA', reason: 'malformed-target' };
  }
  return { ok: true, target: { digest: targetReleaseDigest } };
}

export function rollbackBlocked(code: SafeCode): InstallResult {
  return { ok: false, code };
}

export async function confirmDatabaseClosed(
  ports: Pick<RollbackPorts, 'confirmDatabaseClosed'>,
): Promise<boolean> {
  try {
    return (await ports.confirmDatabaseClosed()) === true;
  } catch {
    return false;
  }
}
