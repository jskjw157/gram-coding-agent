/** Closed lab-database schema guard. Rollback reads schema_migrations from a
 * stopped lab DB in read-only mode; it never invokes a release migration
 * function as a compatibility probe. The candidate release declares acceptable
 * applied-version sets; the actual complete set must match exactly.
 */

/** Pure compatibility predicate. Consumes versions from schema_migrations and
 * an independently trusted release policy. Proves nothing about DB closure,
 * migration compatibility, or release provenance by itself.
 */
export function schemaCompatible(
  actual: unknown,
  accepted: readonly (readonly number[])[],
): boolean {
  if (!Array.isArray(actual) || !actual.every(v => Number.isSafeInteger(v) && (v as number) > 0)) return false;
  const versions = actual as number[];
  if (new Set(versions).size !== versions.length) return false;
  const key = [...versions].sort((a, b) => a - b).join(',');
  return accepted.some(set =>
    Array.isArray(set)
    && set.every(v => Number.isSafeInteger(v) && (v as number) > 0)
    && new Set(set).size === set.length
    && [...set].sort((a, b) => a - b).join(',') === key);
}

export type SchemaReadingState = 'absent' | 'present' | 'unreadable' | 'corrupt';

/** Narrow parser for an already-read closed-schema payload. The native port
 * must obtain bytes with the core stopped and the DB closed; this function
 * only validates the decoded version list shape. Missing DB (never opened)
 * is absent, not an empty unreadable list. Never copies a live SQLite/WAL
 * pair, deletes the DB, or trusts SQLite user_version alone.
 */
export function parseClosedVersions(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  if (!value.every(v => Number.isSafeInteger(v) && (v as number) > 0)) return null;
  if (new Set(value).size !== value.length) return null;
  return [...(value as number[])];
}

export function decideRollbackSchema(input: {
  state: SchemaReadingState;
  versions: number[] | null;
  accepted: readonly (readonly number[])[] | null;
}): { ok: boolean; code: 'OK' | 'ROLLBACK_BLOCKED_SCHEMA' } {
  if (input.accepted === null) return { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' };
  if (input.state === 'absent') {
    // Pre-first-start: no migrations applied yet. Only an explicitly empty
    // accepted set proves this case; do not coerce to an empty version list.
    const allowsEmpty = input.accepted.some(set => Array.isArray(set) && set.length === 0);
    return allowsEmpty ? { ok: true, code: 'OK' } : { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' };
  }
  if (input.state !== 'present' || input.versions === null) {
    return { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' };
  }
  return schemaCompatible(input.versions, input.accepted)
    ? { ok: true, code: 'OK' }
    : { ok: false, code: 'ROLLBACK_BLOCKED_SCHEMA' };
}
