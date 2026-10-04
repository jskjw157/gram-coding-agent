/**
 * Per-domain account mapping — FIXTURE level (D5 OS account floor).
 *
 * Target-Mac facts treated as config, never discovered at runtime:
 * mac_ops UID 502 OPERATIONS, mac_code UID 503 CODING.
 * No account/user mutation.
 */

export type DomainName = 'OPERATIONS' | 'CODING';

export interface DomainAccount {
  readonly user: 'mac_ops' | 'mac_code';
  readonly uid: 502 | 503;
  readonly domain: DomainName;
}

export class AccountMappingError extends Error {
  override name = 'AccountMappingError';
}

/** Target-Mac account facts as config — never discovered at runtime. */
export const domainAccountFor = (domain: DomainName): DomainAccount => {
  switch (domain) {
    case 'OPERATIONS':
      return { user: 'mac_ops', uid: 502, domain: 'OPERATIONS' };
    case 'CODING':
      return { user: 'mac_code', uid: 503, domain: 'CODING' };
  }
};
