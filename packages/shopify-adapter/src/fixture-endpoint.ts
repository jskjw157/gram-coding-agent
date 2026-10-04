/**
 * In-fixture Shopify GraphQL doubles (MAC-04/05 WP-18, T6 GraphQL repair).
 *
 * FakeShopifyEndpoint: counts external effects (state-changing successes
 * only; reads never count) and speaks only the pinned GraphQL endpoint
 * `POST .../admin/api/2026-10/graphql.json`. Operation routing is by pinned
 * template marker in the query text; caller-supplied query text can never
 * arrive because the transport only sends its own templates.
 * createFixtureBroker: structural stand-in for the CredentialBroker
 * contract (origin/feat/ops-broker) — bound single-use permits, vault-backed
 * secret, raw-secret-leak rejection. Fixture-only secret, never a credential.
 */

export interface FixtureHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface FixtureHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type FixtureFetch = (request: FixtureHttpRequest) => Promise<FixtureHttpResponse>;

export interface FakeShopifyEndpointOptions {
  readonly storeDomain: string;
  readonly apiVersion: string;
  readonly inventory?: Readonly<Record<string, number>>;
  readonly redirectPaths?: readonly string[];
}

export type FailNext = { readonly status: number } | { readonly threw: string };

const ok = (body: unknown): FixtureHttpResponse => ({ status: 200, headers: {}, body });
const created = (body: unknown): FixtureHttpResponse => ({ status: 201, headers: {}, body });
const failure = (status: number, error: string, extra?: Record<string, unknown>): FixtureHttpResponse => ({
  status,
  headers: {},
  body: { error, ...(extra ?? {}) },
});

const readBody = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const gidSuffix = (gid: unknown): string | undefined => {
  if (typeof gid !== 'string') return undefined;
  const suffix = gid.split('/').pop();
  return suffix === undefined || suffix.length === 0 ? undefined : suffix;
};

export class FakeShopifyEndpoint {
  externalEffectCount = 0;
  lastAuthorization: string | null = null;
  lastAccessToken: string | null = null;
  lastIdempotencyHeader: string | null = null;
  lastMethod: string | null = null;
  lastUrl: string | null = null;
  lastQuery: string | null = null;
  lastVariables: Record<string, unknown> | null = null;
  fetchCallCount = 0;
  readonly fetch: FixtureFetch;

  private readonly graphqlUrl: string;
  private readonly redirectPaths: ReadonlySet<string>;
  private readonly products = new Map<string, { readonly id: string; readonly title: string }>();
  private readonly inventory = new Map<string, number>();
  private readonly cancelledOrders = new Set<string>();
  private readonly keyedReceipts = new Map<string, unknown>();
  private nextId = 7001;
  private nextJob = 1;
  private failNext: FailNext | null = null;

  constructor(private readonly options: FakeShopifyEndpointOptions) {
    this.graphqlUrl = `https://${options.storeDomain}/admin/api/${options.apiVersion}/graphql.json`;
    this.redirectPaths = new Set(options.redirectPaths ?? []);
    for (const [item, quantity] of Object.entries(options.inventory ?? {})) {
      this.inventory.set(item, quantity);
    }
    this.fetch = async (request) => this.handle(request);
  }

  seedProduct(id: string, title: string): void {
    this.products.set(id, { id, title });
  }

  failNextRequest(fail: FailNext): void {
    this.failNext = fail;
  }

