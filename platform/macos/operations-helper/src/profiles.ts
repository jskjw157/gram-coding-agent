/**
 * Managed browser-profile path ownership rules — FIXTURE level.
 *
 * Profile dirs live under domain homes with mode 0700. No filesystem
 * mutation here: pure path-ownership predicate.
 */

export class ProfilePathError extends Error {
  override name = 'ProfilePathError';
}

/** Managed profile dirs must live under the domain home (no escape, no foreign home). */
export const approveProfilePath = (profilePath: string, domainHome: string): void => {
  if (profilePath.length === 0 || domainHome.length === 0) {
    throw new ProfilePathError('profile path refused: path and domain home must be bound');
  }
  const prefix = domainHome.endsWith('/') ? domainHome : `${domainHome}/`;
  if (!profilePath.startsWith(prefix) || profilePath.length === prefix.length) {
    throw new ProfilePathError(
      `profile path refused: foreign profile '${profilePath}' outside domain home '${domainHome}'`,
    );
  }
  const rest = profilePath.slice(prefix.length);
  if (rest.split('/').includes('..')) {
    throw new ProfilePathError(`profile path refused: traversal in '${profilePath}'`);
  }
};

/** Expected POSIX mode for managed profile dirs. */
export const PROFILE_DIR_MODE = 0o700;
