/**
 * RED: Shopify GraphQL transport guarantees (T6 repair, 2026-10-04 re-verification).
 *
 * Fixture transport only — no live calls. The fake endpoint counts external
 * effects; reads never count. Every request must be a pinned GraphQL
 * operation template POSTed to /graphql.json with X-Shopify-Access-Token.
 */
import { describe, expect, it } from 'vitest';
import { FakeBroker, FakeShopifyEndpoint } from './fixture-endpoint.js';
import {
  ShopifyTransport,
  PINNED_SHOPIFY_API_VERSION,
  SHOPIFY_GRAPHQL_URL_SUFFIX,
  type TransportExecContext,
} from './transport.js';

const STORE = 'acme.myshopify.com';
const SECRET = 'shpat_fixture_only_secret';
const CREDENTIAL_REF = 'shopify/oauth/acme';
const RECIPE_ID = 'shopify.v1/standard';
const GRAPHQL_URL = `https://${STORE}/admin/api/${PINNED_SHOPIFY_API_VERSION}${SHOPIFY_GRAPHQL_URL_SUFFIX}`;

const baseCtx: TransportExecContext = {
  operationId: 'op-1',
  intentHash: 'intent-hash-1',
  permitId: 'permit-1',
  requesterId: 'ops-exec',
  workerId: 'shopify-worker',
  storeId: STORE,
};

function harness(options: {
  redirectPaths?: readonly string[];
  inventory?: Readonly<Record<string, number>>;
  permits?: Record<string, { intentHash: string }>;
} = {}) {
  const endpoint = new FakeShopifyEndpoint({
    storeDomain: STORE,
    apiVersion: PINNED_SHOPIFY_API_VERSION,
    ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
    ...(options.redirectPaths === undefined ? {} : { redirectPaths: options.redirectPaths }),
  });
  const extraPermits = Object.fromEntries(
    Object.entries(options.permits ?? {}).map(([permitId, permit]) => [
      permitId,
      {
        intentHash: permit.intentHash,
        credentialRef: CREDENTIAL_REF,
        recipeId: RECIPE_ID,
        requesterId: baseCtx.requesterId,
        workerId: baseCtx.workerId,
        scope: 'shopify.v1',
      },
    ]),
  );
  const broker = new FakeBroker({
    secret: SECRET,
    permits: {
      'permit-1': {
        intentHash: baseCtx.intentHash,
        credentialRef: CREDENTIAL_REF,
        recipeId: RECIPE_ID,
        requesterId: baseCtx.requesterId,
        workerId: baseCtx.workerId,
        scope: 'shopify.v1',
      },
      ...extraPermits,
    },
  });
  const transport = new ShopifyTransport({
    storeDomain: STORE,
    apiVersion: PINNED_SHOPIFY_API_VERSION,
    credentialRef: CREDENTIAL_REF,
    recipeId: RECIPE_ID,
    broker,
    fetch: endpoint.fetch,
  });
  return { endpoint, broker, transport };
}

const adjustParams = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  inventoryItemId: 'item-1',
  locationId: 'loc-1',
  availableAdjustment: -1,
  changeFromQuantity: 10,
  ...overrides,
});

