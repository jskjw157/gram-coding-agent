/**
 * Canonical Shopify typed adapter (MAC-04/05 WP-18, D1/D10/D11).
 *
 * Registry identity shopify.v1. Submits canonical typed actions plus effect
 * metadata and consumes Policy Engine verdicts structurally — the verdict
 * shape mirrors origin/feat/ops-policy-approval, which is never edited here.
 * Caller-claimed risk is accepted structurally but ignored for the verdict;
 * only the central ALLOW verdict authorizes execution.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  ShopifyTransport,
  SHOPIFY_ACTION_NAMES,
  type ShopifyActionName,
} from './transport.js';

export type { ShopifyActionName };
export { SHOPIFY_ACTION_NAMES };

export const SHOPIFY_PROVIDER_ID = 'shopify.v1';

export type PolicyDecisionKind = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';

export type OperationRisk = 'READ' | 'REMOTE_WRITE' | 'HIGH_RISK' | 'DENY';

export type ShopifyEffectClass = 'READ' | 'WRITE' | 'DELETE';

export interface PolicyVerdictLike {
  readonly kind: PolicyDecisionKind;
  readonly ruleId: string;
  readonly reason: string;
  readonly operationHash: string;
}

export interface ClassificationHintLike {
  readonly claimedRisk?: OperationRisk;
}

export interface ShopifyPermitLike {
  readonly permitId: string;
  readonly requesterId: string;
  readonly workerId: string;
}

export interface ShopifySubmitContext {
  readonly taskId: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly operationId?: string;
  readonly expectedState?: string;
  readonly expectedVersion?: string;
  readonly permit: ShopifyPermitLike;
  readonly verdict: PolicyVerdictLike;
  readonly hint?: ClassificationHintLike;
}

export interface OperationIntentParts {
  readonly taskId: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly recipeId: string;
  readonly expectedState?: string;
  readonly expectedVersion?: string;
}

export interface ShopifyOperationIntent {
  readonly taskId: string;
  readonly operationId: string;
  readonly canonicalAction: ShopifyActionName;
  readonly storeId: string;
  readonly accountId: string;
  readonly targetResource: string;
  readonly parameterDigest: string;
  readonly effectClass: ShopifyEffectClass;
  readonly expectedState: string;
  readonly expectedVersion: string;
  readonly providerId: string;
  readonly recipeId: string;
  readonly operationHash: string;
}

export interface ArtifactRef {
  readonly artifactId: string;
  readonly digest: string;
  readonly version?: string;
}

export interface ShopifyEffectReceipt {
  readonly operationId: string;
  readonly operationHash: string;
  readonly effectClass: ShopifyEffectClass;
  readonly policyDecision: PolicyDecisionKind;
  readonly appliedAt: string;
  readonly artifacts: ArtifactRef[];
}

export class ShopifyAdapterError extends Error {
  override name = 'ShopifyAdapterError';
}

const ACTION_EFFECT: Record<ShopifyActionName, ShopifyEffectClass> = {
  'shopify.product.read': 'READ',
  'shopify.order.read': 'READ',
  'shopify.product.create': 'WRITE',
  'shopify.inventory.adjust': 'WRITE',
  'shopify.order.cancel': 'DELETE',
  'shopify.refund.create': 'WRITE',
};

const CREDENTIAL_KEY_PATTERN = /token|secret|credential|password|auth/i;

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function targetResource(action: ShopifyActionName, params: Record<string, unknown>, storeId: string): string {
  const idOf = (key: string): string => {
    const id = params[key];
    return typeof id === 'string' && id.length > 0 ? id : 'pending';
  };
  switch (action) {
    case 'shopify.product.read':
    case 'shopify.product.create':
      return `shopify:${storeId}:products/${idOf('productId')}`;
    case 'shopify.inventory.adjust':
      return `shopify:${storeId}:inventory/${idOf('inventoryItemId')}`;
    case 'shopify.order.read':
    case 'shopify.order.cancel':
      return `shopify:${storeId}:orders/${idOf('orderId')}`;
    case 'shopify.refund.create':
      return `shopify:${storeId}:orders/${idOf('orderId')}/refunds`;
  }
}

function hashIntent(intent: Omit<ShopifyOperationIntent, 'operationHash'>): string {
  const ordered: Record<string, string> = {
    taskId: intent.taskId,
    operationId: intent.operationId,
    canonicalAction: intent.canonicalAction,
    storeId: intent.storeId,
    accountId: intent.accountId,
    targetResource: intent.targetResource,
    parameterDigest: intent.parameterDigest,
    effectClass: intent.effectClass,
    expectedState: intent.expectedState,
    expectedVersion: intent.expectedVersion,
    providerId: intent.providerId,
    recipeId: intent.recipeId,
  };
  return sha256Hex(JSON.stringify(ordered));
}

export function createOperationIntent(
  action: string,
  params: Record<string, unknown>,
  parts: OperationIntentParts,
): ShopifyOperationIntent {
  if (!(SHOPIFY_ACTION_NAMES as readonly string[]).includes(action)) {
    throw new ShopifyAdapterError(`unknown canonical action ${action}, adapter serves the six typed Shopify actions only`);
  }
  const canonical = action as ShopifyActionName;
  for (const key of Object.keys(params)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new ShopifyAdapterError(
        `credential-bearing param ${key} refused: credentials are broker-held and never pass through the adapter`,
      );
    }
  }
  const base = {
    taskId: parts.taskId,
    operationId: parts.operationId,
    canonicalAction: canonical,
    storeId: parts.storeId,
    accountId: parts.accountId,
    targetResource: targetResource(canonical, params, parts.storeId),
    parameterDigest: sha256Hex(stableStringify(params)),
    effectClass: ACTION_EFFECT[canonical],
    expectedState: parts.expectedState ?? canonical,
    expectedVersion: parts.expectedVersion ?? 'none',
    providerId: SHOPIFY_PROVIDER_ID,
    recipeId: parts.recipeId,
  };
  return { ...base, operationHash: hashIntent(base) };
}

function artifactIdFor(data: Record<string, unknown>, operationId: string): string {
  for (const section of ['product', 'order', 'refund'] as const) {
    const record = data[section];
    if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
      const id = (record as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  const adjustment = data['inventory_adjustment'];
  if (typeof adjustment === 'object' && adjustment !== null && !Array.isArray(adjustment)) {
    const item = (adjustment as Record<string, unknown>)['inventory_item_id'];
    if (typeof item === 'string' && item.length > 0) return item;
  }
  const cancelJob = data['cancel_job'];
  if (typeof cancelJob === 'object' && cancelJob !== null && !Array.isArray(cancelJob)) {
    const id = (cancelJob as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return operationId;
}

export class ShopifyAdapter {
  constructor(private readonly transport: ShopifyTransport) {}

  async submit(
    action: string,
    params: Record<string, unknown>,
    ctx: ShopifySubmitContext,
  ): Promise<ShopifyEffectReceipt> {
    // The claimed risk is structurally accepted and deliberately never read:
    // the central verdict alone authorizes execution (D7/D11).
    void ctx.hint;
    const intent = createOperationIntent(action, params, {
      taskId: ctx.taskId,
      storeId: ctx.storeId,
      accountId: ctx.accountId,
      operationId: ctx.operationId ?? randomUUID(),
      recipeId: this.transport.recipeId,
      ...(ctx.expectedState === undefined ? {} : { expectedState: ctx.expectedState }),
      ...(ctx.expectedVersion === undefined ? {} : { expectedVersion: ctx.expectedVersion }),
    });
    if (ctx.verdict.operationHash !== intent.operationHash) {
      throw new ShopifyAdapterError(
        'verdict operation hash does not match the operation identity; tampered or stale verdict refused',
      );
    }
    if (ctx.verdict.kind === 'DENY') {
      throw new ShopifyAdapterError(
        `denied by ${ctx.verdict.ruleId}: ${ctx.verdict.reason}; approval cannot lift DENY, request a policy change`,
      );
    }
    if (ctx.verdict.kind !== 'ALLOW') {
      throw new ShopifyAdapterError(
        `approval required by ${ctx.verdict.ruleId}: ${ctx.verdict.reason}`,
      );
    }
    const result = await this.transport.execute(action, params, {
      operationId: intent.operationId,
      intentHash: intent.operationHash,
      permitId: ctx.permit.permitId,
      requesterId: ctx.permit.requesterId,
      workerId: ctx.permit.workerId,
      storeId: ctx.storeId,
    });
    return {
      operationId: intent.operationId,
      operationHash: intent.operationHash,
      effectClass: intent.effectClass,
      policyDecision: 'ALLOW',
      appliedAt: new Date().toISOString(),
      artifacts: [
        { artifactId: artifactIdFor(result.data, intent.operationId), digest: sha256Hex(stableStringify(result.data)) },
      ],
    };
  }
}
