/**
 * Per-domain account mapping — FIXTURE level, SYNTHETIC EXAMPLE VALUES ONLY.
 *
 * EXAMPLE_OPS_UID / EXAMPLE_CODING_UID and EXAMPLE_OPS_USER /
 * EXAMPLE_CODING_USER are synthetic placeholders for fixture tests. They
 * resemble UID values but are NEVER production config sources: the real
 * UID-role binding comes from target-Mac account discovery at WP-20.
 * No account/user mutation.
 */

export type DomainName = 'OPERATIONS' | 'CODING';

/** Synthetic example UID for the OPERATIONS fixture peer — not a production UID. */
export const EXAMPLE_OPS_UID = 502 as const;
/** Synthetic example UID for the CODING fixture peer — not a production UID. */
export const EXAMPLE_CODING_UID = 503 as const;

/** Synthetic example username for the OPERATIONS fixture peer. */
export const EXAMPLE_OPS_USER = 'example_ops' as const;
/** Synthetic example username for the CODING fixture peer. */
export const EXAMPLE_CODING_USER = 'example_code' as const;

/** Marker: every value in this module is a synthetic fixture example. */
export const SYNTHETIC_EXAMPLE = true as const;

export interface DomainAccount {
  readonly user: typeof EXAMPLE_OPS_USER | typeof EXAMPLE_CODING_USER;
  readonly uid: typeof EXAMPLE_OPS_UID | typeof EXAMPLE_CODING_UID;
  readonly domain: DomainName;
}

export class AccountMappingError extends Error {
  override name = 'AccountMappingError';
}

/** Synthetic example account facts — never discovered at runtime, never production config. */
export const domainAccountFor = (domain: DomainName): DomainAccount => {
  switch (domain) {
    case 'OPERATIONS':
      return { user: EXAMPLE_OPS_USER, uid: EXAMPLE_OPS_UID, domain: 'OPERATIONS' };
    case 'CODING':
      return { user: EXAMPLE_CODING_USER, uid: EXAMPLE_CODING_UID, domain: 'CODING' };
  }
};
