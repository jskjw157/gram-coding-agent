# Production verification coordinator (#159)

## Approved scope
After MODIFY, the normal task flow enters VERIFYING and creates/runs a fresh declared-command plan bound to the registered workspace, exact HEAD and complete file snapshot. Production planning unions requirements per changed path and refuses missing or blank required commands. UI changes are refused until an actual browser-evidence provider exists, including UI mixed with other classes. Repair and live Windows/WSL acceptance remain separate.

## Review contract
Dedicated authenticated verification_review_get/read/submit/fail tools expose one bounded read-only non-command review at a time. Coding remains RUNNING-only. Each durable review binds task, workspace ID/path/branch, process run, plan, HEAD, snapshot digest and check. The active in-memory lease token must continue matching the owned unexpired lease. Restart invalidates pending rows; timeout, failure and shutdown reject waits without releasing an unconfirmed-push lock.

Reads expose exact bounded ordinary-source before/after views for snapshot paths. Presence, mode, content and path enter the locally computed view digest. Every candidate path must have been read and acknowledged for PASS, even when diff approval selects a subset. Each review requires its own reads. Unknown, duplicate, unseen, stale and different-attempt acknowledgements are refused. Accepted result records generate their own evidence reference; caller evidence strings cannot authorize publication. Accepted records are rechecked against plan/check/snapshot during sealing and publication readback.

## Source and command boundaries
HEAD contents use fixed policy-gated task-attributed Git reads through a dedicated CommandRunner with bounded streaming process output and metadata-only durable capture. Raw source never enters its logs or SQLite. Bytes must round-trip strict UTF8 and match the locally resolved Git blob OID after redaction; unsafe/binary/oversized content fails. Ordinary verification commands retain normal persisted evidence capture and #151 approval refusals. No generic shell, new authentication, credentials, installation, deployment or real-account work is added.

## Composition and proof
The coordinator owns planning/execution; the existing completion adapter remains an evidence reader and task-only repair still fails closed. Snapshot equality is checked before/after reads, before accepting each review, around checks and after all required evidence. The existing #158 immutable publish guard remains the authority for exact reviewed paths/bytes. Fixtures verify software contracts only, not live controller or platform readiness.

## Review and validation
Independent review reproduced and fixed two Important issues before publication: a replaced database lease token could be adopted before a new review, and successive commands could change then restore candidate content before the final snapshot. Production coding and review callbacks now compare the actual runtime-held token, and frozen snapshot equality surrounds every command and review. Focused regression reproductions and the final scoped review passed with no unresolved Critical/Important findings.

Final cloud/Linux validation on Node 24.19.0 and pnpm 10.34.5: frozen install, lint, typecheck, 590 root tests, 9 fixture E2Es, build and diff check passed. The new E2E uses authenticated loopback MCP reviews, actual bounded before/after Git views, accepted-review-backed sealing, real local-bare-remote push confirmation, and fixture PR/CI. It proves source text is omitted from review command logs and SQLite. Coding in that E2E remains a deterministic fixture; controller judgment, live Windows/WSL, real-account execution, browser verification and snapshot-aware repair remain outside this acceptance.
