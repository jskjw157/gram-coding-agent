/**
 * Credential-aware Shopify GraphQL transport (MAC-04/05 WP-18, T6 repair).
 *
 * Evidence re-verified 2026-10-04 against shopify.dev (see GUARANTEES.md):
 * 2026-10 is the latest stable line; REST is legacy and all new public apps
 * must use the GraphQL Admin API; every request carries
 * `X-Shopify-Access-Token` and POSTs to
 * `https://<shop>.myshopify.com/admin/api/2026-10/graphql.json`.
 *
 * The broker holds the credential (contract mirrored structurally from
 * origin/feat/ops-broker — no dependency, no secret ever leaves the lease).
 * Only the six pinned GraphQL operation templates below are reachable;
 * strict params only (no arbitrary URL, no caller-supplied GraphQL text,
 * no redirect following). Only sanitized typed results leave — raw HTTP
 * never travels upward. Fixture fetch only; no live calls.
 */
import type { FixtureFetch } from './fixture-endpoint.js';

export const PINNED_SHOPIFY_API_VERSION = '2026-10';
export const SHOPIFY_GRAPHQL_URL_SUFFIX = '/graphql.json';
/**
 * Platform single-query cost ceiling (1000 cost points). Enforced by
 * construction: pinned fixed-shape templates only, no caller-controlled
 * cost knobs (no `first`/`last`/free-text query). There is deliberately no
 * per-request limit param — callers cannot buy query cost.
 */
export const SHOPIFY_SINGLE_QUERY_COST_CAP = 1000;
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

/** Pinned GraphQL operation templates. The query text is fixed here and
 * never assembled from caller input — params travel as variables only. */
const PRODUCT_READ_QUERY = `query ProductRead($id: ID!) { product(id: $id) { id title } }`;
const PRODUCT_CREATE_MUTATION = `mutation ProductCreate($input: ProductCreateInput!) { productCreate(input: $input) { product { id title } userErrors { field message code } } }`;
const INVENTORY_ADJUST_MUTATION = `mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { inventoryAdjustmentGroup { changes { name delta } } userErrors { field message code } } }`;
const ORDER_READ_QUERY = `query OrderRead($id: ID!) { order(id: $id) { id name cancelledAt } }`;
const ORDER_CANCEL_MUTATION = `mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean) { orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer) { job { id done } orderCancelUserErrors { field message code } userErrors { field message } } }`;
const REFUND_CREATE_MUTATION = `mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) { refundCreate(input: $input) @idempotent(key: $idempotencyKey) { refund { id totalRefundedSet { presentmentMoney { amount currencyCode } } } order { id } userErrors { field message code } } }`;

const ORDER_CANCEL_REASONS = ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'STAFF', 'OTHER'] as const;

type ValidParams = Record<string, string | number | boolean | null>;

interface UserErrorShape {
  readonly field?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

interface OperationDef {
  readonly effect: 'read' | 'write';
  /** True only for mutations in the official @idempotent list (17 as of
   * 2026-02-02): inventoryAdjustQuantities and refundCreate in our set.
   * productCreate and orderCancel are NOT in the list — they carry no key. */
  readonly idempotent: boolean;
  readonly query: string;
  variables(params: ValidParams, idempotencyKey: string | undefined): Record<string, unknown>;
  userErrors(data: Record<string, unknown>): UserErrorShape[];
  sanitize(data: Record<string, unknown>, params: ValidParams): Record<string, unknown>;
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

const optionalBoolean = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ShopifyTransportError(`invalid param: ${label} must be a boolean`);
  }
  return value;
};

const gidSuffix = (gid: string): string => {
  const suffix = gid.split('/').pop();
  return suffix === undefined || suffix.length === 0 ? gid : suffix;
};

const productGid = (id: string): string => `gid://shopify/Product/${id}`;
const orderGid = (id: string): string => `gid://shopify/Order/${id}`;
const inventoryItemGid = (id: string): string => `gid://shopify/InventoryItem/${id}`;
const locationGid = (id: string): string => `gid://shopify/Location/${id}`;

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

const readUserErrors = (value: unknown): UserErrorShape[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is UserErrorShape => typeof entry === 'object' && entry !== null);
};

