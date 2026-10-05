# WP-07 Convergence: M2 Reuse, Hash Preimages, Status/Kind Mapping, Single-Writer, Lane Disposition

Date: 2026-10-04
Scope: MAC-02/03 WP-07. Source of truth: decisions D1-D13.
Lineage: M2 branch `origin/feat/m2-vertical-slice` (`efa4acc`). Base: `origin/main` (`b17f2ba`).
Rule: no code in this note. Reuse M2; ops lanes are additive consumers only.

## (a) M2 reuse list (do not reimplement)

| # | M2 artifact | Verified ref (M2 branch) | Reuse directive |
|---|-------------|--------------------------|-----------------|
| 1 | task-engine state machine | `packages/task-engine/src/state-machine.ts:1` (`import { canTransitionTaskStatus, type TaskId, type TaskStatus }`) | Ops lanes call `transition()`; no fork of transition table |
| 2 | task-engine service | `packages/task-engine/src/task-service.ts:1` (imports `TaskStatus` from `@gram/domain`); `:42` and `:52` hardcode `taskType: 'CODING'` | `TaskService.create` stays the only creator path; ops `task_type` values map onto this column, they do not add a creator |
| 3 | task-engine runner | `packages/task-engine/src/task-runner.ts:1` (`import type { TaskId }`) | Runner orchestration reused as-is; ops executors plug in via ports |
| 4 | task-engine runner ports | `packages/task-engine/src/task-runner-ports.ts:1` (`TaskId, TaskStatus`); `:124` (`transition(taskId, from: TaskStatus, to: TaskStatus)`) | Ops lanes implement against these port types; no parallel port hierarchy |
| 5 | failure classifier | `packages/task-engine/src/failure-classifier.ts:1` (`FailureClass = 'TRANSIENT' \| 'CODE_FAILURE' \| ...`) | Single failure taxonomy; ops lanes map provider errors into it |
| 6 | ApprovalRepository | `packages/persistence/src/repositories/approval-repository.ts:212` (`consume(taskId, operationHash)`); `:223-230` conditional `UPDATE approvals SET status = 'CONSUMED' ... WHERE ... status = 'APPROVED' ...` (`result.changes === 1`, `:230`) | Single-use approval consumption lives here only; approve path `:162-188` and deny path `:190-210` keep their conditional `UPDATE ... WHERE status = 'PENDING'` guards (`:174-176`, `:199`) |
| 7 | approvals migration | `packages/persistence/src/migrations/004_approvals.sql:24-30` (`approvals_new` rebuild, `operation_hash`, status `CHECK`) | Schema history up to 004 is frozen; next ops migration is 005 (see section b) |
| 8 | migrator manifest 1-4 | `packages/persistence/src/migrator.ts:17-22` (`MIGRATIONS` versions 1-4 mapping to `001_initial.sql` through `004_approvals.sql`) | Append-only manifest; ops lanes add entries, never reorder or edit 1-4 |
| 9 | MCP approval tools | `packages/mcp/src/tools/approval-tools.ts:64-65` (`approval_list`), `:72-73` (`approval_approve`), `:80-81` (`approval_deny`); strict zod inputs `:15-19` (`ApprovalListInput`) and `:21-26` (`ApprovalDecisionInput`); `OperationHash` 64-hex refinement `:11-13` | Tool names and strict schemas frozen; ops lanes reuse handlers, they do not register rival approval tools |
| 10 | apps/agent consumption port | `apps/agent/src/main.ts:72-74` (`createApprovalConsumptionPort(...): ApprovalConsumptionPort`) | Runner-side approval check path; ops executors call it, they do not reimplement consume |
| 11 | apps/agent tools port | `apps/agent/src/main.ts:98` (`createApprovalToolsPort(repository): ApprovalToolsPort`); wired `:137-138` (`approvalConsume`, `approvalTools` from one `ApprovalRepository`) | MCP-side approval surface; single repository instance behind both ports |
| 12 | policy-engine operationHash | `packages/policy/src/policy-engine.ts:1` (`createHash`), `:8-22` (`operationHash()` sha256 over shell-normalized preimage), `:29` (decision carries `operationHash`) | Canonical M2 hash producer; ops Intent hash is a different preimage with the same 64-hex shape (see section c), never mixed |
| 13 | TaskStatus | `packages/domain/src/task.ts:6-18` (12-state union); transitions `:28-41`; `canTransitionTaskStatus` `:47` | Canonical lifecycle; ops `ExecutionMode` gates entry to write states, it does not extend the union (see section d) |
| 14 | task_type column | `packages/persistence/src/migrations/001_initial.sql:30` (`task_type TEXT NOT NULL`); `packages/task-engine/src/task-service.ts:42` (`taskType: 'CODING'`) | Column owner is M2; ops `TaskKind` maps onto it (see section d), no second type column |
| 15 | Absence note | `git grep TaskKind\|EffectClass\|ExecutionMode` over M2 `packages/domain/src`, `packages/task-engine/src`, `packages/policy/src` returns empty | Confirmed: no `TaskKind`/`EffectClass`/`Scope` on the M2 domain. Those enums live on the ops lane (`feat/ops-domain-contracts`) and map inward, never outward |

