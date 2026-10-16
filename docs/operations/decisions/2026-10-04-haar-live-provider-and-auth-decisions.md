# Architecture Decisions — HAAR Live Provider, Auth UX, Domain Isolation

**Date:** 2026-10-04 (Asia/Seoul)
**Status:** USER APPROVED (decisions below are explicit user decisions)
**Scope:** Source of truth for MAC-03/MAC-04/MAC-05 implementation. Does NOT flip existing DRAFT specs to APPROVED.

## D0 — Sequencing note (added 2026-10-04, user-directed; corrected 2026-10-05: partial UNCONFIRMED)

- Shopify implementation is DEFERRED — USER APPROVED (evidence: user in-session "shopify는 나중에 구현하자"; also "일단 shopify는 나중에 구현하자"). D1 (Shopify as first live provider) stands as the provider decision; only the build order changes. Until re-activated, WP-18 transport live binding, WP-21 Gate B, WP-22 Shopify test-store path, Gate C/D and high-risk live gates stay NOT_RUN/BLOCKED. Fixture-level Shopify adapter work already delivered stays valid as contract/fixture evidence, not live proof.
- Target-Mac account names reported as `mac_ops` (OPERATIONS), `mac_code` (CODING) — UNCONFIRMED (reported, not confirmed; evidence unverifiable).
- Apple Developer Team ID reported as NONE supplied (reported as no membership) — UNCONFIRMED (reported, not confirmed; evidence unverifiable). Production native-helper signing stays BLOCKED; adhoc signatures cover fixture development only. WP-14 execution and WP-20 native Keychain/broker proofs requiring signed peer trust remain gated until a Team ID is verified.

### D0 confirmation (corrected 2026-10-05: partial UNCONFIRMED)

- Of the three items above, only (1) Shopify deferred is USER APPROVED (evidence: in-session explicit user statement "일단 shopify는 나중에 구현하자"). Items (2) account names (reported "mac은 mac_ops, mac_code"; reported UID 502/503 created, homes chmod 700, bidirectional deny verified — reported, not confirmed) and (3) Team ID none (reported "없어" — reported, not confirmed) are UNCONFIRMED pending verifiable evidence.
- Scope ruling for the approved Shopify-deferred item (same session): Shopify Gate B/C/D and live/test-store connections are EXCLUDED from this Mac Goal's completion criteria. Already-delivered Shopify fixture/adapter stays future-ready; no further live Shopify work. Priority is Mac runtime, Operations/Coding isolation, CredentialBroker/Keychain, AuthSessionKeeper/browser session, tunnel-client, real GPT→Mac E2E and Coding E2E — all without Shopify.
- Status of this ledger section: PARTIAL — Shopify-deferred USER APPROVED (evidence above); account-names and Team-ID NONE UNCONFIRMED (reported-not-confirmed, evidence unverifiable). Pre-existing D1–D13 states unchanged.
## D1 — Shopify is the first official live commerce provider

- The earlier analysis was correct: no prior repo/spec confirmed Shopify. The user now explicitly approves **Shopify as HAAR's first official live commerce provider**. It is no longer "platform undecided".
- Provider abstraction is kept: `Provider Registry → Shopify typed adapter → future providers addable`. Never hard-code the whole core to Shopify-only.
- Real API/connector work lives inside the Shopify adapter. Prefer official Shopify API/connector; browser automation is fallback only for UI work the API cannot cover.

## D2 — Login/auth UX: stay signed in, intervene only on human challenges

- Core requirement: operating the store must NOT keep stopping for logins. Never design a flow that asks the user for ID/password or credentials per task.
- Target behavior: one initial login/link, then long-lived unattended auth — OAuth/API providers use the provider's officially supported refresh, rotation, or session-renewal mechanism where available; web logins keep session/cookies via a HAAR-dedicated persistent browser profile and auto re-auth where recoverable. Do not assume every provider or Shopify action exposes a refresh-token flow.
- Human intervention ONLY for: initial registration, MFA, CAPTCHA, passkey, new-device verification, password change, account lock, OAuth revocation — anything the service forces a human for. Those become `WAITING_USER` + user notification.
- Goal: credentials stored safely while normal operation stays unattended — not frequent logins for security theater.