  private async handle(request: FixtureHttpRequest): Promise<FixtureHttpResponse> {
    this.fetchCallCount += 1;
    this.lastMethod = request.method;
    this.lastUrl = request.url;
    this.lastAuthorization = request.headers['authorization'] ?? null;
    this.lastAccessToken = request.headers['X-Shopify-Access-Token'] ?? null;
    this.lastIdempotencyHeader = request.headers['idempotency-key'] ?? null;
    this.lastQuery = null;
    this.lastVariables = null;

    const consumed = this.failNext;
    this.failNext = null;
    if (consumed !== null) {
      if ('threw' in consumed) throw new Error(consumed.threw);
      if (consumed.status === 429) {
        return {
          status: 429,
          headers: { 'retry-after': '2.0' },
          body: { errors: [{ message: 'THROTTLED: query cost budget exhausted', extensions: { code: 'THROTTLED' } }] },
        };
      }
      return failure(consumed.status, 'transient-fixture-error');
    }

    // Only the pinned GraphQL endpoint exists. REST paths are gone.
    if (request.method !== 'POST' || request.url !== this.graphqlUrl) {
      return failure(404, 'not-found');
    }
    const payload = readBody(request.body);
    const query = payload['query'];
    const variables = readBody(payload['variables']);
    if (typeof query !== 'string') return failure(400, 'query-required');
    this.lastQuery = query;
    this.lastVariables = variables as Record<string, unknown>;

    if (query.includes('inventoryAdjustQuantities')) return this.adjustInventory(variables);
    if (query.includes('orderCancel')) return this.cancelOrder(variables);
    if (query.includes('refundCreate')) return this.createRefund(variables);
    if (query.includes('productCreate')) return this.createProduct(variables);
    if (query.includes('product(')) return this.readProduct(variables);
    if (query.includes('order(')) return this.readOrder(variables);
    return failure(400, 'unknown-operation');
  }

  private readProduct(variables: Record<string, unknown>): FixtureHttpResponse {
    const id = gidSuffix(variables['id']);
    if (id !== undefined && this.redirectPaths.has(`products/${id}.json`)) {
      return { status: 302, headers: { location: `${this.graphqlUrl}` }, body: {} };
    }
    const product = id === undefined ? undefined : this.products.get(id);
    if (product === undefined) return ok({ data: { product: null } });
    return ok({ data: { product } });
  }

  private createProduct(variables: Record<string, unknown>): FixtureHttpResponse {
    const input = readBody(variables['input']);
    const title = input['title'];
    if (typeof title !== 'string' || title.length === 0) {
      return ok({ data: { productCreate: { product: null, userErrors: [{ field: 'input', message: 'title required', code: 'TITLE_REQUIRED' }] } } });
    }
    const id = String(this.nextId);
    this.nextId += 1;
    this.products.set(id, { id, title });
    this.externalEffectCount += 1;
    return created({ data: { productCreate: { product: { id, title }, userErrors: [] } } });
  }