const OPERATIONS: Record<ShopifyActionName, OperationDef> = {
  'shopify.product.read': {
    effect: 'read',
    idempotent: false,
    query: PRODUCT_READ_QUERY,
    variables: (params) => ({ id: productGid(params['productId'] as string) }),
    userErrors: () => [],
    sanitize: (data) => {
      const product = asRecord(data['product'], 'data.product');
      const picked = pickStringFields(product, ['title'], 'product');
      return { product: { id: gidSuffix(nonEmpty(product['id'], 'product.id')), ...picked } };
    },
  },
  'shopify.product.create': {
    effect: 'write',
    idempotent: false,
    query: PRODUCT_CREATE_MUTATION,
    variables: (params) => ({
      input: {
        title: params['title'],
        ...(params['vendor'] === undefined ? {} : { vendor: params['vendor'] }),
      },
    }),
    userErrors: (data) => readUserErrors(asRecord(data['productCreate'], 'data.productCreate')['userErrors']),
    sanitize: (data) => {
      const payload = asRecord(data['productCreate'], 'data.productCreate');
      const product = asRecord(payload['product'], 'data.productCreate.product');
      const picked = pickStringFields(product, ['title'], 'product');
      return { product: { id: gidSuffix(nonEmpty(product['id'], 'product.id')), ...picked } };
    },
  },
  'shopify.inventory.adjust': {
    effect: 'write',
    idempotent: true,
    query: INVENTORY_ADJUST_MUTATION,
    variables: (params, idempotencyKey) => ({
      input: {
        reason: 'correction',
        name: 'available',
        changes: [
          {
            delta: params['availableAdjustment'],
            inventoryItemId: inventoryItemGid(params['inventoryItemId'] as string),
            locationId: locationGid(params['locationId'] as string),
            // changeFromQuantity is mandatory: an explicit number arms the
            // compare-and-swap guard, explicit null skips it (source of truth).
            changeFromQuantity: params['changeFromQuantity'],
          },
        ],
      },
      idempotencyKey,
    }),
    userErrors: (data) =>
      readUserErrors(asRecord(data['inventoryAdjustQuantities'], 'data.inventoryAdjustQuantities')['userErrors']),
    sanitize: (data, params) => {
      const payload = asRecord(data['inventoryAdjustQuantities'], 'data.inventoryAdjustQuantities');
      const group = asRecord(payload['inventoryAdjustmentGroup'], 'data.inventoryAdjustQuantities.inventoryAdjustmentGroup');
      const changes = group['changes'];
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new ShopifyTransportError('invalid response: inventoryAdjustmentGroup.changes must be non-empty');
      }
      const change = asRecord(changes[0], 'inventoryAdjustmentGroup.changes[0]');
      return {
        inventory_adjustment: {
          inventory_item_id: params['inventoryItemId'],
          delta: integer(change['delta'], 'inventory change.delta'),
        },
      };
    },
  },
  'shopify.order.read': {
    effect: 'read',
    idempotent: false,
    query: ORDER_READ_QUERY,
    variables: (params) => ({ id: orderGid(params['orderId'] as string) }),
    userErrors: () => [],
    sanitize: (data) => {
      const order = asRecord(data['order'], 'data.order');
      const id = gidSuffix(nonEmpty(order['id'], 'order.id'));
      return { order: { id, status: order['cancelledAt'] == null ? 'open' : 'cancelled' } };
    },
  },
  'shopify.order.cancel': {
    effect: 'write',
    // orderCancel is NOT in the official @idempotent list and returns an
    // async Job: no directive, no key. An ambiguous cancel must reconcile
    // order state before any retry — a retry is never deduped by Shopify.
    idempotent: false,
    query: ORDER_CANCEL_MUTATION,
    variables: (params) => ({
      orderId: orderGid(params['orderId'] as string),
      reason: params['reason'],
      restock: params['restock'],
      notifyCustomer: params['notifyCustomer'],
    }),
    userErrors: (data) => {
      const payload = asRecord(data['orderCancel'], 'data.orderCancel');
      return [...readUserErrors(payload['orderCancelUserErrors']), ...readUserErrors(payload['userErrors'])];
    },
    sanitize: (data) => {
      const payload = asRecord(data['orderCancel'], 'data.orderCancel');
      const job = asRecord(payload['job'], 'data.orderCancel.job');
      return {
        cancel_job: {
          id: nonEmpty(job['id'], 'cancel job.id'),
          done: job['done'] === true,
        },
      };
    },
  },
  'shopify.refund.create': {
    effect: 'write',
    idempotent: true,
    query: REFUND_CREATE_MUTATION,
    variables: (params, idempotencyKey) => ({
      input: {
        orderId: orderGid(params['orderId'] as string),
        ...(params['reason'] === undefined ? {} : { note: params['reason'] }),
        transactions: [
          {
            orderId: orderGid(params['orderId'] as string),
            kind: 'REFUND',
            amount: params['amount'],
          },
        ],
      },
      idempotencyKey,
    }),
    userErrors: (data) => readUserErrors(asRecord(data['refundCreate'], 'data.refundCreate')['userErrors']),
    sanitize: (data) => {
      const payload = asRecord(data['refundCreate'], 'data.refundCreate');
      const refund = asRecord(payload['refund'], 'data.refundCreate.refund');
      const order = asRecord(payload['order'], 'data.refundCreate.order');
      const total = asRecord(refund['totalRefundedSet'], 'refund.totalRefundedSet');
      const money = asRecord(total['presentmentMoney'], 'refund.totalRefundedSet.presentmentMoney');
      return {
        refund: {
          id: gidSuffix(nonEmpty(refund['id'], 'refund.id')),
          order_id: gidSuffix(nonEmpty(order['id'], 'order.id')),
          amount: nonEmpty(money['amount'], 'refund amount'),
        },
      };
    },
  },
};

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/u;

