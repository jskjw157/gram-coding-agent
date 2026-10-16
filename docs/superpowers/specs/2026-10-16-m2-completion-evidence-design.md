# M2 Completion Evidence Design

**Status:** Implementation in progress; no release or acceptance claim is made by this document
**Date:** 2026-10-16
**Scope:** Close the two evidence gaps found after successful Public smoke TASK-000005 without changing the approved M2 lock boundary

## Purpose

TASK-000005 proved the functional M2 path through `COMPLETED`, but it exposed two gaps:

1. PR metadata did not report the path approved by an `external-review:` verification record.
2. Existing `CI_OBSERVATION_STARTED` audit rows prove a logical polling attempt, not the SQLite row and filesystem lock state at each actual GitHub request boundary.

This design adds the missing evidence while preserving the approved sequence:

```text
commit -> push -> remote confirm -> lock release -> PR -> CI -> COMPLETED
```

It does not alter the successful TASK-000005 records or invent observations for past requests.

## Required invariants

- Remote confirmation precedes Repo Lock release.
- PR creation and CI observation do not acquire or hold the repository mutation lock.
- `@gram/github` remains independent of `@gram/repo-lock`.
- A later legitimate task may acquire the same repository lock while an earlier PR is being observed. Normal CI observation therefore must not gain a global lock-absence policy.
- Evidence is bound to the canonical Task UUID, immutable GitHub repository ID, exact 40-character HEAD SHA, and PR identity when available.
- Evidence records are append-only. Restart, retry, pagination, and repaired HEADs create new rows rather than overwrite old rows.
- No token, authorization header, secret value, request body, response body, or raw credential-bearing error is persisted.
- Historical TASK-000005 evidence remains unchanged. Its missing lock samples remain explicitly missing.

## Changed-path evidence repair

`PullRequestEvidenceRepository` must obtain changed paths only from the latest applicable verification plan and the exact approved review evidence for that task and bound HEAD.

The resolver supports both formats:

- legacy `diff-review:` evidence references;
- current `external-review:` references backed by a persisted accepted verification review.

An external review contributes paths only when all of these match:

- Task UUID;
- verification plan ID;
- plan HEAD SHA;
- review ID referenced by the verification check;
- terminal accepted review status.

Unknown evidence formats, malformed paths, rejected or pending reviews, reviews for another Task or HEAD, and paths outside the review's approved list contribute nothing. Returned paths are normalized repository-relative paths, deduplicated, and safe for Markdown rendering. Verification status text and evidence references are never copied into the PR body as secrets.

## Provider-boundary lock observation

### Boundary placement

The observation seam belongs in `apps/agent`, where application composition knows the Task, repository, published HEAD, and smoke configuration. It must not add Repo Lock dependencies to `packages/github`.

`createProductionGitHubServices()` constructs a context-bound GitHub fetch wrapper for each PR or CI operation. The wrapper brackets every real provider request with an immutable BEFORE and AFTER sample. This is below the logical `ChecksService.listRequiredChecks()` boundary and therefore covers all current HTTP calls:

- PR lookup;
- PR creation;
- active branch-rules query;
- legacy commit-status query;
- required-status-check protection query;
- every check-runs pagination request.

The wrapper persists only a sanitized endpoint kind, HTTP method, and numeric page where relevant. It does not persist raw URLs or HTTP payloads.

### Context and correlation

Every sample carries:

```text
taskId
repoId
headSha
correlationId
endpoint = PR_FIND | PR_CREATE | RULES | STATUSES | PROTECTION | CHECK_RUNS
requestId
boundary = BEFORE | AFTER
observedAt
pullRequestId = nullable
```

`endpoint` is the canonical phase discriminator: PR_FIND and PR_CREATE belong to
PR operations; the other endpoints belong to CI observation. No separate `phase`
field is stored. `dbObservedAt` and `fileObservedAt` identify the two independent
measurements; `observedAt` is the journal append time.

The provider PR number is stored on the validated PR_BINDING record, rather than
on each BOUNDARY sample. CI samples reference the internal PR row directly.

The PR's internal row ID cannot exist before the provider creates or returns the PR. Pre-create samples therefore use a fresh correlation ID and a null internal PR ID. After `PullRequestRepository.upsertForTask()` returns the authoritative row, a separate append-only binding record links the correlation ID to the validated internal row ID and provider PR number. Earlier samples are never backfilled or rewritten.

Before writing the binding, the application verifies Task UUID, repo ID, provider number, head branch, and base branch. The exact HEAD SHA remains the published SHA carried into PR ensure.

CI samples already have the persisted internal PR row ID and bind it directly with the Task, repo, and HEAD.

### Independent lock-state reader

The observer uses Node 24's built-in `node:sqlite` `DatabaseSync` with `readOnly: true` (which requires an existing database) and `query_only=ON`. This is a separate connection, never the mutation handle or `openDatabase()` helper. The context is verified against tasks and remote-confirmed git_commits; CI PR identity and PR binding are independently resolved from persisted rows.

