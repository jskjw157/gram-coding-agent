/**
 * Managed browser-profile path ownership rules — FIXTURE level.
 *
 * Profile dirs live under domain homes with mode 0700. No filesystem
 * mutation here: pure path-ownership predicate.
 */

export class ProfilePathError extends Error {
  override name = 'ProfilePathError';
}

/** RED STUB: accepts any path. GREEN: enforce domain-home + 0700 contract. */
export const approveProfilePath = (_profilePath: string, _domainHome: string): void => undefined;

/** Expected POSIX mode for managed profile dirs. */
export const PROFILE_DIR_MODE = 0o700;
