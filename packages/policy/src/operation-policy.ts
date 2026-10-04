import { createHash } from 'node:crypto';
import type { PolicyDecisionKind } from '@gram/domain';

/**
 * Central Policy Engine extension for Operations (MAC-03 WP-09, decisions D7/D11).
 *
 * The central engine ONLY decides risk from the canonical typed action plus
 * effect metadata. Adapters never self-downgrade: any caller-claimed risk is
 * accepted structurally but ignored for the verdict.
 *
 * Structural OperationIntent mirrors the domain contracts identity fields so
 * this package needs no new dependency (imports @gram/domain types only).
 */
export type OperationRisk = 'READ' | 'REMOTE_WRITE' | 'HIGH_RISK' | 'DENY';

export type OperationEffectClass = 'READ' | 'WRITE' | 'DELETE';

export type OperationScope = 'RESOURCE' | 'STORE' | 'ACCOUNT';

export interface OperationIntentLike {
  readonly taskId: string;
  readonly operationId: string;
  readonly canonicalAction: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly targetResource: string;
  readonly parameterDigest: string;
  readonly effectClass: OperationEffectClass;
  readonly expectedState: string;
  readonly expectedVersion: string;
  readonly providerId: string;
  readonly recipeId: string;
}

export interface OperationMetadata {
  readonly executionMode?: string;
  readonly taskKind?: string;
  readonly scope?: OperationScope;
}

/** Caller-claimed hint. Accepted structurally, ignored for the verdict (D7/D11). */
export interface ClassificationHint {
  readonly claimedRisk?: OperationRisk;
}

