import type { PriorInstall } from './installation-transaction/contracts.js';

/** B2 rollback-target contracts. The rollback target is always the reviewed
 * installed identity (prior.digest); arbitrary digests never restore.
 * This module owns target resolution only — execution lives in
 * rollback-service.ts and install-service.ts is never imported here.
 */
export interface RollbackTarget {
  digest: string;
}

export type RollbackTargetReason = 'malformed-target' | 'absent-prior' | 'unreviewed-target';

export type RollbackTargetResolution =
  | { ok: true; target: RollbackTarget }
  | { ok: false; code: 'ROLLBACK_BLOCKED_SCHEMA' | 'FOREIGN_SERVICE'; reason: RollbackTargetReason };

export function isRollbackDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function resolveRollbackTarget(
  targetDigest: unknown,
  prior: PriorInstall,
): RollbackTargetResolution {
  if (!isRollbackDigest(targetDigest)) {
    return { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA', reason: 'malformed-target' };
  }
  if (prior.digest === null || prior.manifest === null) {
    return { ok: false, code: 'FOREIGN_SERVICE', reason: 'absent-prior' };
  }
  if (targetDigest !== prior.digest) {
    return { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA', reason: 'unreviewed-target' };
  }
  return { ok: true, target: { digest: targetDigest } };
}