## (b) Next-migration rule

- Manifest `packages/persistence/src/migrator.ts:17-22` ends at version 4 (`004_approvals.sql`).
- The next ops migration is unconditionally `005`.
- Fallback: if M2 advances the manifest past 4 before an ops lane lands, the next ops migration is `MAX(existing manifest versions) + 1`, keeping the manifest append-only and version-unique.
- No lane edits migrations 1-4 or reorders `MIGRATIONS`.

## (c) Hash-preimage mapping (same 64-hex shape, different preimages)

Both digests are `sha256(...).digest('hex')`: 64 lowercase hex chars. They are NOT interchangeable: each hash is only valid against its own preimage and its own producer/consumer pair.

| Hash | Producer (verified) | Preimage fields | Consumer (verified) | Must NOT |
|------|---------------------|-----------------|---------------------|----------|
| M2 policy-engine hash | `packages/policy/src/policy-engine.ts:8-22` | Shell-normalized operation + policy context: `taskId, protectedBranches, directMainGranted, targetBranch, publishMode, type, executable, args, canonicalTargets` (from `NormalizedOperation`, `packages/policy/src/command-parser.ts:6-16`; `normalizeShellCommand`, `:185`; `canonicalTargets` via `canonicalizeTargets`, `:169-182`) | `ApprovalRepository`: `request` (`:95-146`), `approve(id, expectedOperationHash)` (`:162-188`), `deny` (`:190-210`), `consume(taskId, operationHash)` (`:212-234`); MCP decision input `OperationHash` refinement (`packages/mcp/src/tools/approval-tools.ts:11-13`) | Never feed an ops Intent into this hash; never validate an ops receipt against it |
| Ops Intent hash | `packages/domain/src/operations.ts:259-265` (`operationHash()`: ordered `identityFields` JSON, sha256 hex); identity fields `:81-94` | Ops Intent identity: `taskId, operationId, canonicalAction, storeId, accountId, targetResource, parameterDigest, effectClass, expectedState, expectedVersion, providerId, recipeId` (`OperationIntent`, `:37-50`; parsed `:207-224`) | Ops `EffectReceipt.operationHash` (`:52-59`, parsed `:226-237`); approval identity bound through `approvals` rows via `ApprovalRepository`: `request` (`:95-146`), `approve(id, expectedOperationHash)` (`:162-188`), `deny` (`:190-210`), `consume(taskId, operationHash)` (`:212-234`) using the SAME ops Intent hash value throughout (opaque TEXT `operation_hash`; single-use + expiry enforced on it) | Never mix with the M2 policy-engine hash; M2 shell effects keep using the M2 policy-engine hash |

Bridging rule: the ops Intent hash IS the approval identity bound through `approvals` rows (opaque TEXT `operation_hash`; `request`/`approve`/`consume` use the SAME value; single-use + expiry enforced on it). If an ops flow needs an M2-gated shell effect, it evaluates through `PolicyEngine.evaluate` (`packages/policy/src/policy-engine.ts:24-31`) and uses the returned M2 `operationHash` for that M2 shell approval. The two hashes are never mixed.