## D3 — macOS Keychain / use-only Credential Broker: APPROVED direction, implementation PENDING

- Keychain is the credential source. Its purpose is sustaining auto-auth without repeated logins, not burdening the user.
- Fixed rules: no generic `secret_get()`; core/ChatGPT never receives password/token plaintext; the credential-owning broker/worker uses credentials directly; raw password/API key/access/refresh tokens never in MCP responses, SQLite, Git, or general logs; only success/failure/safe receipts return.
- The `credential_use(intentHash, permitId, credentialRef, recipeId)` use-only concept may be kept.
- Explicit state split: architecture = USER APPROVED; production implementation + native verification = PENDING. The full MAC-04 doc is NOT declared implemented.

## D4 — Persistent browser session

- Web services use a GramAgent-managed dedicated persistent browser profile (per account/provider as needed), preserving login cookies, auth sessions, provider login state. No fresh-profile-per-task, no logged-out starts.
- Do not casually share the user's personal Chrome default profile. API/connector work outranks browser work.

## D5 — Operations / Coding isolation: OS-enforced from day one

- MAC-03/MAC-04 credential isolation is kept. One physical Mac may run both, but the Shopify-credentialed execution context must NOT freely run arbitrary shell, npm packages, or untrusted repo code.
- Logical split: OPERATIONS DOMAIN (Shopify, commerce APIs/connectors, browser automation, persistent sessions, Keychain broker, real HAAR accounts, ops workflows) vs CODING DOMAIN (Git/GitHub, shell, build/test, package install, untrusted code, coding agent). Typed IPC/control contracts between them; raw credentials never cross into Coding.
- RECOMMENDED (user-approved 2026-10-04 amendment): separate macOS accounts/runtimes from the start for any production profile with live Shopify credentials —
  Mac ├─ OPERATIONS account (ShopifyAdapter, CredentialBroker/Keychain, AuthSessionKeeper, Browser worker) └─ CODING account (Git, shell, build/test, untrusted repos).
  "Same environment, process/privilege split first, separate account later" is NOT approved as a production posture. Same-uid process separation or env-var-only does NOT count as production isolation. A VM is not mandatory, but OS-enforced account separation is the floor.
- Coding side MUST NOT: use credentialRef arbitrarily, query Keychain, touch browser session handles, receive cookies/tokens, or pass arbitrary commands to Operations workers.

## D10 — CredentialBroker / ShopifyAdapter responsibility split (added 2026-10-04)

- Provider Registry → ShopifyAdapter stands. The broker does NOT perform Shopify business APIs (catalog/order/inventory/product/refund) itself.
- ShopifyAdapter: owns typed operations + business logic; never exposes raw HTTP upward; requests credential-use from CredentialBroker.
- CredentialBroker: sole credential-use boundary for Keychain; no raw secret returns; validates credentialRef + intent/permit/recipe; performs the credential-use capability so an approved provider worker can use the credential; never returns raw password/token to core/MCP/Coding.
- Keep the `credential_use(intentHash, permitId, credentialRef, recipeId)` use-only concept. Prefer OAuth/API credentials for Shopify API auth; browser credential injection only in the browser-fallback path.

## D6 — OpenAI connectivity (unchanged)

- OpenAI/ChatGPT → OpenAI `tunnel-client` → localhost MCP → GramAgent core. No Telnet. `tunnel-client` is the only external MCP tunnel; no other tunnel implementations; no `0.0.0.0` MCP bind; localhost only; internal MCP authentication kept.

## D7 — Approval system: risk-tiered commerce operations

- #151 approval persistence + MCP control surface exists but currently covers command-policy. Confirming Shopify as provider does NOT auto-approve commerce mutations.
- The Shopify adapter defines canonical typed operations and effect metadata only. It does not supply a trusted risk tier. The central Policy Engine exclusively maps canonical actions to READ / REMOTE_WRITE / HIGH_RISK / DENY and determines approval requirements. The exact action matrix is fixed during adapter/policy design; providers cannot downgrade their own risk.
- Goal is automated operations, not unapproved risky actions.

## D8 — MAC-02 state discipline

