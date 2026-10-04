/**
 * Helper manifest loader — FIXTURE level.
 *
 * RED STUB (fail-open): accepts any operation name. GREEN step enforces
 * the allowlisted IPC operations from helper-manifest.json only.
 */

export interface HelperManifestShape {
  readonly entryPoints: Record<string, string>;
  readonly release: Record<string, string>;
  readonly allowlistedOperations: readonly string[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

/** RED STUB: accepts any operation. GREEN: allowlisted-operation-only. */
export const approveOperation = (_operation: string, _manifest: HelperManifestShape): void =>
  undefined;