## (d) Status/Kind mapping

### d1. TaskStatus (M2, canonical) vs ExecutionMode (ops gate)

M2 union: `packages/domain/src/task.ts:6-18` (`QUEUED, WAITING_REPO_LOCK, PREPARING, RUNNING, VERIFYING, PUBLISHING, NEEDS_APPROVAL, NEEDS_RECOVERY, COMPLETED, FAILED, INTERRUPTED, CANCELLED`).

Ops enum: `packages/domain/src/operations.ts:8` (`ExecutionMode = 'FIXTURE' | 'READ_ONLY' | 'WRITE_APPROVED'`; allowed list `:76`).

| ExecutionMode | Meaning for M2 TaskStatus flow | Write-state entry condition |
|---------------|-------------------------------|-----------------------------|
| `FIXTURE` | Test/seed path only; never advances a real task past `PREPARING` | No approval path; fixtures bypass nothing |
| `READ_ONLY` | May run `QUEUED` through `VERIFYING`; must not enter `PUBLISHING` with write effects | `EffectClass` must be `READ` (`operations.ts:10`, allowed `:77`) |
| `WRITE_APPROVED` | Only mode that may enter write-bearing `PUBLISHING`/`NEEDS_APPROVAL` resolution | Requires a consumed M2 approval (`ApprovalRepository.consume`, `approval-repository.ts:212-234`, `changes === 1`) |

No lane adds a 13th `TaskStatus`. `ExecutionMode` is input metadata (`OperationMetadata`, `operations.ts:61-65`), not lifecycle state.

### d2. task_type (M2 column) vs TaskKind (ops label)

M2 column: `001_initial.sql:30`; M2 writes only `'CODING'` (`task-service.ts:42,52`).

Ops enum: `operations.ts:6` (`TaskKind = 'QUERY' | 'COMMAND' | 'WORKFLOW'`; allowed `:75`); carried as `CreateOperationInput.taskKind` (`:20-35`) and `OperationMetadata.taskKind` (`:61-65`).

| TaskKind (ops) | task_type (M2 row) | Notes |
|----------------|--------------------|-------|
| `QUERY` | `CODING` (existing value; no new column value until a 005+ migration lands) | Read-dominant ops work; pairs with `ExecutionMode READ_ONLY` / `EffectClass READ` |
| `COMMAND` | `CODING` | Single write effect; pairs with `WRITE_APPROVED` + consumed approval |
| `WORKFLOW` | `CODING` | Multi-step ops plan; each write step consumes its own approval (single-use preserved) |

If a lane needs distinct persisted kinds, that is a `005+` migration decision under the section-(b) rule, owned by the persistence lane, not a silent second column.

## (e) Single-writer rule (M2 lineage owns; ops lanes consume)

| Owned surface | M2 lineage owner | Ops-lane posture |
|---------------|------------------|------------------|
| task engine (`state-machine`, `task-service`, `task-runner`, `task-runner-ports`, `failure-classifier`) | M2 lineage (`origin/feat/m2-vertical-slice`): `packages/task-engine/src/state-machine.ts:1`, `task-service.ts:1`, `task-runner.ts:1`, `task-runner-ports.ts:1,124`, `failure-classifier.ts:1` | Additive consumers: implement ports, map errors into `FailureClass`; no engine forks |
| ApprovalRepository + approvals schema (`004_approvals.sql`, conditional `UPDATE` consume) | M2 lineage: `approval-repository.ts:212-234`, `004_approvals.sql:24-30` | Call `request`/`approve`/`deny`/`consume`; never write `approvals` rows directly, never duplicate single-use logic |
| migrator manifest + migration history 1-4 | M2 lineage: `migrator.ts:17-22` | Append-only additions per section (b); never edit 1-4 |
| MCP approval tools (`approval_list`/`approval_approve`/`approval_deny`, strict zod) | M2 lineage: `approval-tools.ts:11-26,64-88`; agent wiring `apps/agent/src/main.ts:72-74,98,137-138` | Reuse handlers/ports; no rival approval tool names, no loosened schemas |

