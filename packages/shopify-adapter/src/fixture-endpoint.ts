/**
 * In-fixture Shopify transport doubles (MAC-04/05 WP-18).
 *
 * FakeShopifyEndpoint: counts external effects (state-changing successes
 * only; reads never count) and speaks only the pinned fixed endpoint
 * templates. createFixtureBroker: structural stand-in for the CredentialBroker
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

export class FakeShopifyEndpoint {
  externalEffectCount = 0;
  lastAuthorization: string | null = null;
  fetchCallCount = 0;
  readonly fetch: FixtureFetch;

  private readonly prefix: string;
  private readonly redirectPaths: ReadonlySet<string>;
  private readonly products = new Map<string, { readonly id: string; readonly title: string }>();
  private readonly inventory = new Map<string, number>();
  private readonly cancelledOrders = new Set<string>();
  private readonly keyedReceipts = new Map<string, unknown>();
  private nextId = 7001;
  private failNext: FailNext | null = null;

  constructor(private readonly options: FakeShopifyEndpointOptions) {
    this.prefix = `https://${options.storeDomain}/admin/api/${options.apiVersion}/`;
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
    this.lastAuthorization = request.headers['authorization'] ?? null;

    const consumed = this.failNext;
    this.failNext = null;
    if (consumed !== null) {
      if ('threw' in consumed) throw new Error(consumed.threw);
      return failure(consumed.status, 'transient-fixture-error');
    }

    if (!request.url.startsWith(this.prefix)) return failure(404, 'not-found');
    const path = request.url.slice(this.prefix.length).split('?')[0] ?? '';
    if (this.redirectPaths.has(path)) {
      return { status: 302, headers: { location: `${this.prefix}products/1.json` }, body: {} };
    }

    const productMatch = /^products\/([^/]+)\.json$/u.exec(path);
    if (request.method === 'GET' && productMatch?.[1] !== undefined) {
      const product = this.products.get(productMatch[1]);
      if (product === undefined) return failure(404, 'not-found');
      return ok({ product });
    }
    if (request.method === 'POST' && path === 'products.json') {
      const title = readBody(readBody(request.body)['product'])['title'];
      if (typeof title !== 'string' || title.length === 0) return failure(422, 'title-required');
      const id = String(this.nextId);
      this.nextId += 1;
      this.products.set(id, { id, title });
      this.externalEffectCount += 1;
      return created({ product: { id, title } });
    }

    if (request.method === 'POST' && path === 'inventory_levels/adjust.json') {
      const key = request.headers['idempotency-key'];
      if (key !== undefined && this.keyedReceipts.has(key)) {
        return ok({ ...(this.keyedReceipts.get(key) as Record<string, unknown>), replayed: true });
      }
      const body = readBody(request.body);
      const itemId = body['inventory_item_id'];
      const adjustment = body['available_adjustment'];
      const compare = body['compare_quantity'];
      if (typeof itemId !== 'string' || typeof adjustment !== 'number' || typeof compare !== 'number') {
        return failure(422, 'invalid-inventory-params');
      }
      const current = this.inventory.get(itemId) ?? 0;
      if (compare !== current) {
        return failure(409, 'compare-quantity-mismatch', { current });
      }
      this.inventory.set(itemId, current + adjustment);
      this.externalEffectCount += 1;
      const receipt = { inventory_level: { inventory_item_id: itemId, available: current + adjustment } };
      if (key !== undefined) this.keyedReceipts.set(key, receipt);
      return ok(receipt);
    }

    const orderMatch = /^orders\/([^/]+)\.json$/u.exec(path);
    if (request.method === 'GET' && orderMatch?.[1] !== undefined) {
      const id = orderMatch[1];
      return ok({ order: { id, status: this.cancelledOrders.has(id) ? 'cancelled' : 'open' } });
    }
    const cancelMatch = /^orders\/([^/]+)\/cancel\.json$/u.exec(path);
    if (request.method === 'POST' && cancelMatch?.[1] !== undefined) {
      const id = cancelMatch[1];
      if (this.cancelledOrders.has(id)) return failure(422, 'already-cancelled');
      this.cancelledOrders.add(id);
      this.externalEffectCount += 1;
      return ok({ order: { id, status: 'cancelled' } });
    }

    if (request.method === 'POST' && path === 'refunds.json') {
      const key = request.headers['idempotency-key'];
      if (key !== undefined && this.keyedReceipts.has(key)) {
        return ok({ ...(this.keyedReceipts.get(key) as Record<string, unknown>), replayed: true });
      }
      const body = readBody(request.body);
      if (typeof body['order_id'] !== 'string' || typeof body['amount'] !== 'string') {
        return failure(422, 'invalid-refund-params');
      }
      const id = String(this.nextId);
      this.nextId += 1;
      this.externalEffectCount += 1;
      const receipt = { refund: { id, order_id: body['order_id'], amount: body['amount'] } };
      if (key !== undefined) this.keyedReceipts.set(key, receipt);
      return created(receipt);
    }

    return failure(404, 'not-found');
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
