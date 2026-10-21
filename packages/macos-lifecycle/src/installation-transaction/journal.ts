import { shaBytes, validateCommittedJournal, validateManifestBytes } from '../adapters/install-files.js';
import type { InstallStage } from './contracts.js';

const ORDER: readonly InstallStage[] = [
  'PREPARED', 'STOPPED', 'FILES_STAGED', 'PUBLISHED', 'STARTED', 'COMMITTED',
];

export function stageOrder(stage: InstallStage): number {
  return ORDER.indexOf(stage);
}

/** Journal recovery decision. A crashed operation leaves PARTIAL_INSTALL and
 * status remains read-only. A subsequent authorized command first reconciles
 * the journal; a stale lock is never deleted from PID absence alone.
 * - absent journal + absent manifest: fresh install path
 * - COMMITTED journal matching manifest: clean
 * - intermediate/mismatched journal: PARTIAL_INSTALL (reconcile, do not auto-delete/replay)
 */
export function reconcileJournal(journal: Buffer | null, manifest: Buffer | null): {
  state: 'clean-absent' | 'clean-committed' | 'partial';
} {
  if (journal === null && manifest === null) return { state: 'clean-absent' };
  if (journal !== null && manifest !== null
    && validateManifestBytes(manifest) && validateCommittedJournal(journal, manifest)) {
    return { state: 'clean-committed' };
  }
  return { state: 'partial' };
}

export function manifestSha(manifest: Buffer): string {
  return shaBytes(manifest);
}
