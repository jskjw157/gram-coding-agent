/**
 * CredentialBroker — use-only credential boundary (MAC-04 WP-15, D3/D10/D11).
 *
 * The broker exposes a single operation: bound credential USE. There is no
 * secret_get/list/search API by design (D3). The broker owns no business
 * semantics (D10/D11): the caller supplies an approved worker callback that
 * runs inside the secret lease, and only a sanitized receipt leaves — the
 * raw secret never leaves the boundary.
 *
 * Fail-closed rejections: unknown/arbitrary ref, wrong peer, changed permit
 * identity (intent/recipe/scope), replay (single-use permits), expiry, and
 * locked vault. A worker that returns the raw secret is rejected.
 */

import { createHash } from 'node:crypto';

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

/** Minimal lease shape mirroring @gram/secrets boundary conventions (read-only reference). */
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

/** Approved business logic. Runs inside the lease; its return value never leaves raw. */
export type ApprovedWorker = (secret: string) => unknown | Promise<unknown>;

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const assertBound = (value: string, label: string): void => {
  if (value.length === 0) {
    throw new CredentialBrokerError(`credential use rejected: ${label} must be bound (non-empty)`);
  }
};

export class CredentialBroker {
  private readonly vault: FixtureVault;
  private readonly permits: ReadonlyMap<string, CredentialPermit>;
  private readonly consumed = new Set<string>();
  private readonly clock: () => number;

  constructor(options: CredentialBrokerOptions) {
    this.vault = options.vault;
    const permits = new Map<string, CredentialPermit>();
    for (const permit of options.permits) permits.set(permit.id, permit);
    this.permits = permits;
    this.clock = options.clock ?? Date.now;
  }

  async credentialUse(input: CredentialUseInput, worker: ApprovedWorker): Promise<CredentialReceipt> {
    assertBound(input.intentHash, 'intentHash');
    assertBound(input.permitId, 'permitId');
    assertBound(input.credentialRef, 'credentialRef');
    assertBound(input.recipeId, 'recipeId');
    assertBound(input.requesterId, 'requesterId');
    assertBound(input.workerId, 'workerId');
    assertBound(input.scope, 'scope');

    const permit = this.permits.get(input.permitId);
    if (permit === undefined) {
      throw new CredentialBrokerError(
        `credential use rejected: unknown permit ${input.permitId}, arbitrary credential use is forbidden`,
      );
    }
    if (this.consumed.has(permit.id)) {
      throw new CredentialBrokerError(
        `credential use rejected: permit ${permit.id} already consumed, single-use replay is forbidden`,
      );
    }
    if (this.clock() > permit.expiresAt) {
      throw new CredentialBrokerError(
        `credential use rejected: permit ${permit.id} expired, re-approval required`,
      );
    }
    if (input.credentialRef !== permit.credentialRef) {
      throw new CredentialBrokerError(
        `credential use rejected: credential ref ${input.credentialRef} is not bound to permit ${permit.id}`,
      );
    }
    if (input.intentHash !== permit.intentHash) {
      throw new CredentialBrokerError(
        `credential use rejected: operation identity changed for permit ${permit.id}, re-approval required`,
      );
    }
    if (input.recipeId !== permit.recipeId) {
      throw new CredentialBrokerError(
        `credential use rejected: changed recipe ${input.recipeId} for permit ${permit.id}, re-approval required`,
      );
    }
    if (input.requesterId !== permit.requesterId || input.workerId !== permit.workerId) {
      throw new CredentialBrokerError(
        `credential use rejected: wrong peer for permit ${permit.id}, requester/worker binding mismatch`,
      );
    }
    if (input.scope !== permit.scope) {
      throw new CredentialBrokerError(
        `credential use rejected: changed scope for permit ${permit.id}, re-approval required`,
      );
    }

    // Single-use: consume before touching the vault so no replay can follow.
    this.consumed.add(permit.id);

    let lease: FixtureLease;
    try {
      lease = await this.vault.getForUse(permit.credentialRef);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CredentialBrokerError(
        `credential use rejected: credential vault is locked/unavailable for permit ${permit.id}: ${detail}`,
      );
    }

    try {
      let observed = '';
      const outcome = await lease.withValue((secret) => {
        observed = secret;
        return worker(secret);
      });
      const rendered = JSON.stringify(outcome) ?? String(outcome);
      if (observed.length > 0 && rendered.includes(observed)) {
        throw new CredentialBrokerError(
          `credential use rejected: worker must not return the raw secret for permit ${permit.id}, only a sanitized receipt leaves the broker`,
        );
      }
      return {
        permitId: permit.id,
        credentialRef: permit.credentialRef,
        recipeId: permit.recipeId,
        requesterId: permit.requesterId,
        workerId: permit.workerId,
        scope: permit.scope,
        usedAt: new Date(this.clock()).toISOString(),
        resultDigest: sha256Hex(rendered),
      };
    } finally {
      lease.dispose();
    }
  }
}

/** Bound credential use. The worker runs inside the lease; only a receipt leaves. */
export async function credential_use(
  input: CredentialUseInput,
  broker: CredentialBroker,
  worker: ApprovedWorker,
): Promise<CredentialReceipt> {
  return broker.credentialUse(input, worker);
}
