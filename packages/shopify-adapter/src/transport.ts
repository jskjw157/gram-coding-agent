/**
 * Credential-aware Shopify transport (MAC-04/05 WP-18).
 *
 * The broker holds the credential (contract mirrored structurally from
 * origin/feat/ops-broker — no dependency, no secret ever leaves the lease).
 * Only fixed official endpoint templates are reachable; strict params only
 * (no arbitrary URL, no GraphQL passthrough, no redirect following).
 * Only sanitized typed results leave — raw HTTP never travels upward.
 * Fixture fetch only; no live calls.
 */
import type { FixtureFetch } from './fixture-endpoint.js';

export const PINNED_SHOPIFY_API_VERSION = '2026-10';
export const SHOPIFY_SINGLE_QUERY_CAP = 1000;
export const SHOPIFY_SCOPE = 'shopify.v1';

const STORE_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u;
const CREDENTIAL_KEY_PATTERN = /token|secret|credential|password|auth/i;

export const SHOPIFY_ACTION_NAMES = [
  'shopify.product.read',
  'shopify.product.create',
  'shopify.inventory.adjust',
  'shopify.order.read',
  'shopify.order.cancel',
  'shopify.refund.create',
] as const;

export type ShopifyActionName = (typeof SHOPIFY_ACTION_NAMES)[number];

export type ShopifyOutcome = 'READ_OK' | 'APPLIED' | 'REPLAYED';

export interface ShopifySanitizedResult {
  readonly action: ShopifyActionName;
  readonly outcome: ShopifyOutcome;
  readonly data: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly replayed?: boolean;
}

export interface TransportExecContext {
  readonly operationId: string;
  readonly intentHash: string;
  readonly permitId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly storeId: string;
}

export interface BrokerUseInput {
  readonly intentHash: string;
  readonly permitId: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly scope: string;
}

export interface BrokerReceipt {
  readonly permitId: string;
  readonly resultDigest: string;
}

export interface CredentialBrokerLike {
  credentialUse(
    input: BrokerUseInput,
    worker: (secret: string) => unknown | Promise<unknown>,
  ): Promise<BrokerReceipt>;
}

export interface ShopifyTransportOptions {
  readonly storeDomain: string;
  readonly apiVersion: string;
  readonly credentialRef: string;
  readonly recipeId: string;
  readonly broker: CredentialBrokerLike;
  readonly fetch: FixtureFetch;
}

export class ShopifyTransportError extends Error {
  override name = 'ShopifyTransportError';
}

/** Ambiguous outcome: the effect may or may not have applied. Never claim it. */
export class ShopifyAmbiguousError extends ShopifyTransportError {
  override name = 'ShopifyAmbiguousError';
  readonly outcome = 'UNKNOWN' as const;
}

type ValidParams = Record<string, string | number>;

interface RouteDef {
  readonly method: 'GET' | 'POST';
  readonly effect: 'read' | 'write';
  readonly idempotent: boolean;
  path(params: ValidParams): string;
  query(params: ValidParams): string;
  body(params: ValidParams): Record<string, unknown> | undefined;
  sanitize(body: unknown): Record<string, unknown>;
}

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ShopifyTransportError(`invalid param: ${label} must be a non-empty string`);
  }
  return value;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  return nonEmpty(value, label);
};

const integer = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ShopifyTransportError(`invalid param: ${label} must be an integer`);
  }
  return value;
};

