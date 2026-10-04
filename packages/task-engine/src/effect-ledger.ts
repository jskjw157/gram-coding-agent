// effect-ledger.ts — RED stub (not implemented).
export type EffectState = 'PREPARED' | 'DISPATCHING' | 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN';

export type LedgerEffectClass = 'READ' | 'WRITE' | 'DELETE';

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

export class EffectLedger {
  constructor(_onCommit?: (record: EffectRecord) => void) {
    throw new Error('not implemented');
  }

  prepare(_operationId: string, _effectClass: LedgerEffectClass): EffectRecord {
    throw new Error('not implemented');
  }

  get(_effectId: string): EffectRecord | null {
    throw new Error('not implemented');
  }

  dispatch(
    _effectId: string,
    _transmit: () => Promise<'CONFIRMED' | 'NOT_APPLIED'>,
    _guard?: DispatchGuard,
  ): Promise<EffectRecord> {
    throw new Error('not implemented');
  }

  crashRecover(): EffectRecord[] {
    throw new Error('not implemented');
  }

  reconcile(_effectId: string, _evidence: ReconcileEvidence): EffectRecord {
    throw new Error('not implemented');
  }

  requestRetry(_effectId: string, _request: RetryRequest): EffectRecord {
    throw new Error('not implemented');
  }
}