function validateParams(action: ShopifyActionName, params: Record<string, unknown>): ValidParams {
  const allowed: Record<ShopifyActionName, readonly string[]> = {
    'shopify.product.read': ['productId'],
    'shopify.product.create': ['title', 'vendor'],
    'shopify.inventory.adjust': ['inventoryItemId', 'locationId', 'availableAdjustment', 'changeFromQuantity'],
    'shopify.order.read': ['orderId'],
    'shopify.order.cancel': ['orderId', 'reason', 'restock', 'notifyCustomer'],
    'shopify.refund.create': ['orderId', 'amount', 'reason'],
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
      return { productId: nonEmpty(params['productId'], 'productId') };
    case 'shopify.order.read':
      return { orderId: nonEmpty(params['orderId'], 'orderId') };
    case 'shopify.product.create': {
      const out: ValidParams = { title: nonEmpty(params['title'], 'title') };
      const vendor = optionalString(params['vendor'], 'vendor');
      if (vendor !== undefined) out['vendor'] = vendor;
      return out;
    }
    case 'shopify.inventory.adjust': {
      // changeFromQuantity is mandatory as a KEY: callers must pass an
      // explicit number (CAS armed) or explicit null (CAS skipped as source
      // of truth). A missing key is a caller bug, not a default.
      if (!('changeFromQuantity' in params)) {
        throw new ShopifyTransportError('invalid param: changeFromQuantity is required (explicit number or null) for inventory adjust');
      }
      const expected = params['changeFromQuantity'];
      if (expected !== null) integer(expected, 'changeFromQuantity');
      return {
        inventoryItemId: nonEmpty(params['inventoryItemId'], 'inventoryItemId'),
        locationId: nonEmpty(params['locationId'], 'locationId'),
        availableAdjustment: integer(params['availableAdjustment'], 'availableAdjustment'),
        changeFromQuantity: expected as number | null,
      };
    }
    case 'shopify.order.cancel': {
      const reason = params['reason'] === undefined ? 'CUSTOMER' : nonEmpty(params['reason'], 'reason');
      if (!(ORDER_CANCEL_REASONS as readonly string[]).includes(reason)) {
        throw new ShopifyTransportError(`invalid param: reason must be one of ${ORDER_CANCEL_REASONS.join(',')}`);
      }
      return {
        orderId: nonEmpty(params['orderId'], 'orderId'),
        reason,
        restock: optionalBoolean(params['restock'], 'restock') ?? true,
        notifyCustomer: optionalBoolean(params['notifyCustomer'], 'notifyCustomer') ?? false,
      };
    }
    case 'shopify.refund.create': {
      const amount = nonEmpty(params['amount'], 'amount');
      if (!AMOUNT_PATTERN.test(amount)) {
        throw new ShopifyTransportError('invalid param: amount must be a decimal string');
      }
      const out: ValidParams = { orderId: nonEmpty(params['orderId'], 'orderId'), amount };
      const reason = optionalString(params['reason'], 'reason');
      if (reason !== undefined) out['reason'] = reason;
      return out;
    }
  }
}

