# Shopify Adapter — Per-Action Guarantee Matrix

Pinned discovery: **2026-10**. Every pin below is transcribed from the WP-17
discovery brief named in the WP-18 task and marked **RE-VERIFY** where a live
contract must be re-confirmed before any production use. Fixture transport
only — no live calls exist in this package.

## Discovery pins (WP-17, 2026-10)

- API: latest stable version line pinned as `2026-10` in transport.
  **RE-VERIFY** the current stable line before live use.
- Tokens: offline / online / delegate token kinds; expiring tokens live
  1h with 90d refresh. **RE-VERIFY** lifetimes against current docs.
- Minimum scopes: `read_products`, `write_products`, `write_inventory`,
  `read_orders`. **RE-VERIFY** scope names before requesting consent.
- Idempotency: 17 `@idempotent` mutations including refund creation and
  inventory adjustment, 24h window. **RE-VERIFY** the mutation list and
  window — dedupe keys are honored only inside the window.
- Rate limits: buckets 100 / 200 / 1000 / 2000 (as reported by WP-17).
  **RE-VERIFY** bucket semantics and headers before live traffic shaping.
- Single-query cap: 1000. Enforced by the transport (`limit` 1..1000).

## Per-action matrix

| Canonical action | Effect | Policy expectation | Idempotency | CAS / guard | Notes |
|---|---|---|---|---|---|
| `shopify.product.read` | READ | ALLOW | n/a (read) | `limit` ≤ 1000 | Sanitized `{product[id,title]}` only |
| `shopify.product.create` | WRITE | REMOTE_WRITE (approval) | **NO CLAIM — UNKNOWN-on-ambiguity** | strict title; no replay after proven apply | Retry may duplicate; reconcile first |
| `shopify.inventory.adjust` | WRITE | REMOTE_WRITE (approval) | `@idempotent` key `shopify-<op>` (24h window — **RE-VERIFY**) | `compareQuantity` CAS required; 409 mismatch applies nothing | Unproven retry reuses key: single effect |
| `shopify.order.read` | READ | ALLOW | n/a (read) | `limit` ≤ 1000 | Sanitized `{order[id,status]}` only |
| `shopify.order.cancel` | DELETE | HIGH_RISK (approval) | **NO CLAIM — UNKNOWN-on-ambiguity** | second cancel refused (`already-cancelled`, no new effect) | Ambiguous cancel must reconcile order state before retry |
| `shopify.refund.create` | WRITE | HIGH_RISK (approval) | `@idempotent` key `shopify-<op>` (24h window — **RE-VERIFY**) | amount decimal string; optional 3-letter currency | Unproven retry reuses key: single effect |

## Cross-cutting guarantees

- Verdict-only risk (D11): caller `hint.claimedRisk` is accepted
  structurally and never consulted; NEEDS_APPROVAL without approval and
  DENY (non-promotable) always refuse before any broker contact.
- Verdict binding: verdict `operationHash` must equal the intent hash over
  the full identity (task, operation, action, store, account, resource,
  params, effect, state, version, provider `shopify.v1`, recipe); mismatch
  refuses without touching the broker.
- Broker-held credential (D10): the secret is used inside the lease only;
  credential-bearing params are refused at adapter and transport; results
  are allowlisted sanitized fields — raw HTTP and secrets never travel up.
- Fixed templates only: six pinned paths under
  `https://<shop>.myshopify.com/admin/api/2026-10/`; unknown actions,
  unknown params, and redirects refuse instead of resolving.
- Store binding: operation `storeId` must equal the bound store domain;
  drift refuses with zero external effects.
- Proven-write fence: a successfully applied write never replays under the
  same operation id; ambiguous attempts stay retryable and keep their key.