  private adjustInventory(variables: Record<string, unknown>): FixtureHttpResponse {
    const key = variables['idempotencyKey'];
    if (typeof key === 'string' && this.keyedReceipts.has(key)) {
      return ok({ data: this.keyedReceipts.get(key), replayed: true });
    }
    const input = readBody(variables['input']);
    const changes = input['changes'];
    const change = Array.isArray(changes) ? readBody(changes[0]) : {};
    const itemId = gidSuffix(change['inventoryItemId']);
    const delta = change['delta'];
    if (itemId === undefined || typeof delta !== 'number' || !('changeFromQuantity' in change)) {
      return ok({
        data: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [{ field: 'input', message: 'invalid inventory change', code: 'INVALID' }],
          },
        },
      });
    }
    const expected = change['changeFromQuantity'];
    const current = this.inventory.get(itemId) ?? 0;
    if (expected !== null && expected !== current) {
      return ok({
        data: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              {
                field: 'changeFromQuantity',
                message: `CHANGE_FROM_QUANTITY_STALE: expected ${String(expected)}, current ${String(current)}`,
                code: 'CHANGE_FROM_QUANTITY_STALE',
              },
            ],
          },
        },
      });
    }
    this.inventory.set(itemId, current + delta);
    this.externalEffectCount += 1;
    const receipt = {
      inventoryAdjustmentGroup: { changes: [{ name: 'available', delta }] },
    };
    if (typeof key === 'string') this.keyedReceipts.set(key, receipt);
    return ok({ data: { inventoryAdjustQuantities: { ...receipt, userErrors: [] } } });
  }

  private readOrder(variables: Record<string, unknown>): FixtureHttpResponse {
    const id = gidSuffix(variables['id']) ?? 'unknown';
    if (this.redirectPaths.has(`orders/${id}.json`)) {
      return { status: 302, headers: { location: `${this.graphqlUrl}` }, body: {} };
    }
    const cancelled = this.cancelledOrders.has(id);
    return ok({
      data: { order: { id, name: `Order ${id}`, cancelledAt: cancelled ? '2026-10-04T00:00:00Z' : null } },
    });
  }

  private cancelOrder(variables: Record<string, unknown>): FixtureHttpResponse {
    const id = gidSuffix(variables['orderId']) ?? 'unknown';
    if (this.cancelledOrders.has(id)) {
      return ok({
        data: {
          orderCancel: {
            job: null,
            orderCancelUserErrors: [{ field: 'orderId', message: 'already-cancelled', code: 'ALREADY_CANCELLED' }],
            userErrors: [],
          },
        },
      });
    }
    this.cancelledOrders.add(id);
    this.externalEffectCount += 1;
    const jobId = `gid://shopify/Job/cancel-${String(this.nextJob)}`;
    this.nextJob += 1;
    return ok({
      data: { orderCancel: { job: { id: jobId, done: false }, orderCancelUserErrors: [], userErrors: [] } },
    });
  }

  private createRefund(variables: Record<string, unknown>): FixtureHttpResponse {
    const key = variables['idempotencyKey'];
    if (typeof key === 'string' && this.keyedReceipts.has(key)) {
      return ok({ data: this.keyedReceipts.get(key), replayed: true });
    }
    const input = readBody(variables['input']);
    const orderId = gidSuffix(input['orderId']);
    const transactions = input['transactions'];
    const first = Array.isArray(transactions) ? readBody(transactions[0]) : {};
    const amount = first['amount'];
    if (orderId === undefined || typeof amount !== 'string') {
      return ok({
        data: { refundCreate: { refund: null, order: null, userErrors: [{ field: 'input', message: 'invalid refund input', code: 'INVALID' }] } },
      });
    }
    const id = `gid://shopify/Refund/${String(this.nextId)}`;
    this.nextId += 1;
    this.externalEffectCount += 1;
    // Currency is fixture echo only: the adapter assumes a single-currency
    // fixture store. Multi-currency handling is verify-at-live.
    const receipt = {
      refund: { id, totalRefundedSet: { presentmentMoney: { amount, currencyCode: 'USD' } } },
      order: { id: `gid://shopify/Order/${orderId}` },
    };
    if (typeof key === 'string') this.keyedReceipts.set(key, receipt);
    return ok({ data: { refundCreate: { ...receipt, userErrors: [] } } });
  }
}

export interface FixturePermit {
  readonly intentHash: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly scope: string;
}

export interface FixtureBrokerOptions {
  readonly secret: string;
  readonly permits: Readonly<Record<string, FixturePermit>>;
}

export class FixtureBrokerError extends Error {
  override name = 'FixtureBrokerError';
}

/**
 * Structural broker double mirroring the CredentialBroker use-only boundary:
 * bound permits, single-use, identity-match, raw-secret-leak rejection.
 */
export class FakeBroker {
  private readonly consumed = new Set<string>();

  constructor(private readonly options: FixtureBrokerOptions) {}

  async credentialUse(
    input: {
      readonly intentHash: string;
      readonly permitId: string;
      readonly credentialRef: string;
      readonly recipeId: string;
      readonly requesterId: string;
      readonly workerId: string;
      readonly scope: string;
    },
    worker: (secret: string) => unknown | Promise<unknown>,
  ): Promise<{ readonly permitId: string; readonly resultDigest: string }> {
    const permit = this.options.permits[input.permitId];
    if (permit === undefined) throw new FixtureBrokerError(`unknown permit ${input.permitId}`);
    if (this.consumed.has(input.permitId)) {
      throw new FixtureBrokerError(`permit ${input.permitId} already consumed`);
    }
    if (
      input.intentHash !== permit.intentHash ||
      input.credentialRef !== permit.credentialRef ||
      input.recipeId !== permit.recipeId ||
      input.requesterId !== permit.requesterId ||
      input.workerId !== permit.workerId ||
      input.scope !== permit.scope
    ) {
      throw new FixtureBrokerError(`permit ${input.permitId} binding mismatch`);
    }
    this.consumed.add(input.permitId);
    const outcome = await worker(this.options.secret);
    const rendered = JSON.stringify(outcome) ?? String(outcome);
    if (rendered.includes(this.options.secret)) {
      throw new FixtureBrokerError('worker must not return the raw secret');
    }
    return { permitId: input.permitId, resultDigest: rendered };
  }
}