Violation test: any ops diff that copies `consume`'s conditional `UPDATE`, redefines `MIGRATIONS`, re-registers `approval_*` tools, or adds a `TaskStatus` is a rewrite, not a convergence, and must be re-cut as a consumer.

## (f) Per-lane rebase-vs-reapply table

Base for new work: `origin/main` (`b17f2ba`). M2 reference: `origin/feat/m2-vertical-slice` (`efa4acc`).

| Lane branch | Head (at note time) | Disposition | Instruction |
|-------------|---------------------|-------------|-------------|
| `feat/ops-domain-contracts` | `a9a2afc` | REAPPLY (additive) | Keep `operations.ts` (`TaskKind `:6, `ExecutionMode` `:8, `EffectClass` `:10, `Scope` `:12, `operationHash` `:259-265`) as pure additions; rebase onto main, then re-cut any edit that touches `packages/domain/src/task.ts` as a mapping table instead |
| `feat/ops-policy-approval` | `003001c` | REAPPLY (consumer) | Consume `PolicyEngine.evaluate` (`policy-engine.ts:24-31`) and `ApprovalRepository` (`:212-234`); rebase; delete any copied hash or consume logic on conflict |
| `feat/ops-persistence` | `6a247a6` | REBASE, then 005 if needed | Rebase onto main; if a schema need survives, add `005_*.sql` + manifest entry per section (b); never touch 1-4 |
| `feat/ops-exec-core` | `fe24c94` | REBASE | Rebase onto main; executor stays behind `task-runner-ports.ts:124` and consumption port (`main.ts:72-74`) |
| `feat/ops-broker` | `6482b15` | REBASE | Rebase onto main; broker routes, it does not own engine/approval/migrator/tools |
| `feat/ops-session` | `695fb95` | REBASE | Rebase onto main; session state maps to `TaskStatus` (`task.ts:6-18`), never extends it |
| `feat/ops-runner` | `d452579` | REBASE | Rebase onto main; runner deltas re-expressed as port implementations |
| `feat/shopify-adapter` | `34a53a3` | REBASE | Rebase onto main; adapter submits ops Intents (`operations.ts:37-50,67-69`), M2-gated effects go through section-(c) bridging |
| `feat/haar-workflows` | `04d51ff` | REBASE | Rebase onto main; workflows compose `COMMAND`/`WORKFLOW` kinds per section (d2) |
| `feat/ops-integration` | `5426900` | REAPPLY (wiring only) | Rebase onto main; keep only consumer wiring (`main.ts:137-138` pattern); drop any owned-engine/config duplication |
| `feat/ops-native-channel` | `0ffb66f` | REBASE | Rebase onto main; channel transports receipts (`operations.ts:52-59`), never mints M2 hashes |
| `fix/mac02-local-control` | `7f9aadc` | REBASE | Rebase onto main; narrow fix, no convergence surface |
| `fix/mac02-apply-transaction` | `d748895` | REBASE | Rebase onto main; narrow fix, no convergence surface |
| `feat/mac02-release-packaging` | `ab56d5c` | REBASE | Rebase onto main; packaging only, no engine/approval ownership |
| `fix/mac02-rollback-target` | `16a3414` | REBASE | Rebase onto main; narrow fix, no convergence surface |
| `fix/mac02-install-data-contracts` | `176922a` | REBASE | Rebase onto main; data-contract fix stays lane-local |

Rebase procedure per lane: `git fetch origin`, `git rebase origin/main`, resolve by keeping M2-owned files (`task-engine/*`, `approval-repository.ts`, `migrator.ts`, `001-004*.sql`, `approval-tools.ts`, `policy-engine.ts`, `domain/task.ts`) at their main/M2 state and re-applying lane content as consumers per sections (a)-(e). Reapply lanes do the same rebase, then split owned-file edits out before review.
