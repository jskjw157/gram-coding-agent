# Shopify Adapter — Per-Action Guarantee Matrix

Pinned discovery: **2026-10**. Every pin below is transcribed from the
official shopify.dev references fetched **2026-10-04** (evidence links
inline) and marked **RE-VERIFY** where a live contract must be
re-confirmed before any production use. Fixture transport only — no live
calls exist in this package.

## Discovery pins (re-verified 2026-10-04)

- API: `2026-10` is the latest stable line (released 2026-10-01, supported
  until 2027-10-16). Pinned in transport. **RE-VERIFY** the current stable
  line before live use.
  Evidence: https://shopify.dev/docs/api/usage/versioning (fetched 2026-10-04).
- GraphQL required: REST is a legacy API (as of 2024-10-01); all new public
  apps must be built exclusively with the GraphQL Admin API (since
  2025-04-01). The transport speaks GraphQL only — no REST paths exist.
  Evidence: https://shopify.dev/docs/api/admin-rest,
  https://shopify.dev/docs/api/admin-graphql (fetched 2026-10-04).
- Endpoint + auth: `POST https://{shop}.myshopify.com/admin/api/2026-10/graphql.json`
  with `X-Shopify-Access-Token` (never `Authorization: Bearer`).
  Evidence: https://shopify.dev/docs/api/admin-graphql (fetched 2026-10-04).
- Tokens: offline / online / delegate token kinds; expiring tokens live
  1h with 90d refresh. **RE-VERIFY** lifetimes against current docs.
  (Carried from WP-17; token-lifetime page not re-fetched this round.)
- Minimum scopes: `read_products`, `write_products`, `write_inventory`,
  `read_orders`. **RE-VERIFY** scope names before requesting consent.
  (Carried from WP-17; scope catalog not re-fetched this round.)
- Idempotency: exactly 17 `@idempotent` mutations (list last updated
  2026-02-02), including `inventoryAdjustQuantities` and `refundCreate`;
  `productCreate` and `orderCancel` are NOT in the list. 24h retention
  window — dedupe keys are honored only inside the window. As of 2026-04
  the key is REQUIRED for the listed mutations. **RE-VERIFY** the mutation
  list and window before live use.
  Evidence: https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency,
  https://shopify.dev/docs/api/usage/idempotent-requests (fetched 2026-10-04).
- Inventory CAS: `InventoryChangeInput.changeFromQuantity` is mandatory —
  pass an explicit quantity (guard armed) or explicit `null` (guard
  skipped, source-of-truth only). Mismatch fails with
  `CHANGE_FROM_QUANTITY_STALE` and applies nothing.
  Evidence: https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryChangeInput,
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities
  (fetched 2026-10-04).
- orderCancel is async: returns `Job { id done }` (plus
  `orderCancelUserErrors`), requires `write_orders` (or marketplace/buyer
  variants), irreversible. No `@idempotent` support — a retry is never
  deduped by Shopify.
  Evidence: https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel
  (fetched 2026-10-04).
- Refund scope nuance: `refundCreate` requires the `orders` family
  (`orders` / `marketplace_orders` / `buyer_membership_orders`). The
  adapter assumes `write_orders`; **verify-at-implement**: confirm the
  target shop grants refund creation under the requested scope before live
  use.
  Evidence: https://shopify.dev/docs/api/admin-graphql/latest/mutations/refundCreate
  (fetched 2026-10-04).
- Rate limits: GraphQL cost buckets per app+store — Standard 100,
  Advanced 200, Plus 1000, enterprise 2000 points/sec (leaky bucket,
  `throttleStatus` in `extensions.cost`); single-query max cost 1000.
  **RE-VERIFY** bucket semantics before live traffic shaping.
  Evidence: https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
  (fetched 2026-10-04).
- Resource-based variant throttle: GATED — a daily cap applies past a
  catalog-size threshold (Plus-exempt). Threshold and cap numbers are
  deliberately NOT recorded here; verify current values at implement time.
  Evidence: https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
  (fetched 2026-10-04).
- Single-query cap: 1000 cost points. Enforced by construction
  (`SHOPIFY_SINGLE_QUERY_COST_CAP`): pinned fixed-shape templates only,
  no caller-controlled cost knobs — there is no per-request limit param
  because callers cannot buy query cost.

## Per-action matrix

| Canonical action | GraphQL operation | Effect | Policy expectation | Idempotency | CAS / guard | Notes |
|---|---|---|---|---|---|---|
| `shopify.product.read` | `ProductRead` query | READ | ALLOW | n/a (read) | fixed shape, no cost knobs | Sanitized `{product[id,title]}` only |
| `shopify.product.create` | `productCreate` mutation | WRITE | REMOTE_WRITE (approval) | **NO CLAIM — UNKNOWN-on-ambiguity** (not in `@idempotent` list) | strict title; no replay after proven apply | Retry may duplicate; reconcile first |
| `shopify.inventory.adjust` | `inventoryAdjustQuantities` + `@idempotent` | WRITE | REMOTE_WRITE (approval) | key `shopify-<op>` (24h window — **RE-VERIFY**) | `changeFromQuantity` explicit number or `null`; `CHANGE_FROM_QUANTITY_STALE` applies nothing | Unproven retry reuses key: single effect |
| `shopify.order.read` | `OrderRead` query | READ | ALLOW | n/a (read) | status derived from `cancelledAt` | Sanitized `{order[id,status]}` only |
| `shopify.order.cancel` | `orderCancel` mutation (async `Job`, **no key**) | DELETE | HIGH_RISK (approval) | **NO CLAIM — UNKNOWN-on-ambiguity** (not in `@idempotent` list) | second cancel refused (`already-cancelled`, no new effect) | Ambiguous cancel must reconcile order state before retry; retry never deduped |
| `shopify.refund.create` | `refundCreate` + `@idempotent` | WRITE | HIGH_RISK (approval) | key `shopify-<op>` (24h window — **RE-VERIFY**) | amount decimal string; optional note | Unproven retry reuses key: single effect; scope verify-at-implement (`write_orders` assumed) |

## Cross-cutting guarantees

- Verdict-only risk (D11): caller `hint.claimedRisk` is accepted
  structurally and never consulted; NEEDS_APPROVAL without approval and
  DENY (non-promotable) always refuse before any broker contact.
  (Kept: fresh docs do not contradict verdict binding — internal policy
  design, verified 2026-10-04 by code inspection of `adapter.ts`.)
- Verdict binding: verdict `operationHash` must equal the intent hash over
  the full identity (task, operation, action, store, account, resource,
  params, effect, state, version, provider `shopify.v1`, recipe); mismatch
  refuses without touching the broker.
- Broker-held credential (D10): the secret is used inside the lease only,
  sent as `X-Shopify-Access-Token`; credential-bearing params are refused
  at adapter and transport; results are allowlisted sanitized fields — raw
  HTTP and secrets never travel up.
- Fixed templates only: six pinned GraphQL operations POSTed to
  `https://<shop>.myshopify.com/admin/api/2026-10/graphql.json`; unknown
  actions, unknown params (including any `query`/`graphql`/`url`
  passthrough), and redirects refuse instead of resolving.
- Store binding: operation `storeId` must equal the bound store domain;
  drift refuses with zero external effects.
- Proven-write fence: a successfully applied write never replays under the
  same operation id; ambiguous attempts stay retryable and keep their key.
- Throttle handling: `429` / `THROTTLED` / `MAX_COST_EXCEEDED` surface as
  deterministic refusals (pre-execution rejections — safe to retry with the
  same key); never claimed as applied.
