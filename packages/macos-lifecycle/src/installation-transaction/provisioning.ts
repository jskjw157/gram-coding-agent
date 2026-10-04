import type { InstallResult } from './contracts.js';

/** Execution-record provisioning. Absent records are initialized only for a
 * verified new installation. Existing HELD/revision/generation is never
 * overwritten, and unknown durability requires reconciliation, not rewrite.
 */
export type ExecutionState = 'absent' | 'held' | 'ready' | 'unknown';

export function decideProvisioning(input: {
  isNewInstall: boolean;
  execution: ExecutionState;
}): InstallResult {
  if (input.isNewInstall && input.execution === 'absent') return { ok: true, code: 'OK' };
  if (input.isNewInstall) return { ok: false, code: 'PARTIAL_INSTALL' };
  // Existing installs must be stopped and reconciled before adding this family.
  if (input.execution === 'absent') return { ok: false, code: 'PARTIAL_INSTALL' };
  // Unknown durability is never rewritten blindly: reconcile first.
  if (input.execution === 'unknown') return { ok: false, code: 'PARTIAL_INSTALL' };
  return { ok: true, code: 'OK' };
}
