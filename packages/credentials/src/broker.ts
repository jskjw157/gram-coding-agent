/**
 * CredentialBroker — use-only credential boundary (MAC-04 WP-15, D3/D10/D11).
 *
 * There is no secret_get/list/search API by design (D3). The broker owns no
 * business semantics (D10/D11): the caller names a pre-registered
 * credential-owning capability plus a typed provider operation, and only a
 * sanitized receipt leaves — raw credential material never crosses to caller
 * code. No caller-supplied callback ever receives credential material.
 *
 * Fail-closed rejections: unknown/arbitrary ref, wrong peer, changed permit
 * identity (intent/recipe/scope), replay (single-use permits), expiry,
 * unregistered capability, capability binding mismatch, exfil outcome, and
 * locked vault. Failures carry fixed typed codes; upstream messages are
 * mapped to codes with redacted detail only.
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

/** Typed provider operation. Carries business parameters only — never credential material. */
export interface ProviderOperation {
  readonly kind: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Bound invocation handed to a registered capability. Contains identity + operation only. */
export interface CapabilityInvocation {
  readonly permitId: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly workerId: string;
  readonly scope: string;
  readonly operation: ProviderOperation;
}

/**
 * Pre-registered credential-owning capability. Registered with the broker
 * ahead of use and bound to one credential ref / recipe / worker / scope.
 * Its execute handler receives bound identity plus the typed operation —
 * never raw credential material.
 */
export interface CredentialCapability {
  readonly capabilityId: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly workerId: string;
  readonly scope: string;
  execute(invocation: CapabilityInvocation): unknown | Promise<unknown>;
}

export interface CredentialUseRequest {
  readonly capabilityId: string;
  readonly operation: ProviderOperation;
}

export type CredentialBrokerErrorCode =
  | 'UNKNOWN_PERMIT'
  | 'PERMIT_REPLAY'
  | 'PERMIT_EXPIRED'
  | 'CREDENTIAL_REF_MISMATCH'
  | 'IDENTITY_CHANGED'
  | 'RECIPE_MISMATCH'
  | 'PEER_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'UNREGISTERED_CAPABILITY'
  | 'CAPABILITY_BINDING_MISMATCH'
  | 'VAULT_UNAVAILABLE'
  | 'OPERATION_FAILED'
  | 'EXFIL_BLOCKED'
  | 'UNBOUND_INPUT';

export class CredentialBrokerError extends Error {
  override name = 'CredentialBrokerError';
  readonly code: CredentialBrokerErrorCode;