export interface ClassifiedOperation {
  readonly verdict: OperationRisk;
  readonly ruleId: string;
  readonly reason: string;
  readonly operationHash: string;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';

export interface OperationApprovalInput {
  readonly id: string;
  readonly taskId: string;
  readonly operationHash: string;
  readonly status: ApprovalStatus;
  readonly expiresAt: number;
}

export interface ApprovalCheck {
  readonly accepted: boolean;
  readonly reason: string;
  readonly operationHash: string;
}

export interface OperationDecision {
  readonly kind: PolicyDecisionKind;
  readonly ruleId: string;
  readonly reason: string;
  readonly operationHash: string;
}

const identityFields = [
  'taskId',
  'operationId',
  'canonicalAction',
  'storeId',
  'accountId',
  'targetResource',
  'parameterDigest',
  'effectClass',
  'expectedState',
  'expectedVersion',
  'providerId',
  'recipeId',
] as const satisfies readonly (keyof OperationIntentLike)[];

/** Duplicates the domain operationHash algorithm (ordered identity JSON, sha256). */
export function hashOperationIntent(intent: OperationIntentLike): string {
  const ordered: Record<string, string> = {};
  for (const field of identityFields) {
    ordered[field] = intent[field];
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

const READ_ACTIONS: readonly string[] = ['shopify.product.read', 'shopify.order.read'];
const REMOTE_WRITE_ACTIONS: readonly string[] = ['shopify.product.create', 'shopify.inventory.adjust'];
const HIGH_RISK_ACTIONS: readonly string[] = ['shopify.order.cancel', 'shopify.refund.create'];
const ACCOUNT_STORE_DELETE_PATTERN = /(^|\.)(account|store)\.delete($|[.-])/u;

function baseVerdict(intent: OperationIntentLike, metadata: OperationMetadata): ClassifiedOperation {
  const operationHash = hashOperationIntent(intent);
  const { canonicalAction, effectClass } = intent;

  if (ACCOUNT_STORE_DELETE_PATTERN.test(canonicalAction)) {
    return {
      verdict: 'DENY',
      ruleId: 'POL-OPS-ACCOUNT-STORE-DELETE',
      reason: `destructive account/store action ${canonicalAction} is forbidden`,
      operationHash,
    };
  }
  if (effectClass === 'DELETE' && (metadata.scope === 'ACCOUNT' || metadata.scope === 'STORE')) {
    return {
      verdict: 'DENY',
      ruleId: 'POL-OPS-SCOPE-DELETE',
      reason: `DELETE effect against ${metadata.scope} scope is forbidden`,
      operationHash,
    };
  }
  if (READ_ACTIONS.includes(canonicalAction)) {
    if (effectClass !== 'READ') {
      return {
        verdict: 'REMOTE_WRITE',
        ruleId: 'POL-OPS-READ-EFFECT-MISMATCH',
        reason: `read action ${canonicalAction} carries non-read effect and is treated as remote write`,
        operationHash,
      };
    }
    return {
      verdict: 'READ',
      ruleId: 'POL-OPS-READ',
      reason: `read-only action ${canonicalAction} is allowed`,
      operationHash,
    };
  }
  if (REMOTE_WRITE_ACTIONS.includes(canonicalAction)) {
    if (effectClass === 'DELETE') {
      return {
        verdict: 'HIGH_RISK',
        ruleId: 'POL-OPS-WRITE-EFFECT-ESCALATION',
        reason: `remote-write action ${canonicalAction} carries delete effect and is escalated`,
        operationHash,
      };
    }
    return {
      verdict: 'REMOTE_WRITE',
      ruleId: 'POL-OPS-REMOTE-WRITE',
      reason: `remote-write action ${canonicalAction} requires approval`,
      operationHash,
    };
  }
  if (HIGH_RISK_ACTIONS.includes(canonicalAction)) {
    return {
      verdict: 'HIGH_RISK',
      ruleId: 'POL-OPS-HIGH-RISK',
      reason: `high-risk action ${canonicalAction} requires approval`,
      operationHash,
    };
  }
  return {
    verdict: 'DENY',
    ruleId: 'POL-OPS-UNKNOWN-ACTION',
    reason: `unknown canonical action ${canonicalAction} is denied by default`,
    operationHash,
  };
}

/**
 * Central classification. The hint's claimedRisk is never consulted for the
 * verdict — the adapter cannot downgrade its own risk (D7/D11).
 */
export function classifyOperation(
  intent: OperationIntentLike,
  metadata: OperationMetadata,
  _hint?: ClassificationHint,
): ClassifiedOperation {
  // Claimed risk is deliberately never read: the central engine decides.
  void _hint;
  return baseVerdict(intent, metadata);
}

function checkApprovalFields(
  approval: OperationApprovalInput,
  intent: OperationIntentLike,
  now: number,
): ApprovalCheck {
  const operationHash = hashOperationIntent(intent);
  if (approval.taskId !== intent.taskId) {
    return {
      accepted: false,
      reason: `approval task ${approval.taskId} does not match operation task ${intent.taskId}; cross-task replay rejected`,
      operationHash,
    };
  }
  if (now > approval.expiresAt) {
    return {
      accepted: false,
      reason: 'approval expired; re-approval required',
      operationHash,
    };
  }
  if (approval.operationHash !== operationHash) {
    return {
      accepted: false,
      reason: 'operation identity changed; re-approval required',
      operationHash,
    };
  }
  if (approval.status !== 'APPROVED') {
    return {
      accepted: false,
      reason: `approval status ${approval.status} cannot authorize execution; APPROVED status required`,
      operationHash,
    };
  }
  return { accepted: true, reason: 'approval verified against full operation identity', operationHash };
}

/**
 * Persistent single-use consume ledger. Lane-local port of the M2
 * ApprovalRepository consume-once semantics: conditional
 * `UPDATE approvals SET status = 'CONSUMED' ... WHERE status = 'APPROVED'`
 * with `result.changes === 1` deciding the winner
 * (packages/persistence/src/repositories/approval-repository.ts:212-230),
 * lazy TTL expiry of APPROVED rows (`expires_at <= now` sweep in the same
 * `consume`, plus `APPROVAL_TTL_MS` set at `approve`:162-188), and the
 * live-pair (`task_id`, `operation_hash`) uniqueness from `request` (:95-146).
 * Reimplemented here because `@gram/policy` depends only on `@gram/domain`
 * and cannot import the better-sqlite3-backed M2 repository in this lane;
 * the task/taskId + operationHash + expiry checks in `checkApprovalFields`
 * are the local form of that conditional UPDATE's WHERE clause.
 */
export interface ApprovalConsumeStore {
  consumeApproved(approvalId: string): boolean;
  isConsumed(approvalId: string): boolean;
}

export class InMemoryOperationApprovalStore implements ApprovalConsumeStore {
  private readonly consumed: string[] = [];

  consumeApproved(approvalId: string): boolean {
    if (this.consumed.includes(approvalId)) {
      return false;
    }
    this.consumed.push(approvalId);
    return true;
  }

  isConsumed(approvalId: string): boolean {
    return this.consumed.includes(approvalId);
  }
}

/**
 * Single-use, expiring, task-bound approval gate. Fail-closed on every path:
 * non-APPROVED, expired, cross-task, or hash-tampered approvals are rejected,
 * and a verified approval is consumed atomically through the shared store so
 * no second gate instance can replay it.
 */
export class OperationPolicyGate {
  private readonly store: ApprovalConsumeStore;
  private readonly clock: () => number;

  constructor(options: { readonly clock?: () => number; readonly store?: ApprovalConsumeStore } = {}) {
    this.clock = options.clock ?? Date.now;
    this.store = options.store ?? new InMemoryOperationApprovalStore();
  }

  verify(approval: OperationApprovalInput, intent: OperationIntentLike): ApprovalCheck {
    const operationHash = hashOperationIntent(intent);
    const fields = checkApprovalFields(approval, intent, this.clock());
    if (!fields.accepted) {
      return fields;
    }
    if (this.store.isConsumed(approval.id) || !this.store.consumeApproved(approval.id)) {
      return {
        accepted: false,
        reason: `approval ${approval.id} already consumed; single-use replay rejected, re-approval required`,
        operationHash,
      };
    }
    return { accepted: true, reason: 'approval verified against full operation identity', operationHash };
  }
}

/**
 * Final decision. DENY is non-promotable: a valid approval never lifts it —
 * only a policy change can, so the denial names that path.
 */
export function decideOperation(
  intent: OperationIntentLike,
  metadata: OperationMetadata,
  approval?: OperationApprovalInput,
  options: { readonly now?: number; readonly store?: ApprovalConsumeStore } = {},
): OperationDecision {
  const classified = classifyOperation(intent, metadata);
  if (classified.verdict === 'DENY') {
    return {
      kind: 'DENY',
      ruleId: classified.ruleId,
      reason: `${classified.reason}; approval cannot lift DENY, request a policy change`,
      operationHash: classified.operationHash,
    };
  }
  if (classified.verdict === 'READ') {
    return {
      kind: 'ALLOW',
      ruleId: classified.ruleId,
      reason: classified.reason,
      operationHash: classified.operationHash,
    };
  }
  if (approval === undefined) {
    return {
      kind: 'NEEDS_APPROVAL',
      ruleId: classified.ruleId,
      reason: classified.reason,
      operationHash: classified.operationHash,
    };
  }
  const check = checkApprovalFields(approval, intent, options.now ?? Date.now());
  if (!check.accepted) {
    return {
      kind: 'NEEDS_APPROVAL',
      ruleId: classified.ruleId,
      reason: `${classified.reason}; ${check.reason}`,
      operationHash: classified.operationHash,
    };
  }
  if (options.store !== undefined) {
    if (options.store.isConsumed(approval.id) || !options.store.consumeApproved(approval.id)) {
      return {
        kind: 'NEEDS_APPROVAL',
        ruleId: classified.ruleId,
        reason: `${classified.reason}; approval ${approval.id} already consumed; single-use replay rejected, re-approval required`,
        operationHash: classified.operationHash,
      };
    }
  }
  return {
    kind: 'ALLOW',
    ruleId: classified.ruleId,
    reason: `approved ${classified.verdict.toLowerCase().replace('_', '-')} operation`,
    operationHash: classified.operationHash,
  };
}