function throwOnUserErrors(canonical: ShopifyActionName, errors: UserErrorShape[]): void {
  if (errors.length === 0) return;
  const stale = errors.find((entry) => entry['code'] === 'CHANGE_FROM_QUANTITY_STALE');
  if (stale !== undefined) {
    throw new ShopifyTransportError(
      `compare-quantity-mismatch (CHANGE_FROM_QUANTITY_STALE) for ${canonical}: ${String(stale['message'] ?? 'stale inventory')}; no effect applied`,
    );
  }
  const messages = errors.map((entry) => String(entry['message'] ?? entry['code'] ?? 'unknown'));
  throw new ShopifyTransportError(`shopify refused ${canonical}: ${messages.join('; ')}`);
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
    const operation = (OPERATIONS as Record<string, OperationDef | undefined>)[action];
    if (operation === undefined) {
      throw new ShopifyTransportError(`unknown canonical action ${action}, only fixed Shopify templates are reachable`);
    }
    const canonical = action as ShopifyActionName;
    if (ctx.storeId !== this.options.storeDomain) {
      throw new ShopifyTransportError(
        `store drift: operation store ${ctx.storeId} does not match bound store ${this.options.storeDomain}`,
      );
    }
    const valid = validateParams(canonical, params);
    if (operation.effect === 'write' && this.provenWrites.has(ctx.operationId)) {
      throw new ShopifyTransportError(
        `unproven-write replay refused: operation ${ctx.operationId} already applied, re-approval required`,
      );
    }

    const url = `https://${this.options.storeDomain}/admin/api/${PINNED_SHOPIFY_API_VERSION}${SHOPIFY_GRAPHQL_URL_SUFFIX}`;
    const idempotencyKey = operation.idempotent ? `shopify-${ctx.operationId}` : undefined;

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
        'content-type': 'application/json',
        'X-Shopify-Access-Token': secret,
      };
      let response;
      try {
        response = await this.options.fetch({
          method: 'POST',
          url,
          headers,
          body: { query: operation.query, variables: operation.variables(valid, idempotencyKey) },
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
      if (response.status === 429) {
        throw new ShopifyTransportError(
          `throttled for ${canonical}: status 429, back off and retry; effect UNKNOWN, safe retry keeps the same idempotency key`,
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
      const body = asRecord(response.body, 'response');
      const topErrors = readUserErrors((body['errors'] as unknown) ?? []);
      if (topErrors.length > 0) {
        const codes = topErrors.map((entry) => String(entry['code'] ?? entry['message'] ?? ''));
        if (codes.some((code) => /THROTTLED|MAX_COST_EXCEEDED/u.test(code))) {
          throw new ShopifyTransportError(
            `throttled for ${canonical}: ${codes.join('; ')}, back off and retry; effect UNKNOWN, safe retry keeps the same idempotency key`,
          );
        }
        throw new ShopifyTransportError(
          `shopify GraphQL error for ${canonical}: ${topErrors.map((entry) => String(entry['message'] ?? entry['code'] ?? 'unknown')).join('; ')}`,
        );
      }
      const data = asRecord(body['data'], 'response.data');
      throwOnUserErrors(canonical, operation.userErrors(data));
      const sanitizedData = operation.sanitize(data, valid);
      const replayed = body['replayed'] === true;
      const sanitized: ShopifySanitizedResult = {
        action: canonical,
        outcome: operation.effect === 'read' ? 'READ_OK' : replayed ? 'REPLAYED' : 'APPLIED',
        data: sanitizedData,
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
    if (operation.effect === 'write' && outbox.outcome !== 'READ_OK') {
      this.provenWrites.add(ctx.operationId);
    }
    return outbox;
  }
}