const limitParam = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  const limit = integer(value, 'limit');
  if (limit < 1 || limit > SHOPIFY_SINGLE_QUERY_CAP) {
    throw new ShopifyTransportError(
      `invalid param: limit must be within 1..${SHOPIFY_SINGLE_QUERY_CAP} (single-query cap)`,
    );
  }
  return limit;
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShopifyTransportError(`invalid response: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const pickStringFields = (record: Record<string, unknown>, keys: readonly string[], label: string): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    picked[key] = nonEmpty(record[key], `${label}.${key}`);
  }
  return picked;
};

const ROUTES: Record<ShopifyActionName, RouteDef> = {
  'shopify.product.read': {
    method: 'GET',
    effect: 'read',
    idempotent: false,
    path: (params) => `/products/${params['productId']}.json`,
    query: (params) => (params['limit'] === undefined ? '' : `?limit=${String(params['limit'])}`),
    body: () => undefined,
    sanitize: (response) => ({ product: pickStringFields(asRecord(asRecord(response, 'response')['product'], 'response.product'), ['id', 'title'], 'product') }),
  },
  'shopify.product.create': {
    method: 'POST',
    effect: 'write',
    idempotent: false,
    path: () => '/products.json',
    query: () => '',
    body: (params) => ({
      product: {
        title: params['title'],
        ...(params['price'] === undefined ? {} : { price: params['price'] }),
        ...(params['sku'] === undefined ? {} : { sku: params['sku'] }),
      },
    }),
    sanitize: (response) => ({ product: pickStringFields(asRecord(asRecord(response, 'response')['product'], 'response.product'), ['id', 'title'], 'product') }),
  },
  'shopify.inventory.adjust': {
    method: 'POST',
    effect: 'write',
    idempotent: true,
    path: () => '/inventory_levels/adjust.json',
    query: () => '',
    body: (params) => ({
      inventory_item_id: params['inventoryItemId'],
      available_adjustment: params['availableAdjustment'],
      compare_quantity: params['compareQuantity'],
      ...(params['locationId'] === undefined ? {} : { location_id: params['locationId'] }),
    }),
    sanitize: (response) => {
      const level = asRecord(asRecord(response, 'response')['inventory_level'], 'response.inventory_level');
      return {
        inventory_level: {
          inventory_item_id: nonEmpty(level['inventory_item_id'], 'inventory_level.inventory_item_id'),
          available: integer(level['available'], 'inventory_level.available'),
        },
      };
    },
  },
  'shopify.order.read': {
    method: 'GET',
    effect: 'read',
    idempotent: false,
    path: (params) => `/orders/${params['orderId']}.json`,
    query: (params) => (params['limit'] === undefined ? '' : `?limit=${String(params['limit'])}`),
    body: () => undefined,
    sanitize: (response) => ({ order: pickStringFields(asRecord(asRecord(response, 'response')['order'], 'response.order'), ['id', 'status'], 'order') }),
  },
  'shopify.order.cancel': {
    method: 'POST',
    effect: 'write',
    idempotent: false,
    path: (params) => `/orders/${params['orderId']}/cancel.json`,
    query: () => '',
    body: (params) => (params['reason'] === undefined ? {} : { reason: params['reason'] }),
    sanitize: (response) => ({ order: pickStringFields(asRecord(asRecord(response, 'response')['order'], 'response.order'), ['id', 'status'], 'order') }),
  },
  'shopify.refund.create': {
    method: 'POST',
    effect: 'write',
    idempotent: true,
    path: () => '/refunds.json',
    query: () => '',
    body: (params) => ({
      order_id: params['orderId'],
      amount: params['amount'],
      ...(params['currency'] === undefined ? {} : { currency: params['currency'] }),
      ...(params['reason'] === undefined ? {} : { reason: params['reason'] }),
    }),
    sanitize: (response) => ({ refund: pickStringFields(asRecord(asRecord(response, 'response')['refund'], 'response.refund'), ['id', 'order_id', 'amount'], 'refund') }),
  },
};

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function validateParams(action: ShopifyActionName, params: Record<string, unknown>): ValidParams {
  const allowed: Record<ShopifyActionName, readonly string[]> = {
    'shopify.product.read': ['productId', 'limit'],
    'shopify.product.create': ['title', 'price', 'sku'],
    'shopify.inventory.adjust': ['inventoryItemId', 'availableAdjustment', 'compareQuantity', 'locationId'],
    'shopify.order.read': ['orderId', 'limit'],
    'shopify.order.cancel': ['orderId', 'reason'],
    'shopify.refund.create': ['orderId', 'amount', 'currency', 'reason'],
  };
  for (const key of Object.keys(params)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new ShopifyTransportError(`invalid param: credential-bearing key ${key} is forbidden, the broker holds credentials`);
    }
    if (!allowed[action].includes(key)) {
      throw new ShopifyTransportError(`invalid param: unknown param ${key} for ${action}, strict params only`);
    }
  }
  switch (action) {
    case 'shopify.product.read':
      return {
        productId: nonEmpty(params['productId'], 'productId'),
        ...(params['limit'] === undefined ? {} : { limit: limitParam(params['limit']) ?? 0 }),
      };
    case 'shopify.order.read':
      return {
        orderId: nonEmpty(params['orderId'], 'orderId'),
        ...(params['limit'] === undefined ? {} : { limit: limitParam(params['limit']) ?? 0 }),
      };
    case 'shopify.product.create': {
      const title = nonEmpty(params['title'], 'title');
      const out: ValidParams = { title };
      const price = optionalString(params['price'], 'price');
      if (price !== undefined) out['price'] = price;
      const sku = optionalString(params['sku'], 'sku');
      if (sku !== undefined) out['sku'] = sku;
      return out;
    }
    case 'shopify.inventory.adjust': {
      if (params['compareQuantity'] === undefined) {
        throw new ShopifyTransportError('invalid param: compareQuantity CAS is required for inventory adjust');
      }
      const out: ValidParams = {
        inventoryItemId: nonEmpty(params['inventoryItemId'], 'inventoryItemId'),
        availableAdjustment: integer(params['availableAdjustment'], 'availableAdjustment'),
        compareQuantity: integer(params['compareQuantity'], 'compareQuantity'),
      };
      const locationId = optionalString(params['locationId'], 'locationId');
      if (locationId !== undefined) out['locationId'] = locationId;
      return out;
    }
    case 'shopify.order.cancel': {
      const out: ValidParams = { orderId: nonEmpty(params['orderId'], 'orderId') };
      const reason = optionalString(params['reason'], 'reason');
      if (reason !== undefined) out['reason'] = reason;
      return out;
    }
    case 'shopify.refund.create': {
      const amount = nonEmpty(params['amount'], 'amount');
      if (!AMOUNT_PATTERN.test(amount)) {
        throw new ShopifyTransportError('invalid param: amount must be a decimal string');
      }
      const out: ValidParams = { orderId: nonEmpty(params['orderId'], 'orderId'), amount };
      const currency = optionalString(params['currency'], 'currency');
      if (currency !== undefined) {
        if (!CURRENCY_PATTERN.test(currency)) {
          throw new ShopifyTransportError('invalid param: currency must be a 3-letter code');
        }
        out['currency'] = currency;
      }
      const reason = optionalString(params['reason'], 'reason');
      if (reason !== undefined) out['reason'] = reason;
      return out;
    }
  }
}

export class ShopifyTransport {
  private readonly provenWrites = new Set<string>();

  constructor(private readonly options: ShopifyTransportOptions) {
    if (options.apiVersion !== PINNED_SHOPIFY_API_VERSION) {
      throw new ShopifyTransportError(
        `unsupported api version ${options.apiVersion}, pinned to ${PINNED_SHOPIFY_API_VERSION}`,
      );
    }
    if (!STORE_DOMAIN_PATTERN.test(options.storeDomain)) {
      throw new ShopifyTransportError(
        `invalid store domain ${options.storeDomain}, expected <shop>.myshopify.com`,
      );
    }
  }

  get recipeId(): string {
    return this.options.recipeId;
  }

  async execute(
    action: string,
    params: Record<string, unknown>,
    ctx: TransportExecContext,
  ): Promise<ShopifySanitizedResult> {
    const route = (ROUTES as Record<string, RouteDef | undefined>)[action];
    if (route === undefined) {
      throw new ShopifyTransportError(`unknown canonical action ${action}, only fixed Shopify templates are reachable`);
    }
    const canonical = action as ShopifyActionName;
    if (ctx.storeId !== this.options.storeDomain) {
      throw new ShopifyTransportError(
        `store drift: operation store ${ctx.storeId} does not match bound store ${this.options.storeDomain}`,
      );
    }
    const valid = validateParams(canonical, params);
    if (route.effect === 'write' && this.provenWrites.has(ctx.operationId)) {
      throw new ShopifyTransportError(
        `unproven-write replay refused: operation ${ctx.operationId} already applied, re-approval required`,
      );
    }

    const url = `https://${this.options.storeDomain}/admin/api/${PINNED_SHOPIFY_API_VERSION}${route.path(valid)}${route.query(valid)}`;
    const idempotencyKey = route.idempotent ? `shopify-${ctx.operationId}` : undefined;

    // The broker digests the worker return and yields only a receipt, so the
    // sanitized result leaves via this caller-owned outbox. Only allowlisted
    // sanitized fields are ever written here — the secret never is.
    let outboxSettled = false;
    let outboxResolve: ((value: ShopifySanitizedResult) => void) | undefined;
    const outboxReady = new Promise<ShopifySanitizedResult>((resolve) => {
      outboxResolve = (value) => {
        outboxSettled = true;
        resolve(value);
      };
    });
    const worker = async (secret: string): Promise<ShopifySanitizedResult> => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      };
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      let response;
      try {
        response = await this.options.fetch({
          method: route.method,
          url,
          headers,
          body: route.body(valid),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ShopifyAmbiguousError(
          `ambiguous transport failure for ${canonical}: ${detail}; effect UNKNOWN, safe retry keeps the same idempotency key`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ShopifyTransportError(
          `redirect refused for ${canonical}: status ${response.status}, redirects are never followed`,
        );
      }
      if (response.status >= 500) {
        throw new ShopifyAmbiguousError(
          `ambiguous server error for ${canonical}: status ${response.status}; effect UNKNOWN, safe retry keeps the same idempotency key`,
        );
      }
      if (response.status >= 400) {
        const code = asRecord(response.body, 'error response')['error'];
        throw new ShopifyTransportError(
          `shopify refused ${canonical}: ${typeof code === 'string' ? code : `status ${response.status}`}`,
        );
      }
      const data = route.sanitize(response.body);
      const replayed = (asRecord(response.body, 'response')['replayed'] as unknown) === true;
      const sanitized: ShopifySanitizedResult = {
        action: canonical,
        outcome: route.method === 'GET' ? 'READ_OK' : replayed ? 'REPLAYED' : 'APPLIED',
        data,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(replayed ? { replayed: true } : {}),
      };
      outboxResolve?.(sanitized);
      return sanitized;
    };

    await this.options.broker.credentialUse(
      {
        intentHash: ctx.intentHash,
        permitId: ctx.permitId,
        credentialRef: this.options.credentialRef,
        recipeId: this.options.recipeId,
        requesterId: ctx.requesterId,
        workerId: ctx.workerId,
        scope: SHOPIFY_SCOPE,
      },
      worker,
    );

    if (!outboxSettled) {
      throw new ShopifyTransportError(`broker worker produced no sanitized result for ${canonical}`);
    }
    const outbox = await outboxReady;
    // Only proven writes are fenced: ambiguous attempts stay retryable and
    // keep their idempotency key so a safe retry cannot double-apply.
    if (route.effect === 'write' && outbox.outcome !== 'READ_OK') {
      this.provenWrites.add(ctx.operationId);
    }
    return outbox;
  }
}