Each sample performs `SELECT 1 FROM repo_locks WHERE repo_id = ?`. It records row presence only, never lease tokens or owner content. The exact `<stateDirectory>/locks/<repoId>.lock` is checked with `lstat`; absent/present and separate DB/file measurement timestamps are stored. Symlinks, nonregular files, permission errors and database failures are inspection errors, not absence. File contents are deliberately never read: even malformed JSON is recorded as present and therefore cannot satisfy smoke absence acceptance.

### Durable append-only journal

The separate `<stateDirectory>/smoke-lock-evidence.sqlite` file is created with mode `0600`, checked for regular-file type, private permissions and current-user ownership, and uses WAL plus synchronous FULL. Existing journals append on restart. INSERT/read APIs and UPDATE/DELETE-denying triggers preserve observation history. The schema is `observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, payload TEXT)`. Each JSON payload carries schema version, process/session identity and observation time.

BOUNDARY payloads contain taskId, repoId, headSha, correlationId, pullRequestId (nullable), requestId, endpoint enum, method, page, BEFORE/AFTER, dbPresent, filePresent, and individual measurement timestamps. AFTER additionally records RESPONSE/status or TRANSPORT_ERROR, never raw errors. PR_BINDING payloads link the original correlationId to the independently resolved internal pullRequestId and provider number without changing previous records. The journal is not a tamper-proof defense against the same OS user who owns it; that threat remains a separate hardening concern.

The journal commits the BEFORE row before provider I/O. AFTER is a new row even when the provider returns an HTTP error or transport failure. A process crash after BEFORE and before AFTER remains visible as an interrupted request rather than being silently lost.

### Scope and failure behavior

The observer is activated only by trusted local service configuration for one disposable smoke repository ID. It is not exposed through MCP and cannot be enabled by task text.

- When disabled or when the repository does not match, behavior is unchanged.
- For the scoped smoke repository, a BEFORE inspection or journal-write failure prevents provider I/O. An AFTER measurement failure fails the scoped operation after possible remote effects; its missing AFTER remains visible and must not be treated as a network-only failure or retried blindly.
- A present, valid lock is recorded. It does not become a global runtime policy and does not block unrelated tasks. The smoke acceptance evaluator rejects the run.
- Other repositories and normal CI observations are unaffected.

BEFORE and AFTER samples prove the lock state at the request boundaries. They do not mathematically exclude an acquire-and-release occurring entirely inside one network request. The reports must use the bounded phrase "provider-boundary absence" unless a future append-only Repo Lock mutation journal closes that interval.

## Acceptance evaluation

A new live smoke is technically acceptable only when all of the following are proven from current evidence:

- Task reaches `COMPLETED`.
- All required verification checks have persistent PASS evidence.
- PR changed paths equal the actual reviewed diff.
- Remote branch resolves to the recorded commit SHA.
- `remote_confirmed <= lock_released < pr_created <= first_ci_observation`.
- Every scoped PR/CI provider request has a committed BEFORE sample and, unless interrupted, an AFTER sample.
- Every relevant sample reports both SQLite row absent and filesystem lock absent.
- The PR binding connects pre-create correlation to the authoritative PR row.
- Required GitHub CI succeeds for the exact HEAD.
- No secret appears in product logs, SQLite, PR metadata, or evidence reports.

## Formal acceptance boundary

The approved M2 acceptance procedure requires a disposable **private** GitHub repository. A GitHub Free/Public smoke can prove functional behavior but cannot satisfy that formal gate. Until a private smoke is performed or the acceptance criterion is explicitly changed, the correct final state is `PUBLIC_FUNCTIONAL_PASS_FORMAL_GATE_BLOCKED`, even if all code and Public smoke checks pass.

Unresolved M5 security RED findings are reported separately and cannot be described as M2 security success. This work does not merge M3/M4/M5 drafts, weaken checks, merge main, publish a tag, or deploy a release.

## Source references read

- `AGENTS.md`
- `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`
- `docs/superpowers/plans/2026-09-15-m2-first-vertical-slice.md`
- `docs/operations/m2-live-smoke.md`
- `apps/agent/src/task-runner-composition.ts`
- `apps/agent/src/github-services.ts`
- `apps/agent/src/ci-observation-audit.test.ts`
- `apps/agent/src/main.ts`
- `packages/task-engine/src/task-runner.ts`
- `packages/task-engine/src/task-runner-ports.ts`
- `packages/github/src/github-client.ts`
- `packages/github/src/checks-client.ts`
- `packages/github/src/checks-service.ts`
- `packages/github/src/pull-request-service.ts`
- `packages/github/src/architecture-boundary.test.ts`
- `packages/publishing/src/publishing-service.ts`
- `packages/repo-lock/src/repo-lock-service.ts`
- `packages/persistence/src/database.ts`
- `packages/persistence/src/repositories/lock-repository.ts`
- `packages/persistence/src/repositories/pull-request-evidence-repository.ts`
- `packages/persistence/src/repositories/pull-request-repository.ts`
