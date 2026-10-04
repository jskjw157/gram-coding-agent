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

/** Allowlisted-operation-only acceptance: anything not in the manifest is refused. */
export const approveOperation = (operation: string, manifest: HelperManifestShape): void => {
  if (operation.length === 0) {
    throw new ManifestError('operation refused: name must be bound (non-empty)');
  }
  if (!manifest.allowlistedOperations.includes(operation)) {
    throw new ManifestError(
      `operation refused: '${operation}' not in manifest allowlist (allowlisted-operation-only)`,
    );
  }
};
