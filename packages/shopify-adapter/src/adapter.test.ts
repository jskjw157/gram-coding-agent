/**
 * RED: Shopify typed adapter guarantees (WP-18).
 *
 * The adapter submits canonical typed actions plus effect metadata and
 * consumes Policy Engine verdicts structurally (shape mirrored from
 * origin/feat/ops-policy-approval — policy itself is never edited here).
 * Caller-claimed risk is accepted structurally but ignored for the verdict.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ShopifyAdapter,
  createOperationIntent,
  SHOPIFY_PROVIDER_ID,
  type ShopifyActionName,
  type ShopifySubmitContext,
} from './adapter.js';
import { FakeBroker, FakeShopifyEndpoint } from './fixture-endpoint.js';
import { ShopifyTransport, PINNED_SHOPIFY_API_VERSION } from './transport.js';

const STORE = 'acme.myshopify.com';
const ACCOUNT = 'acct-1';
const TASK = 'task-1';
const SECRET = 'shpat_fixture_only_secret';
const CREDENTIAL_REF = 'shopify/oauth/acme';
const RECIPE_ID = 'shopify.v1/standard';
const SCOPE = 'shopify.v1';

function harness() {
  const endpoint = new FakeShopifyEndpoint({ storeDomain: STORE, apiVersion: PINNED_SHOPIFY_API_VERSION });
  const permits: Record<
    string,
    {
      intentHash: string;
      credentialRef: string;
      recipeId: string;
      requesterId: string;
      workerId: string;
      scope: string;
    }
  > = {};
  const broker = new FakeBroker({ secret: SECRET, permits });
  const transport = new ShopifyTransport({
    storeDomain: STORE,
    apiVersion: PINNED_SHOPIFY_API_VERSION,
    credentialRef: CREDENTIAL_REF,
    recipeId: RECIPE_ID,
    broker,
    fetch: endpoint.fetch,
  });
  const adapter = new ShopifyAdapter(transport);

  const prepare = (
    action: ShopifyActionName,
    params: Record<string, unknown>,
    ids: { operationId?: string; permitId?: string; storeId?: string } = {},
  ): { ctx: ShopifySubmitContext; operationHash: string } => {
    const operationId = ids.operationId ?? 'op-1';
    const permitId = ids.permitId ?? 'permit-1';
    const storeId = ids.storeId ?? STORE;
    const intent = createOperationIntent(action, params, {
      taskId: TASK,
      storeId,
      accountId: ACCOUNT,
      operationId,
      recipeId: RECIPE_ID,
    });
    permits[permitId] = {
      intentHash: intent.operationHash,
      credentialRef: CREDENTIAL_REF,
      recipeId: RECIPE_ID,
      requesterId: 'ops-exec',
      workerId: 'shopify-worker',
      scope: SCOPE,
    };
    const ctx: ShopifySubmitContext = {
      taskId: TASK,
      storeId,
      accountId: ACCOUNT,
      operationId,
      permit: { permitId, requesterId: 'ops-exec', workerId: 'shopify-worker' },
      verdict: {
        kind: 'ALLOW',
        ruleId: 'POL-OPS-ALLOW',
        reason: 'approved fixture verdict',
        operationHash: intent.operationHash,
      },
    };
    return { ctx, operationHash: intent.operationHash };
  };

  return { endpoint, broker, transport, adapter, prepare };
}

describe('adapter canonical submission', () => {
  it('submits product.read with effect metadata and returns a receipt', async () => {
    const { adapter, prepare, endpoint } = harness();
    endpoint.seedProduct('1', 'Fixture Tee');
    const { ctx } = prepare('shopify.product.read', { productId: '1' });
    const receipt = await adapter.submit('shopify.product.read', { productId: '1' }, ctx);
    expect(receipt.policyDecision).toBe('ALLOW');
    expect(receipt.effectClass).toBe('READ');
    expect(receipt.operationId).toBe('op-1');
    expect(receipt.operationHash).toBe(ctx.verdict.operationHash);
    expect(receipt.artifacts.length).toBeGreaterThan(0);
    expect(endpoint.lastAccessToken).toBe(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('registers the shopify.v1 provider on the intent', () => {
    const intent = createOperationIntent(
      'shopify.product.read',
      { productId: '1' },
      { taskId: TASK, storeId: STORE, accountId: ACCOUNT, operationId: 'op-x', recipeId: RECIPE_ID },
    );
    expect(intent.providerId).toBe(SHOPIFY_PROVIDER_ID);
    expect(intent.canonicalAction).toBe('shopify.product.read');
    expect(intent.operationHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('adapter risk-downgrade refusal', () => {
  it('ignores caller-claimed READ on a high-risk refund without approval', async () => {
    const { adapter, prepare, endpoint } = harness();
    const params = { orderId: '1', amount: '10.00' };
    const { ctx } = prepare('shopify.refund.create', params, { operationId: 'op-risk-1', permitId: 'p-risk-1' });
    await expect(
      adapter.submit('shopify.refund.create', params, {
        ...ctx,
        hint: { claimedRisk: 'READ' },
        verdict: { ...ctx.verdict, kind: 'NEEDS_APPROVAL', ruleId: 'POL-OPS-HIGH-RISK', reason: 'approval' },
      }),
    ).rejects.toThrow(/approval/i);
    expect(endpoint.externalEffectCount).toBe(0);
  });

  it('treats DENY as non-promotable even with a benign claimed risk', async () => {
    const { adapter, prepare, endpoint } = harness();
    const params = { orderId: '1' };
    const { ctx } = prepare('shopify.order.cancel', params, { operationId: 'op-risk-2', permitId: 'p-risk-2' });
    await expect(
      adapter.submit('shopify.order.cancel', params, {
        ...ctx,
        hint: { claimedRisk: 'READ' },
        verdict: { ...ctx.verdict, kind: 'DENY', ruleId: 'POL-OPS-HIGH-RISK', reason: 'denied' },
      }),
    ).rejects.toThrow(/deny|denied/i);
    expect(endpoint.externalEffectCount).toBe(0);
  });

  it('rejects verdicts whose operation hash does not match the intent', async () => {
    const { adapter, endpoint } = harness();
    const brokerSpy = vi.spyOn(endpoint, 'fetch');
    const ctx: ShopifySubmitContext = {
      taskId: TASK,
      storeId: STORE,
      accountId: ACCOUNT,
      operationId: 'op-tamper-1',
      permit: { permitId: 'p', requesterId: 'ops-exec', workerId: 'shopify-worker' },
      verdict: { kind: 'ALLOW', ruleId: 'POL-OPS-READ', reason: 'tampered', operationHash: 'deadbeef' },
    };
    await expect(
      adapter.submit('shopify.product.read', { productId: '1' }, ctx),
    ).rejects.toThrow(/operation.*hash|tamper|identity/i);
    expect(brokerSpy).not.toHaveBeenCalled();
  });
});

describe('adapter token-share refusal', () => {
  it('refuses credential-bearing params before the broker is touched', async () => {
    const { adapter, prepare, broker } = harness();
    const useSpy = vi.spyOn(broker, 'credentialUse');
    const { ctx } = prepare('shopify.product.read', { productId: '1' });
    await expect(
      adapter.submit('shopify.product.read', { productId: '1', accessToken: 'shpat_live' }, ctx),
    ).rejects.toThrow(/credential|token/i);
    expect(useSpy).not.toHaveBeenCalled();
  });
});

describe('adapter write replay + drift + ambiguity', () => {
  it('refuses unproven-write replay of a proven product.create', async () => {
    const { adapter, prepare, endpoint } = harness();
    const params = { title: 'Replay Tee' };
    const { ctx } = prepare('shopify.product.create', params, {
      operationId: 'op-replay-1',
      permitId: 'permit-replay-1',
    });
    const first = await adapter.submit('shopify.product.create', params, ctx);
    expect(first.effectClass).toBe('WRITE');
    prepare('shopify.product.create', params, {
      operationId: 'op-replay-1',
      permitId: 'permit-replay-2',
    });
    await expect(
      adapter.submit('shopify.product.create', params, {
        ...ctx,
        permit: { permitId: 'permit-replay-2', requesterId: 'ops-exec', workerId: 'shopify-worker' },
      }),
    ).rejects.toThrow(/replay/i);
    expect(endpoint.externalEffectCount).toBe(1);
  });

  it('refuses store drift without an external effect', async () => {
    const { adapter, prepare, endpoint } = harness();
    const { ctx } = prepare('shopify.product.read', { productId: '1' }, { storeId: 'other.myshopify.com' });
    await expect(
      adapter.submit('shopify.product.read', { productId: '1' }, ctx),
    ).rejects.toThrow(/store.*drift/i);
    expect(endpoint.fetchCallCount).toBe(0);
    expect(endpoint.externalEffectCount).toBe(0);
  });

  it('surfaces UNKNOWN on ambiguity for product.create with no idempotency claim', async () => {
    const { adapter, prepare, endpoint } = harness();
    endpoint.failNextRequest({ threw: 'socket hangup' });
    const params = { title: 'Ambiguous Tee' };
    const { ctx } = prepare('shopify.product.create', params, {
      operationId: 'op-amb-1',
      permitId: 'permit-amb-1',
    });
    const error = await adapter.submit('shopify.product.create', params, ctx).then(
      () => null,
      (cause: unknown) => cause as { outcome?: string },
    );
    expect(error?.outcome).toBe('UNKNOWN');
    expect(endpoint.externalEffectCount).toBe(0);
  });

  it('retries an unproven refund under the same idempotency key with one effect', async () => {
    const { adapter, prepare, endpoint } = harness();
    endpoint.failNextRequest({ threw: 'socket hangup' });
    const params = { orderId: '42', amount: '10.00' };
    const first = prepare('shopify.refund.create', params, {
      operationId: 'op-refund-1',
      permitId: 'permit-refund-1',
    });
    const failed = await adapter.submit('shopify.refund.create', params, first.ctx).then(
      () => null,
      (cause: unknown) => cause as { outcome?: string },
    );
    expect(failed?.outcome).toBe('UNKNOWN');
    const second = prepare('shopify.refund.create', params, {
      operationId: 'op-refund-1',
      permitId: 'permit-refund-2',
    });
    const receipt = await adapter.submit('shopify.refund.create', params, second.ctx);
    expect(receipt.effectClass).toBe('WRITE');
    expect(endpoint.externalEffectCount).toBe(1);
  });
});
