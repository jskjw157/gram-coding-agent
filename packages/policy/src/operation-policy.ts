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

export type ApprovalStatus = 'PENDING' | 'APPROVED';

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
  if (approval.status !== 'PENDING' && approval.status !== 'APPROVED') {
    const status: string = approval.status;
    return { accepted: false, reason: `approval status ${status} cannot authorize execution`, operationHash };
  }
  return { accepted: true, reason: 'approval verified against full operation identity', operationHash };
}

/**
 * Single-use, expiring, task-bound approval gate. Fail-closed on every path:
 * consumed, expired, cross-task, or hash-tampered approvals are rejected.
 */
export class OperationPolicyGate {
  private readonly consumedIds = new Set<string>();
  private readonly clock: () => number;

  constructor(options: { readonly clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  verify(approval: OperationApprovalInput, intent: OperationIntentLike): ApprovalCheck {
    const operationHash = hashOperationIntent(intent);
    if (this.consumedIds.has(approval.id)) {
      return {
        accepted: false,
        reason: `approval ${approval.id} already consumed; single-use replay rejected, re-approval required`,
        operationHash,
      };
    }
    return checkApprovalFields(approval, intent, this.clock());
  }

  consume(approvalId: string): void {
    this.consumedIds.add(approvalId);
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
  options: { readonly now?: number } = {},
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
  return {
    kind: 'ALLOW',
    ruleId: classified.ruleId,
    reason: `approved ${classified.verdict.toLowerCase().replace('_', '-')} operation`,
    operationHash: classified.operationHash,
  };
}
