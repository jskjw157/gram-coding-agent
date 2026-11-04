# Read-only database implementation evidence ? 2026-11-04

## Scope and candidate lineage

The user selected MySQL/MariaDB for ChatGPT -> Gram -> named read-only database -> SELECT results. This branch stacks on PR#240 (`1de9ea1179e362e3815c842b786697cf909a38d3`), which itself stacks on PR#239. Main was `474d54071d0639e880b10178699c4ef10d60023e` at preparation. No merge, release, production configuration/service transition or business database connection is claimed.

## Implementation

Two optional authenticated MCP tools expose connection IDs/engines and bounded prepared SELECT results. Trusted root-owned configuration fixes endpoints, accounts, TLS and output/time limits. Credentials are acquired through existing FileSecretProvider leases. The runtime uses a conservative AST allowlist, direct read-only grant inspection, server READ ONLY transactions and streamed prepared results. Cancellation owns its exact connection/query and requires rollback/process-state evidence before cleanup. Uncertain cleanup quarantines further DB queries; unrelated coding Task shutdown still drains normally. Existing filesystem/Git/Task and command-isolation policies remain unchanged.

## RED -> GREEN and review

Real-MCP registration/cancellation RED preceded the transport implementation. Policy rejects mutations, unsupported functions, Unicode function confusables and unsafe AST forms. The initial real database fixtures exposed streamed-command packet compatibility and incomplete strict-mode warnings. Independent review exposed binary credential screening before base64 and cleanup/shutdown races. Failing regressions were retained before repairs, including final rollback stalls, stream errors, unproven remote Query state and unrelated Task drain on DB shutdown failure. No tests were skipped, weakened or assigned fake PASS results.

An independent Sol code/security reviewer inspected23 files and reported zero remaining scoped issues; fresh scoped154/154 checks passed. This approval does not certify unrelated existing dependencies or an unprovided production database.

## Local verification

| Check | Result |
|---|---|
| `pnpm lint` | PASS |
| `pnpm typecheck` including native DB tests | PASS |
| `pnpm test` | 1,366 PASS |
| `pnpm test:e2e` | 28 PASS |
| `pnpm test:security` | PASS;24 Node security,13 boundary,3 native build,10 installer checks |
| `pnpm test:owner-native` | 6 PASS using rehashed actual protected artifacts |
| `pnpm build` | PASS |
| Real MySQL8.4 + MariaDB10.11 matrix | 40/40 PASS |
| Node24.21.0 compiled Agent, UID1000, actual root-owned config | PASS |

The first full unit run had1 existing verification-coordinator test exceed its5000ms timeout at5108ms under concurrent load;1365 others passed. The unchanged test passed a focused recheck and the unchanged full suite then passed1366/1366. Neither production/test behavior nor timeout thresholds were altered.

The compiled Agent probe used separate disposable state, generated fixture authentication and actual protected configuration, not mocked composition. Its baseline17 tools became19 with exactly2 DB tools. Authenticated SELECT42 succeeded against both actual TLS endpoints, an invalid MCP token was denied, UPDATE was denied, health was healthy/ok/ready and normal shutdown left SQLite integrity ok with0 Tasks/0 Locks. This was local authenticated MCP, not the user's external ChatGPT connection.

Actual matrix coverage includes precision/duplicate columns/binds, account and transaction write denial, unchanged sentinel data, TLS chain/hostname failures, row/byte/column/packet bounds, credential text/binary screening, and real abort/deadline/runtime-close with independent server process checks. Only labelled disposable loopback containers were used.

## Evidence locations and disclosure boundary

Local sanitized diagnostics are under `C:\source\gram-agent-diagnostics\readonly-db\`: `20261104-mcp`, `20261104-real/final-summary.json`, `20261104-real/post-repair-full40.{log,json}`, and `full-checks-20261104/`. These retain initial failures and rechecks. The private `/tmp/gram-db-fixture.*` directories contain generated passwords and TLS keys: never upload them or Docker inspect/environment dumps. CI runs the same real matrix in its dedicated `database-readonly-native` job; exact commit/check links belong in the PR after execution.

## Remaining acceptance

The actual server address/port/database/read-only account and existing password entered through a local secret store are not yet provided. No actual business SQL or production deployment/external ChatGPT query is verified. Deployment and connection acceptance require the normal idle/backup/exact-build gates.

A production dependency audit separately reported5 HIGH/3 moderate advisories in pre-existing MCP SDK/Zod/Hono dependencies, not the two new DB packages. Common-layer upgrades are pending explicit scope approval; this DB change does not claim those findings resolved. Some advisory fixes require runtime limits in addition to version updates. Do not describe the whole Agent as vulnerability-free based on scoped DB review.
