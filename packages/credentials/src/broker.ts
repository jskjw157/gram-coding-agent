/**
 * CredentialBroker — use-only credential boundary (MAC-04 WP-15, D3/D10/D11).
 *
 * RED stub: every call fails closed. GREEN implementation follows in the
 * next atomic commit. No secret_get/list/search API exists by design.
 */

export interface CredentialUseInput {
  readonly intentHash: string;
  readonly permitId: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly scope: string;
}

export interface CredentialReceipt {
  readonly permitId: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly scope: string;
  readonly usedAt: string;
  readonly resultDigest: string;
}

export class CredentialBrokerError extends Error {
  override name = 'CredentialBrokerError';
}

export interface FixtureLease {
  withValue<T>(use: (value: string) => T): T;
  dispose(): void;
}

export interface FixtureVault {
  getForUse(name: string): Promise<FixtureLease>;
}

export interface CredentialPermit {
  readonly id: string;
  readonly intentHash: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly scope: string;
  readonly expiresAt: number;
}

export interface CredentialBrokerOptions {
  readonly vault: FixtureVault;
  readonly permits: readonly CredentialPermit[];
  readonly clock?: () => number;
}

export type ApprovedWorker = (secret: string) => unknown | Promise<unknown>;

/** Bound credential use. Worker runs inside the lease; only a receipt leaves. */
export async function credential_use(
  _input: CredentialUseInput,
  _broker: CredentialBroker,
  _worker: ApprovedWorker,
): Promise<CredentialReceipt> {
  throw new CredentialBrokerError('RED: credential_use not implemented');
}

export class CredentialBroker {
  constructor(_options: CredentialBrokerOptions) {
    void _options;
  }

  credentialUse(
    _input: CredentialUseInput,
    _worker: ApprovedWorker,
  ): Promise<CredentialReceipt> {
    return credential_use(_input, this, _worker);
  }
}