describe('transport GraphQL endpoint pinning', () => {
  it('rejects a mismatched API version at construction', () => {
    const { broker, endpoint } = harness();
    expect(
      () =>
        new ShopifyTransport({
          storeDomain: STORE,
          apiVersion: '2024-01',
          credentialRef: CREDENTIAL_REF,
          recipeId: RECIPE_ID,
          broker,
          fetch: endpoint.fetch,
        }),
    ).toThrow(/api version/i);
  });

  it('rejects a non-myshopify store domain at construction', () => {
    const { broker, endpoint } = harness();
    expect(
      () =>
        new ShopifyTransport({
          storeDomain: 'https://evil.example.com',
          apiVersion: PINNED_SHOPIFY_API_VERSION,
          credentialRef: CREDENTIAL_REF,
          recipeId: RECIPE_ID,
          broker,
          fetch: endpoint.fetch,
        }),
    ).toThrow(/store domain/i);
  });

  it('POSTs pinned operation templates to the GraphQL endpoint only', async () => {
    const { endpoint, transport } = harness();
    endpoint.seedProduct('1', 'Fixture Tee');
    await transport.execute('shopify.product.read', { productId: '1' }, baseCtx);
    expect(endpoint.lastMethod).toBe('POST');
    expect(endpoint.lastUrl).toBe(GRAPHQL_URL);
    expect(endpoint.lastQuery).toContain('product(');
    expect(endpoint.lastVariables).toEqual({ id: 'gid://shopify/Product/1' });
  });

  it('sends no REST paths and no arbitrary GraphQL text', async () => {
    const { endpoint, transport } = harness();
    endpoint.seedProduct('1', 'Fixture Tee');
    await transport.execute('shopify.product.read', { productId: '1' }, baseCtx);
    expect(endpoint.lastUrl).not.toMatch(/\.json\?|\/products\/|\/orders\//u);
    expect(endpoint.lastQuery).not.toContain('{ shop { name } }');
  });
});

describe('transport arbitrary-URL refusal', () => {
  it('refuses unknown param keys such as url/query/graphql passthrough', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute('shopify.product.read', { productId: '1', url: 'https://evil.example.com' }, baseCtx),
    ).rejects.toThrow(/unknown param/i);
    await expect(
      transport.execute('shopify.order.read', { orderId: '9', query: '{ shop { name } }' }, baseCtx),
    ).rejects.toThrow(/unknown param/i);
    await expect(
      transport.execute('shopify.order.read', { orderId: '9', graphql: '{ shop { name } }' }, baseCtx),
    ).rejects.toThrow(/unknown param/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });

  it('refuses redirects instead of following them', async () => {
    const { endpoint, transport } = harness({ redirectPaths: ['orders/9.json'] });
    await expect(
      transport.execute('shopify.order.read', { orderId: '9' }, baseCtx),
    ).rejects.toThrow(/redirect/i);
    expect(endpoint.fetchCallCount).toBe(1);
  });

  it('rejects an unknown canonical action', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute('shopify.store.delete' as never, {}, baseCtx),
    ).rejects.toThrow(/unknown.*action/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });
});

describe('transport credential handling', () => {
  it('sends X-Shopify-Access-Token and never Authorization: Bearer', async () => {
    const { endpoint, transport } = harness();
    endpoint.seedProduct('1', 'Fixture Tee');
    const result = await transport.execute('shopify.product.read', { productId: '1' }, baseCtx);
    expect(endpoint.lastAccessToken).toBe(SECRET);
    expect(endpoint.lastAuthorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result).toEqual({
      action: 'shopify.product.read',
      outcome: 'READ_OK',
      data: { product: { id: '1', title: 'Fixture Tee' } },
    });
  });

  it('exposes sanitized results only — raw HTTP never leaves', async () => {
    const { endpoint, transport } = harness();
    endpoint.seedProduct('2', 'Fixture Cap');
    const result = await transport.execute('shopify.product.read', { productId: '2' }, baseCtx);
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('headers');
    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('raw');
  });
});

describe('transport strict params', () => {
  it('rejects unknown keys and empty values', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute('shopify.product.create', { title: 'T', color: 'red' }, baseCtx),
    ).rejects.toThrow(/unknown param/i);
    await expect(
      transport.execute('shopify.product.create', { title: '' }, baseCtx),
    ).rejects.toThrow(/title/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });

  it('requires an explicit changeFromQuantity CAS value (number or null)', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    await expect(
      transport.execute(
        'shopify.inventory.adjust',
        { inventoryItemId: 'item-1', locationId: 'loc-1', availableAdjustment: -1 },
        baseCtx,
      ),
    ).rejects.toThrow(/changeFromQuantity/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });

  it('applies inventory adjust when changeFromQuantity is explicitly null', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    const result = await transport.execute('shopify.inventory.adjust', adjustParams({ changeFromQuantity: null }), baseCtx);
    expect(result.outcome).toBe('APPLIED');
    expect(endpoint.externalEffectCount).toBe(1);
  });

  it('refuses CAS mismatch with CHANGE_FROM_QUANTITY_STALE and no external effect', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    await expect(
      transport.execute('shopify.inventory.adjust', adjustParams({ changeFromQuantity: 7 }), baseCtx),
    ).rejects.toThrow(/CHANGE_FROM_QUANTITY_STALE/u);
    expect(endpoint.externalEffectCount).toBe(0);
  });
});

describe('transport @idempotent directive wiring', () => {
  it('attaches the directive key in variables for inventory adjust', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    await transport.execute('shopify.inventory.adjust', adjustParams(), baseCtx);
    expect(endpoint.lastQuery).toContain('@idempotent');
    expect(endpoint.lastVariables?.['idempotencyKey']).toBe('shopify-op-1');
    expect(endpoint.lastIdempotencyHeader).toBeNull();
  });

  it('attaches the directive key in variables for refund create', async () => {
    const { endpoint, transport } = harness();
    await transport.execute('shopify.refund.create', { orderId: '42', amount: '10.00' }, baseCtx);
    expect(endpoint.lastQuery).toContain('@idempotent');
    expect(endpoint.lastVariables?.['idempotencyKey']).toBe('shopify-op-1');
    expect(endpoint.lastIdempotencyHeader).toBeNull();
  });

  it('never sends an idempotency-key header', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    await transport.execute('shopify.inventory.adjust', adjustParams(), baseCtx);
    expect(endpoint.lastIdempotencyHeader).toBeNull();
  });
});

