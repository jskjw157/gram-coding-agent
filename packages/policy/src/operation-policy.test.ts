import { describe, expect, it } from 'vitest';
import {
  OperationPolicyGate,
  classifyOperation,
  decideOperation,
  hashOperationIntent,
  type OperationIntentLike,
  type OperationMetadata,
} from './operation-policy.js';

const baseIntent = (overrides: Partial<OperationIntentLike> = {}): OperationIntentLike => ({
  taskId: 'task-1',
  operationId: 'op-1',
  canonicalAction: 'shopify.product.read',
  storeId: 'store-1',
  accountId: 'acct-1',
  targetResource: 'product/1',
  parameterDigest: 'params-digest-1',
  effectClass: 'READ',
  expectedState: 'state-1',
  expectedVersion: 'v1',
  providerId: 'shopify',
  recipeId: 'recipe-1',
  ...overrides,
});

const meta = (overrides: Partial<OperationMetadata> = {}): OperationMetadata => ({
  executionMode: 'WRITE_APPROVED',
  taskKind: 'COMMAND',
  scope: 'RESOURCE',
  ...overrides,
});

const approvalFor = (intent: OperationIntentLike, overrides: Record<string, unknown> = {}) => ({
  id: 'approval-1',
  taskId: intent.taskId,
  operationHash: hashOperationIntent(intent),
  status: 'PENDING' as const,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

describe('operation action-to-verdict table', () => {
  it.each([
    ['shopify.product.read', 'READ', 'READ'],
    ['shopify.order.read', 'READ', 'READ'],
    ['shopify.product.create', 'WRITE', 'REMOTE_WRITE'],
    ['shopify.inventory.adjust', 'WRITE', 'REMOTE_WRITE'],
    ['shopify.order.cancel', 'WRITE', 'HIGH_RISK'],
    ['shopify.refund.create', 'WRITE', 'HIGH_RISK'],
  ] as const)('%s (%s) -> %s', (action, effectClass, expected) => {
    const verdict = classifyOperation(baseIntent({ canonicalAction: action, effectClass }), meta());
    expect(verdict.verdict).toBe(expected);
    expect(verdict.operationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['shopify.store.delete', 'STORE'],
    ['shopify.account.delete', 'ACCOUNT'],
    ['account.delete', 'ACCOUNT'],
    ['store.delete', 'STORE'],
  ] as const)('DENY default: %s (scope %s)', (action, scope) => {
    const verdict = classifyOperation(
      baseIntent({ canonicalAction: action, effectClass: 'DELETE' }),
      meta({ scope: scope as 'STORE' | 'ACCOUNT' }),
    );
    expect(verdict.verdict).toBe('DENY');
  });

  it('DENY defaults unknown canonical actions (fail-closed)', () => {
    const verdict = classifyOperation(baseIntent({ canonicalAction: 'shopify.unknown.wipe' }), meta());
    expect(verdict.verdict).toBe('DENY');
  });
});

describe('central engine decides risk (adapter cannot self-downgrade)', () => {
  it('ignores a caller-claimed lower risk and keeps HIGH_RISK for refund.create', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.refund.create', effectClass: 'WRITE' });
    const verdict = classifyOperation(intent, meta(), { claimedRisk: 'READ' });
    expect(verdict.verdict).toBe('HIGH_RISK');
  });

  it('ignores a caller-claimed READ for order.cancel', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.order.cancel', effectClass: 'WRITE' });
    const verdict = classifyOperation(intent, meta(), { claimedRisk: 'READ' });
    expect(verdict.verdict).toBe('HIGH_RISK');
  });
});

describe('full-field operation-hash verification', () => {
  it('recomputes the hash and requires re-approval when any identity field changes', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const gate = new OperationPolicyGate();
    const approval = approvalFor(intent);
    const tampered = { ...intent, parameterDigest: 'tampered-digest' };
    const result = gate.verify(approval, tampered);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/re-approval/i);
    expect(hashOperationIntent(tampered)).not.toBe(hashOperationIntent(intent));
  });

  it('rejects targetResource mutation as an identity change', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.order.cancel', effectClass: 'WRITE' });
    const gate = new OperationPolicyGate();
    const approval = approvalFor(intent);
    expect(gate.verify(approval, { ...intent, targetResource: 'order/999' }).accepted).toBe(false);
  });
});

describe('single-use + expiry + cross-task replay rejection', () => {
  it('rejects reuse of a consumed approval (single-use)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const gate = new OperationPolicyGate();
    const approval = approvalFor(intent);
    expect(gate.verify(approval, intent).accepted).toBe(true);
    gate.consume(approval.id);
    expect(gate.verify(approval, intent).accepted).toBe(false);
  });

  it('rejects cross-task replay (approval bound to a different taskId)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const gate = new OperationPolicyGate();
    const approval = approvalFor(intent);
    const otherTask = { ...intent, taskId: 'task-2' };
    // Recompute-proof: hash differs across tasks, approval must not transfer.
    expect(hashOperationIntent(otherTask)).not.toBe(hashOperationIntent(intent));
    expect(gate.verify(approval, otherTask).accepted).toBe(false);
  });

  it('rejects expired approvals (fail-closed)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.inventory.adjust', effectClass: 'WRITE' });
    const gate = new OperationPolicyGate();
    const expired = approvalFor(intent, { expiresAt: Date.now() - 1_000 });
    const result = gate.verify(expired, intent);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/expir/i);
  });
});

describe('DENY is non-promotable', () => {
  it('approval cannot lift DENY for account deletion', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.account.delete', effectClass: 'DELETE' });
    const decision = decideOperation(intent, meta({ scope: 'ACCOUNT' }), approvalFor(intent));
    expect(decision.kind).toBe('DENY');
    expect(decision.reason).toMatch(/policy change/i);
  });

  it('approval cannot lift DENY for unknown destructive actions', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.unknown.wipe', effectClass: 'DELETE' });
    const decision = decideOperation(intent, meta(), approvalFor(intent));
    expect(decision.kind).toBe('DENY');
  });
});

describe('decision mapping', () => {
  it('maps READ to ALLOW without approval', () => {
    const decision = decideOperation(baseIntent(), meta());
    expect(decision.kind).toBe('ALLOW');
  });

  it('maps REMOTE_WRITE to NEEDS_APPROVAL without approval and ALLOW with valid approval', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    expect(decideOperation(intent, meta()).kind).toBe('NEEDS_APPROVAL');
    const gate = new OperationPolicyGate();
    void gate;
    expect(decideOperation(intent, meta(), approvalFor(intent)).kind).toBe('ALLOW');
  });

  it('maps HIGH_RISK to NEEDS_APPROVAL without approval and ALLOW with valid approval', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.refund.create', effectClass: 'WRITE' });
    expect(decideOperation(intent, meta()).kind).toBe('NEEDS_APPROVAL');
    expect(decideOperation(intent, meta(), approvalFor(intent)).kind).toBe('ALLOW');
  });
});