- Current lifecycle state (PR #138 Draft, #160 merged, #148→#165 GREEN pre-integration, B1/B2/B4/C/A remaining) must not be reported as production-complete HAAR ops. Shopify/Keychain items above are architecture requirements for the NEXT stage, not shipped features.

## D9 — No blanket spec approval

- This ledger records decisions; it does not flip DRAFT specs to APPROVED. Later MAC-03/04/05 work cites this file as source of truth.

## D11 — Data-flow & policy refinements (added 2026-10-04)

- **No secret pass-through:** `secret/token → Adapter` path must not exist. Raw password/access/refresh token/cookie never reach ShopifyAdapter/Core/MCP. Chain: ShopifyAdapter → credential-aware Shopify transport/provider worker → CredentialBroker → Keychain. Broker or credential-owning worker uses credentials internally; Adapter gets sanitized result/receipt only.
- **Five-way split:** ShopifyAdapter (business operations) / central Policy Engine (risk + approval verdicts) / CredentialBroker (credential-use authorization + Keychain boundary) / Shopify transport worker (authenticated API requests) / AuthSessionKeeper (OAuth/session upkeep). Broker never owns business semantics or orchestration.
- **Central risk verdicts:** Adapter submits typed operation + effect metadata (e.g. `shopify.product.read`, `shopify.refund.create`); only the central Policy Engine decides READ / REMOTE_WRITE / HIGH_RISK / DENY + approval requirement. Providers cannot downgrade their own risk.
- **Operations approval:** reuse #151 persistence/pending/approve/deny/consume-once, but Shopify ops are NOT auto-protected — operation hash must include task/operation ID, Shopify action, store/account, target resource, parameter digest, effect class, expected version/state, provider/recipe binding. Single-use + expiry; any parameter/target/provider change re-requires approval.
- **Automation defaults:** READ auto (always scope/policy/audit-checked). REMOTE_WRITE auto only within per-action allowlist + scope/limits (e.g. product create, approved-range edits, bounded inventory updates) — never blanket-allow by class. HIGH_RISK/DENY by default: refund, order cancel, payment/settlement, large price changes, customer messages, account/store config changes, bulk deletes. HIGH_RISK needs exact-operation user approval; DENY needs a policy change, not just approval.
- **Audit minimal evidence:** operation ID, action, store/resource canonical ID, parameter digest, policy decision, approval ref, sanitized receipt, result code/timestamp. No full request/response bodies; no credential/token/cookie/sensitive customer data.
- **Session status opaque:** Core never reads cookie plaintext; session-owning worker returns `AUTHENTICATED / EXPIRED / CHALLENGE / ...` only. After user completes auth, reconcile current effect state and resume safely — never blindly replay from scratch.
- **Coding direction:** Operations processes never inject arbitrary commands into the Coding account either; only allowlisted typed coding requests via the common control/task layer. Coding cannot reach Keychain, broker capability, tokens, cookies, Operations profiles, or arbitrary IPC surfaces. Enforced by macOS account/ACL/process/IPC, not types alone.
- **Canonical flow:** GPT → tunnel-client → localhost MCP → Policy/Approval → Operations orchestration → Provider Registry → ShopifyAdapter → credential-aware transport → CredentialBroker/AuthSessionKeeper → Keychain or persistent session → Shopify → sanitized EffectReceipt → audit/task state → GPT.

## D12 — Operations failure and recovery contract (user approved)

This decision supersedes any earlier proposal to reduce durable state to an external error, retry writes using only a local idempotency key, or reuse the installer journal schema for Operations. Architecture is approved; implementation and verification remain pending.

- **External error versus durable state:** external failures default to `{ ok: false, code }`. Raw exceptions, commands, credentials, tokens, cookies and provider raw responses never enter diagnostics, MCP responses or general logs. Internal durable state separately preserves `WAITING_USER`, `WAITING_APPROVAL`, `WAITING_DEPENDENCY`, `RECONCILING`, `UNKNOWN` and `FAILED` as needed for recovery. A safe error response is not proof that a remote effect failed or was not applied.
- **READ retry:** only explicitly side-effect-free bounded reads may retry automatically. Respect rate limits, backoff and a bounded retry budget; exhaustion returns a safe error.
- **Write dispatch and uncertainty:** before dispatching `REMOTE_WRITE` or `HIGH_RISK`, durably record the operation/effect state and idempotency identity. Reusing a key requires the provider's official idempotency guarantee for that specific operation; a key in our DB alone never authorizes retransmission. Ambiguous delivery after timeout or network disconnect becomes `UNKNOWN`, followed by reconciliation, not immediate retry. Only a confirmed `NOT_APPLIED` reconciliation permits consideration of retry, after policy and approval are checked again.
- **Expected state and approval:** a mismatch with the expected provider version/state blocks mutation and forced overwrite. Read current state and enter `RECONCILING`. Changed parameters, target or expected state invalidate reuse of the prior approval and require a new operation hash and approval where policy requires it. Never extend an expired or mismatched approval implicitly. Approval needed means `WAITING_APPROVAL`; a required human authentication challenge means `WAITING_USER`.
- **Authentication recovery:** token/session expiry triggers automatic refresh or re-authentication first. Success, including user-completed authentication, requires checking the current effect before resuming from a safe checkpoint. Never blindly resend a remote write. Unrecoverable MFA, CAPTCHA, passkey, new-device checks, account lock or revoked authorization require `WAITING_USER`.
- **Coding dependency results:** isolate raw process errors, crashes, secrets and runtime internals, not legitimate dependency outcomes. Typed IPC returns allowlisted sanitized codes such as `OK`, `DEPENDENCY_FAILED`, `CANCELLED`, `TIMEOUT` and `UNAVAILABLE`. A failed required Coding dependency moves the Operations workflow to `WAITING_DEPENDENCY` or a safe failure; it must not continue as if successful. Coding worker recovery remains independent of Operations credentials and runtime.
- **Separate Operations ledger:** reuse MAC-02 recovery principles, not installer journal files, schemas or `PARTIAL_INSTALL` terminology. Operations has its own durable operation/effect ledger with states such as `PREPARED`, `DISPATCHING`, `CONFIRMED`, `NOT_APPLIED` and `UNKNOWN`. After restart, unfinished or unknown effects require reconciliation before new mutation. Never automatically delete intermediate state or treat its age as proof of failure or permission to replay. Operations-specific safe codes and task states describe the outcome.

**Invariant:** fail closed → durable before effect → ambiguous effect is UNKNOWN → reconcile before retry → changed identity/state requires renewed approval where required → raw secrets/errors never cross the boundary.

## D13 — Section 5: verification and production acceptance (user approved)

These are acceptance requirements, not claims of tests executed or features shipped. Implementation, native verification and provider onboarding remain pending. CI GREEN is necessary, but insufficient for production acceptance.

### 1. Contract and policy tests

Adapters submit canonical typed actions, such as `shopify.refund.create`, not a trusted risk level. The central Policy Engine's policy table determines risk and approval requirements.

Existing approval must be unusable after any action, store/account, target resource, parameter digest, expected state/version or provider/recipe binding change. Tests also cover expiry, replay, reuse by another task/operation and provider changes after approval. A normal approval cannot promote a `DENY` operation to HIGH_RISK or ALLOW; that requires a separate policy change. READ and automatically allowed REMOTE_WRITE must still block requests exceeding allowed store, scope, resource, quantity or rate limits.

### 2. Effect and recovery fault injection

Test each interruption point independently:

1. Crash before the effect ledger record.
2. Crash after PREPARED is recorded.
3. Crash after DISPATCHING durable commit but before actual transmission.
4. Connection loss immediately after sending the provider request.
5. Provider applies the operation but the response is lost.
6. Response arrives but crash occurs before durable EffectReceipt storage.
7. Receipt is stored but crash occurs before task state update.
8. Crash during reconciliation.

Restart must not unconditionally retransmit REMOTE_WRITE/HIGH_RISK. Ambiguous effects follow `UNKNOWN → provider state query → CONFIRMED / NOT_APPLIED / UNKNOWN`. When non-application cannot be established, preserve UNKNOWN. A local idempotency key is not proof of safe retry; reuse requires an official provider guarantee for the specific operation and remains subject to D12 policy/approval checks.

Also inject faults during OAuth refresh, session expiry, restarts before/after WAITING_USER, crash after approval issuance but before execution, Coding dependency worker crash, Operations core restart and tunnel disconnect/reconnect. Verify no duplicate product creation, inventory adjustment, order handling or refund effects.

### 3. Native macOS security boundaries

Synthetic/unit tests alone do not establish isolation. On the actual target Mac, use separate macOS accounts and demonstrate OS-level rejection of Coding-account access to Operations Keychain credentials, CredentialBroker calls, persistent browser profiles, cookie/session files, private IPC capabilities and private files. Conversely, Operations must not inject arbitrary shell/commands into Coding; only registered typed IPC operations may cross that boundary.

Using synthetic credentials first, search for secret plaintext in MCP responses, SQLite, general logs, diagnostics, audit, argv, environment and error messages; require zero matches. Where capture facilities exist, verify that browser tracing, debug captures and screenshots do not expose authentication fields. Do not use production credentials for the initial leakage test.

### 4. Authentication persistence acceptance

Verify separately: core process restart, tunnel process restart, browser worker restart, Mac reboot with the Operations account session available, network disconnect/reconnect, OAuth access-token expiry, browser-session expiry and persistent-profile reopen. Normal recoverable conditions must restore authentication without repeated login prompts.

Do not bypass an absent macOS user session, locked Keychain/vault, MFA, CAPTCHA, passkey, new-device challenge, revoked OAuth grant or account lock requiring human action. These enter WAITING_USER. After the user resolves the challenge, reconcile the existing effect and resume from a safe checkpoint rather than blindly replaying a write.

### 5. Actual GPT-to-Mac E2E and progressive gates

Direct localhost requests are supporting checks, not substitutes for final E2E. Verify the actual path:

`GPT/ChatGPT → OpenAI tunnel-client → target Mac localhost MCP → Policy/Approval → Operations Core → Provider Registry → ShopifyAdapter → credential-aware transport → Shopify → EffectReceipt → task/audit → GPT`.

| Gate | Required environment and evidence | Activation boundary |
| --- | --- | --- |
| A: Fixture | Local/provider fixture, synthetic credential, READ/WRITE and all recovery fault injection | No live account or remote production effect |
| B: Shopify development/test store | Non-production account/store, actual API/auth binding, READ, allowed product draft/create and inventory writes, failure/reconciliation and persistent authentication | Test-store scope only |
| C: HAAR live READ_ONLY | Actual HAAR account/store binding, allowed product/order reads, credential/session persistence, complete GPT-to-Mac tunnel path, no raw secret or sensitive PII leakage | Requires separate explicit user approval |
| D: HAAR live limited WRITE | Explicitly allowed low-risk writes, narrow scope/quantity/rate limits, expected state/version checks and actual-effect/receipt reconciliation | Requires a new separate user approval; A/B/C never activate D automatically |

### 6. High-risk live actions are not mandatory completion tests

Validate payment, refund, order cancellation, large price changes, customer messages and deletion policy/approval/effect recovery in development/test environments first. Actually executing these against HAAR live is not a prerequisite for overall system completion. Each live action requires a separate action-specific acceptance gate and exact user approval. An E2E-test label never authorizes effects on real money or customers.

### 7. Completion and evidence requirements

Overall acceptance requires all of the following, with UNKNOWN, skipped and unexecuted checks never reported as PASS:

- Unit, contract and policy tests GREEN.
- Fault/recovery tests GREEN.
- Native macOS boundary tests GREEN and actual Operations/Coding account isolation demonstrated.
- Zero synthetic credential leakage across the listed surfaces.
- Shopify development/test-store E2E passed.
- Actual target-Mac tunnel-client E2E passed.
- Core, tunnel and browser restart recovery passed.
- Zero blind automatic retransmissions of ambiguous remote effects.
- Persistent authentication functioning; only unavoidable human-action conditions enter WAITING_USER.
- HAAR live READ_ONLY passed after its separate user approval.

Record the exact commit and release digest, Mac environment, provider/store binding, executed test, sanitized receipt and evidence reference for each result. Keep development/test, target-Mac and live acceptance evidence distinct. Gate D and high-risk live actions remain separately gated even after overall acceptance.