describe('transport async order cancel', () => {
  it('returns the cancel Job without any idempotency key', async () => {
    const { endpoint, transport } = harness();
    const result = await transport.execute('shopify.order.cancel', { orderId: '9' }, baseCtx);
    expect(result.outcome).toBe('APPLIED');
    expect(endpoint.lastQuery).toContain('orderCancel');
    expect(endpoint.lastQuery).not.toContain('@idempotent');
    expect(endpoint.lastVariables?.['idempotencyKey']).toBeUndefined();
    expect(endpoint.lastIdempotencyHeader).toBeNull();
    expect(result.data['cancel_job']).toMatchObject({ done: false });
    expect(typeof (result.data['cancel_job'] as { id: unknown }).id).toBe('string');
  });

  it('refuses a second cancel of the same order without a new effect', async () => {
    const { endpoint, transport } = harness({
      permits: { 'permit-cancel-2': { intentHash: baseCtx.intentHash } },
    });
    const first = await transport.execute(
      'shopify.order.cancel',
      { orderId: '9' },
      { ...baseCtx, operationId: 'op-cancel-1', permitId: 'permit-1' },
    );
    expect(first.outcome).toBe('APPLIED');
    await expect(
      transport.execute(
        'shopify.order.cancel',
        { orderId: '9' },
        { ...baseCtx, operationId: 'op-cancel-2', permitId: 'permit-cancel-2' },
      ),
    ).rejects.toThrow(/already-cancelled/i);
    expect(endpoint.externalEffectCount).toBe(1);
  });
});

describe('transport throttling', () => {
  it('surfaces THROTTLED as a deterministic refusal', async () => {
    const { endpoint, transport } = harness();
    endpoint.failNextRequest({ status: 429 });
    await expect(
      transport.execute('shopify.product.create', { title: 'Throttled' }, baseCtx),
    ).rejects.toThrow(/throttl/i);
    expect(endpoint.externalEffectCount).toBe(0);
  });
});

describe('transport store-drift refusal', () => {
  it('refuses when the operation store drifts from the bound store', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute(
        'shopify.product.read',
        { productId: '1' },
        { ...baseCtx, storeId: 'other.myshopify.com' },
      ),
    ).rejects.toThrow(/store.*drift/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });
});

describe('transport write replay', () => {
  it('refuses proven-write replay of the same operation', async () => {
    const { endpoint, transport } = harness();
    const ok = await transport.execute('shopify.product.create', { title: 'Tee' }, baseCtx);
    expect(ok.outcome).toBe('APPLIED');
    await expect(
      transport.execute('shopify.product.create', { title: 'Tee' }, baseCtx),
    ).rejects.toThrow(/replay/i);
    expect(endpoint.externalEffectCount).toBe(1);
  });

  it('reports UNKNOWN on ambiguity without claiming the effect', async () => {
    const { endpoint, transport } = harness();
    endpoint.failNextRequest({ status: 503 });
    const error = await transport
      .execute('shopify.product.create', { title: 'Ambiguous' }, baseCtx)
      .then(
        () => null,
        (cause: unknown) => cause as { outcome?: string },
      );
    expect(error?.outcome).toBe('UNKNOWN');
    expect(endpoint.externalEffectCount).toBe(0);
  });

  it('dedupes an idempotent refund retry under the same key with a single effect', async () => {
    const { endpoint, transport } = harness({
      permits: { 'permit-retry': { intentHash: baseCtx.intentHash } },
    });
    endpoint.failNextRequest({ threw: 'socket hangup' });
    const op: TransportExecContext = { ...baseCtx, operationId: 'op-refund-retry' };
    const failed = await transport.execute('shopify.refund.create', { orderId: '42', amount: '10.00' }, op).then(
      () => null,
      (cause: unknown) => cause as { outcome?: string },
    );
    expect(failed?.outcome).toBe('UNKNOWN');
    const receipt = await transport.execute(
      'shopify.refund.create',
      { orderId: '42', amount: '10.00' },
      { ...op, permitId: 'permit-retry' },
    );
    expect(receipt.outcome).toBe('APPLIED');
    expect(receipt.idempotencyKey).toBe('shopify-op-refund-retry');
    expect(endpoint.externalEffectCount).toBe(1);
  });
});