  constructor(code: CredentialBrokerErrorCode, detail: string) {
    super(`credential use rejected [${code}]: ${detail}`);
    this.code = code;
  }
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
  readonly capabilities: readonly CredentialCapability[];
  readonly clock?: () => number;
}

const REDACTED = '***REDACTED***';

/** Token-shape scrubs mirroring @gram/secrets redactor patterns (read-only reuse, no import). */
function redactTokenShapes(text: string): string {
  let output = text;
  output = output.replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`);
  output = output.replace(
    /\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})\b/g,
    REDACTED,
  );
  output = output.replace(/Bearer\s+[A-Za-z0-9._~-]{8,}/g, `Bearer ${REDACTED}`);
  return output;
}

/**
 * Map an upstream failure to redacted detail. Only the failure *kind*
 * survives; raw messages, host/backend identifiers, and token-shaped
 * substrings are stripped so nothing sensitive leaks into broker errors.
 */
function toSafeDetail(kind: string, _raw: unknown): string {
  void _raw;
  return `${redactTokenShapes(kind)} (${REDACTED})`;
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const assertBound = (value: string, label: string): void => {
  if (value.length === 0) {
    throw new CredentialBrokerError('UNBOUND_INPUT', `${label} must be bound (non-empty)`);
  }
};

const assertOperationBound = (operation: ProviderOperation): void => {
  assertBound(operation.kind, 'operation.kind');
  for (const [key, entry] of Object.entries(operation.fields)) {
    assertBound(key, 'operation.fields key');
    assertBound(entry, `operation.fields[${key}]`);
  }
};

export class CredentialBroker {
  private readonly vault: FixtureVault;
  private readonly permits: ReadonlyMap<string, CredentialPermit>;
  private readonly capabilities: ReadonlyMap<string, CredentialCapability>;
  private readonly consumed = new Set<string>();
  private readonly clock: () => number;

  constructor(options: CredentialBrokerOptions) {
    this.vault = options.vault;
    const permits = new Map<string, CredentialPermit>();
    for (const permit of options.permits) permits.set(permit.id, permit);
    this.permits = permits;
    const capabilities = new Map<string, CredentialCapability>();
    for (const capability of options.capabilities) capabilities.set(capability.capabilityId, capability);
    this.capabilities = capabilities;
    this.clock = options.clock ?? Date.now;
  }

  async credentialUse(
    input: CredentialUseInput,
    request: CredentialUseRequest,
  ): Promise<CredentialReceipt> {
    assertBound(input.intentHash, 'intentHash');
    assertBound(input.permitId, 'permitId');
    assertBound(input.credentialRef, 'credentialRef');
    assertBound(input.recipeId, 'recipeId');
    assertBound(input.requesterId, 'requesterId');
    assertBound(input.workerId, 'workerId');
    assertBound(input.scope, 'scope');
    assertBound(request.capabilityId, 'capabilityId');
    assertOperationBound(request.operation);

    const permit = this.permits.get(input.permitId);
    if (permit === undefined) {
      throw new CredentialBrokerError('UNKNOWN_PERMIT', 'arbitrary credential use is forbidden');
    }
    if (this.consumed.has(permit.id)) {
      throw new CredentialBrokerError('PERMIT_REPLAY', 'single-use permit already consumed');
    }
    if (this.clock() > permit.expiresAt) {
      throw new CredentialBrokerError('PERMIT_EXPIRED', 're-approval required');
    }
    if (input.credentialRef !== permit.credentialRef) {
      throw new CredentialBrokerError(
        'CREDENTIAL_REF_MISMATCH',
        'credential ref is not bound to the permit',
      );
    }
    if (input.intentHash !== permit.intentHash) {
      throw new CredentialBrokerError('IDENTITY_CHANGED', 'operation identity changed, re-approval required');
    }
    if (input.recipeId !== permit.recipeId) {
      throw new CredentialBrokerError('RECIPE_MISMATCH', 'changed recipe, re-approval required');
    }
    if (input.requesterId !== permit.requesterId || input.workerId !== permit.workerId) {
      throw new CredentialBrokerError('PEER_MISMATCH', 'requester/bound-identity binding mismatch');
    }
    if (input.scope !== permit.scope) {
      throw new CredentialBrokerError('SCOPE_MISMATCH', 'changed scope, re-approval required');
    }

    const capability = this.capabilities.get(request.capabilityId);
    if (capability === undefined) {
      throw new CredentialBrokerError('UNREGISTERED_CAPABILITY', 'capability is not registered');
    }
    if (
      capability.credentialRef !== permit.credentialRef ||
      capability.recipeId !== permit.recipeId ||
      capability.workerId !== permit.workerId ||
      capability.scope !== permit.scope
    ) {
      throw new CredentialBrokerError(
        'CAPABILITY_BINDING_MISMATCH',
        'capability binding does not match the permit',
      );
    }

    // Single-use: consume before touching the vault so no replay can follow.
    this.consumed.add(permit.id);

    let lease: FixtureLease;
    try {
      lease = await this.vault.getForUse(permit.credentialRef);
    } catch (failure) {
      throw new CredentialBrokerError('VAULT_UNAVAILABLE', toSafeDetail('vault locked/unavailable', failure));
    }

    try {
      let observed = '';
      let outcome: unknown;
      try {
        outcome = await lease.withValue((material: string) => {
          observed = material;
          return capability.execute({
            permitId: permit.id,
            credentialRef: permit.credentialRef,
            recipeId: permit.recipeId,
            workerId: permit.workerId,
            scope: permit.scope,
            operation: request.operation,
          });
        });
      } catch (failure) {
        if (failure instanceof CredentialBrokerError) throw failure;
        throw new CredentialBrokerError('OPERATION_FAILED', toSafeDetail('provider operation failed', failure));
      }
      const rendered = JSON.stringify(outcome) ?? String(outcome);
      if (observed.length > 0 && rendered.includes(observed)) {
        throw new CredentialBrokerError(
          'EXFIL_BLOCKED',
          `capability outcome echoes credential material (${REDACTED})`,
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

/** Bound credential use. Runs the registered capability; only a receipt leaves. */
export async function credential_use(
  input: CredentialUseInput,
  broker: CredentialBroker,
  request: CredentialUseRequest,
): Promise<CredentialReceipt> {
  return broker.credentialUse(input, request);
}
