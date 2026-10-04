// effect-ledger.ts — durable execution core: effect ledger (MAC-03 WP-11, D12).
//
// Lifecycle: PREPARED -> DISPATCHING -> CONFIRMED | NOT_APPLIED | UNKNOWN.
// D12 rules encoded here:
// - Durable-before-effect: DISPATCHING is committed BEFORE transmit runs.
// - Crash during DISPATCHING is UNKNOWN until reconciled (never assumed).
// - Reconcile-before-retry: only a reconciled NOT_APPLIED record can retry.
// - Retry needs policy/approval recheck, not just a local idempotency key.
// - Bounded READ retry budget (MAX_READ_RETRIES); WRITE/DELETE never retry.
// - D12 query-to-tri-state: UNKNOWN settles only via provider-query evidence
//   (provider-confirmed-applied / provider-confirmed-not-applied). Settlement
//   without that evidence stays refused.
//
// This module holds no timers and no scheduler: leases + ledger only.
import { randomUUID } from 'node:crypto';

export type EffectState = 'PREPARED' | 'DISPATCHING' | 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN';

export type LedgerEffectClass = 'READ' | 'WRITE' | 'DELETE';

/** Bounded READ retry budget. WRITE/DELETE effects never auto-retry. */
export const MAX_READ_RETRIES = 3;

/** Provider-query outcome that settles an UNKNOWN effect. Nothing else does. */
export type ProviderQueryEvidence = 'provider-confirmed-applied' | 'provider-confirmed-not-applied';

export interface EffectRecord {
  readonly effectId: string;
  readonly operationId: string;
  readonly effectClass: LedgerEffectClass;
  readonly state: EffectState;
  readonly attempts: number;
  readonly reconciled: boolean;
}

export interface ReconcileEvidence {
  readonly observedState: 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN';
  readonly policyDecision: 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';
  readonly approvalId?: string;
  readonly approvalResolved?: boolean;
  readonly providerEvidence?: ProviderQueryEvidence;
}

export interface RetryRequest {
  readonly localKey?: string;
  readonly evidence?: ReconcileEvidence;
}

export interface DispatchGuard {
  readonly assertUsable?: (resource: string, fenceEpoch: number) => void;
  readonly resource?: string;
  readonly fenceEpoch?: number;
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export class BlindRetryRefusedError extends LedgerError {
  override name = 'BlindRetryRefusedError';
}

export class RetryBudgetExhaustedError extends LedgerError {
  override name = 'RetryBudgetExhaustedError';
}

export class StaleFenceDispatchError extends LedgerError {
  override name = 'StaleFenceDispatchError';
}

interface StoredEffect {
  effectId: string;
  operationId: string;
  effectClass: LedgerEffectClass;
  state: EffectState;
  attempts: number;
  reconciled: boolean;
  reconciledObserved: 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN' | null;
}

const copyOf = (stored: StoredEffect): EffectRecord => ({
  effectId: stored.effectId,
  operationId: stored.operationId,
  effectClass: stored.effectClass,
  state: stored.state,
  attempts: stored.attempts,
  reconciled: stored.reconciled,
});

const retryBudgetFor = (effectClass: LedgerEffectClass): number =>
  effectClass === 'READ' ? MAX_READ_RETRIES : 0;

/**
 * D12 query-to-tri-state: an UNKNOWN effect settles only when the observed
 * state matches provider-query evidence. Every other UNKNOWN transition
 * (evidence-less, mismatched) stays refused.
 */
const settlesUnknownViaProvider = (
  state: EffectState,
  evidence: ReconcileEvidence,
): boolean =>
  state === 'UNKNOWN' &&
  ((evidence.observedState === 'CONFIRMED' &&
    evidence.providerEvidence === 'provider-confirmed-applied') ||
    (evidence.observedState === 'NOT_APPLIED' &&
      evidence.providerEvidence === 'provider-confirmed-not-applied'));

export class EffectLedger {
  private readonly effects = new Map<string, StoredEffect>();
  private readonly commit: (record: EffectRecord) => void;

  constructor(onCommit?: (record: EffectRecord) => void) {
    this.commit = onCommit ?? ((): void => {});
  }

  prepare(operationId: string, effectClass: LedgerEffectClass): EffectRecord {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new LedgerError('operationId must be a non-empty string');
    }
    const stored: StoredEffect = {
      effectId: randomUUID(),
      operationId,
      effectClass,
      state: 'PREPARED',
      attempts: 0,
      reconciled: false,
      reconciledObserved: null,
    };
    this.effects.set(stored.effectId, stored);
    const record = copyOf(stored);
    this.commit(record); // durable PREPARED before anything else happens
    return record;
  }

