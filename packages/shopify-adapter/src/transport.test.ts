/**
 * RED: Shopify credential-aware transport guarantees (WP-18).
 *
 * Fixture transport only — no live calls. The fake endpoint counts external
 * effects; reads never count.
 */
import { describe, expect, it } from 'vitest';
import { FakeBroker, FakeShopifyEndpoint } from './fixture-endpoint.js';
import {
  ShopifyTransport,
  PINNED_SHOPIFY_API_VERSION,
  type TransportExecContext,
} from './transport.js';

const STORE = 'acme.myshopify.com';
const SECRET = 'shpat_fixture_only_secret';
const CREDENTIAL_REF = 'shopify/oauth/acme';
const RECIPE_ID = 'shopify.v1/standard';

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
    inventory: options.inventory,
    redirectPaths: options.redirectPaths,
  });
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
      ...(options.permits ?? {}),
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

describe('transport endpoint pinning', () => {
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
});

describe('transport arbitrary-URL refusal', () => {
  it('refuses unknown param keys such as url/graphql passthrough', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute('shopify.product.read', { productId: '1', url: 'https://evil.example.com' }, baseCtx),
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
  it('sends the broker-held credential but never returns it upward', async () => {
    const { endpoint, transport } = harness();
    endpoint.seedProduct('1', 'Fixture Tee');
    const result = await transport.execute('shopify.product.read', { productId: '1' }, baseCtx);
    expect(endpoint.lastAuthorization).toBe(`Bearer ${SECRET}`);
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

describe('transport strict params', () => {
  it('rejects unknown keys, empty values, and over-cap limits', async () => {
    const { endpoint, transport } = harness();
    await expect(
      transport.execute('shopify.product.create', { title: 'T', color: 'red' }, baseCtx),
    ).rejects.toThrow(/unknown param/i);
    await expect(
      transport.execute('shopify.product.create', { title: '' }, baseCtx),
    ).rejects.toThrow(/title/i);
    await expect(
      transport.execute('shopify.product.read', { productId: '1', limit: 5000 }, baseCtx),
    ).rejects.toThrow(/limit/i);
    expect(endpoint.fetchCallCount).toBe(0);
  });

  it('requires compareQuantity CAS on inventory adjust', async () => {
    const { transport } = harness({ inventory: { 'item-1': 10 } });
    await expect(
      transport.execute(
        'shopify.inventory.adjust',
        { inventoryItemId: 'item-1', availableAdjustment: -1 },
        baseCtx,
      ),
    ).rejects.toThrow(/compare/i);
  });

  it('refuses CAS mismatch without an external effect', async () => {
    const { endpoint, transport } = harness({ inventory: { 'item-1': 10 } });
    await expect(
      transport.execute(
        'shopify.inventory.adjust',
        { inventoryItemId: 'item-1', availableAdjustment: -1, compareQuantity: 7 },
        baseCtx,
      ),
    ).rejects.toThrow(/compare-quantity-mismatch/i);
    expect(endpoint.externalEffectCount).toBe(0);
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
});