  get(effectId: string): EffectRecord | null {
    const stored = this.effects.get(effectId);
    return stored === undefined ? null : copyOf(stored);
  }

  async dispatch(
    effectId: string,
    transmit: () => Promise<'CONFIRMED' | 'NOT_APPLIED'>,
    guard?: DispatchGuard,
  ): Promise<EffectRecord> {
    const stored = this.effects.get(effectId);
    if (stored === undefined) throw new LedgerError(`unknown effect: ${effectId}`);
    if (stored.state !== 'PREPARED') {
      throw new LedgerError(`dispatch requires PREPARED, found ${stored.state}`);
    }
    if (guard?.assertUsable !== undefined) {
      if (guard.resource === undefined || guard.fenceEpoch === undefined) {
        throw new LedgerError('dispatch guard needs resource + fenceEpoch');
      }
      try {
        guard.assertUsable(guard.resource, guard.fenceEpoch);
      } catch (error) {
        if (error instanceof StaleFenceDispatchError) throw error;
        throw new StaleFenceDispatchError(
          `stale fence refused: ${guard.resource}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
    }
    // Durable-before-effect: DISPATCHING commits BEFORE transmit runs.
    stored.state = 'DISPATCHING';
    this.commit(copyOf(stored));
    const outcome = await transmit(); // crash here leaves DISPATCHING for recovery
    if (outcome !== 'CONFIRMED' && outcome !== 'NOT_APPLIED') {
      throw new LedgerError('transmit must resolve CONFIRMED or NOT_APPLIED');
    }
    stored.state = outcome;
    const record = copyOf(stored);
    this.commit(record);
    return record;
  }

  /** Map every interrupted DISPATCHING record to UNKNOWN. Never assume. */
  crashRecover(): EffectRecord[] {
    const recovered: EffectRecord[] = [];
    for (const stored of this.effects.values()) {
      if (stored.state === 'DISPATCHING') {
        stored.state = 'UNKNOWN';
        stored.reconciled = false;
        stored.reconciledObserved = null;
        const record = copyOf(stored);
        this.commit(record);
        recovered.push(record);
      }
    }
    return recovered;
  }

  reconcile(effectId: string, evidence: ReconcileEvidence): EffectRecord {
    const stored = this.effects.get(effectId);
    if (stored === undefined) throw new LedgerError(`unknown effect: ${effectId}`);
    if (
      stored.state === 'PREPARED' ||
      stored.state === 'DISPATCHING' ||
      settlesUnknownViaProvider(stored.state, evidence)
    ) {
      // Reconcile observes ground truth for unsettled or interrupted effects,
      // or settles UNKNOWN via matching provider-query evidence.
    } else if (stored.state !== evidence.observedState && evidence.observedState !== 'UNKNOWN') {
      throw new LedgerError(
        `reconcile conflicts with settled ${stored.state}: observed ${evidence.observedState}`,
      );
    }
    stored.state = evidence.observedState;
    stored.reconciled = true;
    stored.reconciledObserved = evidence.observedState;
    const record = copyOf(stored);
    this.commit(record);
    return record;
  }

  requestRetry(effectId: string, request: RetryRequest): EffectRecord {
    const stored = this.effects.get(effectId);
    if (stored === undefined) throw new LedgerError(`unknown effect: ${effectId}`);
    const evidence = request.evidence;
    if (evidence === undefined || !stored.reconciled || stored.reconciledObserved !== 'NOT_APPLIED') {
      throw new BlindRetryRefusedError('retry requires reconcile-first confirming NOT_APPLIED');
    }
    if (evidence.observedState !== 'NOT_APPLIED') {
      throw new BlindRetryRefusedError('retry requires confirmed NOT_APPLIED evidence');
    }
    if (evidence.policyDecision === 'DENY') {
      throw new BlindRetryRefusedError('retry refused: policy DENY on recheck');
    }
    if (evidence.policyDecision === 'NEEDS_APPROVAL') {
      if (evidence.approvalId === undefined || evidence.approvalResolved !== true) {
        throw new BlindRetryRefusedError('retry refused: approval not resolved on recheck');
      }
    }
    if (stored.attempts >= retryBudgetFor(stored.effectClass)) {
      throw new RetryBudgetExhaustedError(
        `retry budget exhausted: ${stored.effectClass} allows ${retryBudgetFor(stored.effectClass)}`,
      );
    }
    stored.attempts += 1;
    stored.state = 'PREPARED';
    stored.reconciled = false;
    stored.reconciledObserved = null;
    const record = copyOf(stored);
    this.commit(record);
    return record;
  }
}
