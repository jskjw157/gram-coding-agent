# M3 Reliability & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active coding tasks recover safely across agent/WSL restarts, classify failures and retry only transient work, preserve ambiguous worktrees, and harden same-repo serialization under crashes and concurrency.

**Architecture:** Recovery is coordinated by `TaskRecoveryCoordinator` before normal scheduling. Durable state in SQLite is reconciled with filesystem locks, process metadata, worktrees, Git state, and the current boot ID. Janitor cleanup runs separately and is forbidden from deleting dirty, unpushed, approval-blocked, or recovery-blocked workspaces.

**Tech Stack:** Existing M0–M2 stack, Linux `/proc`, `/proc/sys/kernel/random/boot_id`, systemd lifecycle, Git, SQLite, Vitest integration tests.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Global Constraints

- Boot recovery runs before normal queued tasks.
- A repository with unresolved interrupted ownership is recovery-blocked.
- Automatic retries are bounded and only for classified transient failures.
- `NEEDS_RECOVERY` worktrees are never auto-deleted.
- Dirty or unpushed worktrees are never auto-deleted.
- `COMPLETED` clean worktrees retain 24 hours; `FAILED`/`CANCELLED` retain 7 days.
- Repo lock remains released during CI observation.
- Same-repository mutation remains serialized under crash/restart scenarios.

---

## File Map

```text
packages/task-engine/src/
├─ task-recovery-coordinator.ts
├─ retry-policy.ts
├─ failure-classifier.ts
└─ *.test.ts
packages/repo-lock/src/
├─ stale-lock-recovery.ts
├─ process-identity.ts
└─ *.test.ts
packages/workspace/src/
├─ workspace-recovery.ts
├─ workspace-janitor.ts
├─ disk-pressure.ts
└─ *.test.ts
packages/observability/src/
└─ recovery-events.ts
tests/concurrency/
├─ different-repos.test.ts
├─ same-repo.test.ts
├─ crash-lock.test.ts
└─ restart-recovery.test.ts
```

---

### Task 1: Persist process and boot identity for lock ownership

**Files:**
- Create: `packages/repo-lock/src/process-identity.ts`
- Test: `packages/repo-lock/src/process-identity.test.ts`
- Modify: `packages/repo-lock/src/repo-lock-service.ts`

**Interfaces:**
- Produces: `ProcessIdentity { pid: number; bootId: string }` and `readCurrentProcessIdentity()`.

- [ ] **Step 1: Write tests with injectable boot-ID reader**

Assert PID and boot ID are both written into a lock; a PID match with a different boot ID is not considered the same owner.

- [ ] **Step 2: Implement boot ID reader**

Read `/proc/sys/kernel/random/boot_id`, trim whitespace, and fail closed if unavailable during mutation lock acquisition.

- [ ] **Step 3: Update lock-file metadata**

Persist task UUID, PID, boot ID, acquisition timestamp, and lease token.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/repo-lock test
git add packages/repo-lock/src/process-identity.ts packages/repo-lock/src/process-identity.test.ts packages/repo-lock/src/repo-lock-service.ts
git commit -m "feat: bind repo locks to process boot identity"
```

---

### Task 2: Implement stale Repo Lock recovery

**Files:**
- Create: `packages/repo-lock/src/stale-lock-recovery.ts`
- Test: `packages/repo-lock/src/stale-lock-recovery.test.ts`

**Interfaces:**
- Produces: `StaleLockRecovery.inspect(repoId): Promise<LockRecoveryAssessment>`.

- [ ] **Step 1: Write assessment matrix tests**

Cover:

```text
fresh lease + live owner             -> ACTIVE
expired lease + same boot/live PID   -> ACTIVE_BUT_HEARTBEAT_LATE
expired lease + dead PID             -> STALE
lock file task != DB owner           -> CONFLICT
old boot ID                          -> STALE_AFTER_REBOOT
```

- [ ] **Step 2: Implement inspection without mutation**

Assessment must not delete lock state. Cleanup/reacquisition happens only through the Recovery Coordinator so the associated Task is reconciled first.

- [ ] **Step 3: Test and commit**

```bash
pnpm --filter @gram/repo-lock test
git add packages/repo-lock/src/stale-lock-recovery.ts packages/repo-lock/src/stale-lock-recovery.test.ts
git commit -m "feat: assess stale repository locks safely"
```

---

### Task 3: Implement workspace recovery assessment

**Files:**
- Create: `packages/workspace/src/workspace-recovery.ts`
- Test: `packages/workspace/src/workspace-recovery.test.ts`

**Interfaces:**
- Produces: `WorkspaceRecovery.inspect(workspace): Promise<WorkspaceRecoveryAssessment>` containing existence, branch, HEAD, dirty state, unpushed commits, index lock presence, and expected-task branch match.

- [ ] **Step 1: Write Git-state recovery tests**

Create temporary repos for:

```text
clean expected branch
clean wrong branch
dirty worktree
unpushed local commit
.git/index.lock present
worktree missing
```

- [ ] **Step 2: Implement read-only assessment through GitService**

Do not auto-reset, clean, or delete anything in assessment.

- [ ] **Step 3: Test and commit**

```bash
pnpm --filter @gram/workspace test
git add packages/workspace/src/workspace-recovery.ts packages/workspace/src/workspace-recovery.test.ts
git commit -m "feat: inspect interrupted task workspaces"
```

---

### Task 4: Implement boot-time Task Recovery Coordinator

**Files:**
- Create: `packages/task-engine/src/task-recovery-coordinator.ts`
- Test: `packages/task-engine/src/task-recovery-coordinator.test.ts`
- Modify: `apps/agent/src/main.ts`

**Interfaces:**
- Produces: `TaskRecoveryCoordinator.recoverBeforeScheduling(): Promise<RecoverySummary>`.

- [ ] **Step 1: Write recovery-decision tests**

Examples:

```text
RUNNING + worktree healthy + stale old-boot lock -> reacquire and resume next safe step
VERIFYING + last command finished PASS -> resume after that check
PUBLISHING + remote SHA already confirmed -> release stale lock if needed and continue PR phase
RUNNING + missing worktree -> NEEDS_RECOVERY
RUNNING + wrong branch -> NEEDS_RECOVERY
RUNNING + conflicting lock owner -> NEEDS_RECOVERY and repo blocked
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/task-engine test
```

- [ ] **Step 3: Implement recovery before scheduler startup**

Application boot order:

```text
open DB
start logger
run recovery coordinator
start task scheduler
start MCP accepting mutating work
```

Health may report `recovering` until the coordinator finishes.

- [ ] **Step 4: Persist recovery events**

Emit `TASK_RECOVERY_STARTED`, `TASK_RESUMED`, `TASK_NEEDS_RECOVERY`, `STALE_LOCK_RECLAIMED`, and `REPO_RECOVERY_BLOCKED` audit events.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/task-engine test
pnpm --filter @gram/agent test
git add packages/task-engine/src/task-recovery-coordinator.ts packages/task-engine/src/task-recovery-coordinator.test.ts apps/agent/src/main.ts
git commit -m "feat: recover interrupted tasks before scheduling"
```

---

### Task 5: Implement failure classification and bounded retry policy

**Files:**
- Modify: `packages/task-engine/src/failure-classifier.ts`
- Create: `packages/task-engine/src/retry-policy.ts`
- Test: `packages/task-engine/src/retry-policy.test.ts`

**Interfaces:**
- Produces:
  - `FailureClass = TRANSIENT | CODE_FAILURE | ENVIRONMENT_FAILURE | POLICY_BLOCK | EXTERNAL_FAILURE | UNKNOWN`
  - `RetryPolicy.next(failure, priorAttempts): RetryDecision`.

- [ ] **Step 1: Write classification tests**

Examples:

```text
GitHub 502/503/504 or connection reset -> TRANSIENT
registry timeout                        -> TRANSIENT
tsc compile error                       -> CODE_FAILURE
unit-test assertion                     -> CODE_FAILURE
ENOENT tool missing                     -> ENVIRONMENT_FAILURE
NEEDS_APPROVAL/DENY                      -> POLICY_BLOCK
CI check failure                         -> EXTERNAL_FAILURE
```

- [ ] **Step 2: Write retry-budget tests**

Transient default:

```text
attempt 1 -> retry after 1s
attempt 2 -> retry after 3s
attempt 3 -> retry after 10s
attempt 4 -> stop
```

CODE_FAILURE must never blindly rerun the same command as its remediation.

- [ ] **Step 3: Implement deterministic retry decisions**

Return `{ shouldRetry, delayMs, reason }`; scheduler performs the delay rather than sleeping inside DB transactions or service methods.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/task-engine test
git add packages/task-engine/src/failure-classifier.ts packages/task-engine/src/retry-policy.ts packages/task-engine/src/retry-policy.test.ts
git commit -m "feat: classify failures and bound automatic retries"
```

---

### Task 6: Implement resumable Step execution

**Files:**
- Modify: `packages/task-engine/src/task-runner.ts`
- Create: `packages/task-engine/src/step-runner.ts`
- Test: `packages/task-engine/src/step-runner.test.ts`

**Interfaces:**
- Produces: `StepRunner.runOrResume(stepDefinition, persistedStep): Promise<StepOutcome>`.

- [ ] **Step 1: Write idempotency tests for recoverable steps**

Examples:

```text
worktree already exists with expected branch -> reuse
PR already exists -> reuse
remote SHA already confirmed -> do not repush solely for recovery
verification PASS evidence exists for unchanged HEAD -> reuse
```

- [ ] **Step 2: Write unsafe-resume tests**

Examples requiring `NEEDS_RECOVERY`:

```text
step marked RUNNING but worktree HEAD differs unexpectedly
command outcome unknown and operation was non-idempotent
approval hash no longer matches pending operation
```

- [ ] **Step 3: Implement resume tokens based on durable outputs**

Do not resume solely by integer step number. Validate actual durable artifacts (branch, SHA, PR, verification evidence) before skipping completed work.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/task-engine test
git add packages/task-engine/src/task-runner.ts packages/task-engine/src/step-runner.ts packages/task-engine/src/step-runner.test.ts
git commit -m "feat: resume tasks from durable step evidence"
```

---

### Task 7: Implement Workspace Janitor and retention rules

**Files:**
- Create: `packages/workspace/src/workspace-janitor.ts`
- Create: `packages/workspace/src/disk-pressure.ts`
- Test: `packages/workspace/src/workspace-janitor.test.ts`
- Modify: `apps/agent/src/main.ts`

**Interfaces:**
- Produces: `WorkspaceJanitor.run(now): Promise<JanitorSummary>`.

- [ ] **Step 1: Write retention matrix tests**

```text
COMPLETED clean age 23h     -> retain
COMPLETED clean age 25h     -> eligible
FAILED clean age 6d         -> retain
FAILED clean age 8d         -> eligible
CANCELLED dirty age 30d     -> PROTECTED
NEEDS_APPROVAL any age      -> PROTECTED
NEEDS_RECOVERY any age      -> PROTECTED
unpushed commit any status  -> PROTECTED
```

- [ ] **Step 2: Write disk pressure tests**

At 79% no early cleanup. At 80–89% cleanup oldest eligible completed worktrees. At >=90% cleanup all eligible completed worktrees and safe caches, never protected worktrees.

- [ ] **Step 3: Implement cleanup with revalidation immediately before removal**

Re-run `git status`, unpushed-commit check, and task state check immediately before `git worktree remove`; never trust only stale DB flags.

- [ ] **Step 4: Schedule janitor independently**

Run periodically (e.g. every 30 minutes) from application background services. It must not hold a repository mutation lock merely to inspect; actual `git worktree remove` must coordinate with workspace activity so an active task is never removed.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/workspace test
git add packages/workspace/src/workspace-janitor.ts packages/workspace/src/disk-pressure.ts packages/workspace/src/workspace-janitor.test.ts apps/agent/src/main.ts
git commit -m "feat: clean task worktrees with retention safeguards"
```

---

### Task 8: Add crash and concurrency integration tests

**Files:**
- Create: `tests/concurrency/different-repos.test.ts`
- Create: `tests/concurrency/same-repo.test.ts`
- Create: `tests/concurrency/crash-lock.test.ts`
- Create: `tests/concurrency/restart-recovery.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: acceptance tests for M3 invariants.

- [ ] **Step 1: Prove different repositories run concurrently**

Use barriers in two fake mutation tasks and assert both enter RUNNING simultaneously when repo IDs differ.

- [ ] **Step 2: Prove same repository serializes**

Start two tasks for one repo; assert second remains `WAITING_REPO_LOCK` until first remote-push lock release.

- [ ] **Step 3: Simulate process death while lock is held**

Persist active task + lease, terminate worker without releasing, construct new boot/process identity, run recovery, and assert safe stale-lock reconciliation.

- [ ] **Step 4: Simulate restart after confirmed push but before PR creation**

Assert recovery does not reacquire the mutation lock merely to create/reuse the PR and observe CI.

- [ ] **Step 5: Run integration suite**

```bash
pnpm test:concurrency
pnpm test:e2e
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/concurrency package.json
git commit -m "test: harden task recovery and concurrency"
```

---

### Task 9: Expose Task control, approval, cancel, resume, and retry MCP tools

**Files:**
- Modify: `packages/task-engine/src/task-service.ts`
- Modify: `packages/task-engine/src/task-runner.ts`
- Modify: `packages/mcp/src/tools/task-tools.ts`
- Test: `packages/mcp/src/tools/task-control.test.ts`

**Interfaces:**
- Produces:
  - `task_cancel({ taskId, mode: 'SAFE' | 'CLEANUP' })`
  - `task_resume({ taskId })`
  - `task_retry({ taskId })`
  - `task_approve({ taskId, approvalId, operationHash })`

- [ ] **Step 1: Write safe-cancel tests**

For an active task, `SAFE` stops the task-owned active process, transitions the task to `CANCELLED`, and preserves worktree, logs, dirty changes, and unpushed commits.

- [ ] **Step 2: Write cleanup-cancel tests**

`CLEANUP` may remove only a clean, safe local worktree/temporary files after revalidation. It must refuse cleanup when the worktree is dirty, contains unpushed commits, is `NEEDS_RECOVERY`, or would delete a remote branch/PR without a separately authorized operation.

- [ ] **Step 3: Write resume/retry tests**

`task_resume` is valid for `INTERRUPTED`, `NEEDS_APPROVAL` after approval consumption, and explicitly recoverable paused states; it delegates to durable Step recovery. `task_retry` applies the RetryPolicy and must reject blind retry for CODE_FAILURE when no remediation/new input exists.

- [ ] **Step 4: Write approval-hash test**

`task_approve` succeeds only when `approvalId`, `taskId`, and recomputed `operationHash` match the pending approval. Any mismatch fails without consuming the approval.

- [ ] **Step 5: Register strict MCP schemas and implement services**

MCP handlers contain no cancellation/recovery logic; they delegate to TaskService/ApprovalService.

- [ ] **Step 6: Test and commit**

```bash
pnpm --filter @gram/task-engine test
pnpm --filter @gram/mcp test
git add packages/task-engine packages/mcp/src/tools/task-tools.ts packages/mcp/src/tools/task-control.test.ts
git commit -m "feat: control and resume durable coding tasks"
```

---

### Task 10: M3 acceptance and v0.2.0 release gate

**Files:**
- Create: `docs/operations/m3-recovery-acceptance.md`

- [ ] **Step 1: Run all local and concurrency checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:concurrency
```

- [ ] **Step 2: Perform one WSL restart acceptance run**

Start a disposable task, interrupt the agent during a safe mutation phase, restart WSL/services, and verify the task either resumes from proven durable state or becomes `NEEDS_RECOVERY`; it must never silently start a conflicting same-repo task.

- [ ] **Step 3: Record evidence and commit**

```bash
git add docs/operations/m3-recovery-acceptance.md
git commit -m "docs: record task recovery acceptance"
```

- [ ] **Step 4: Tag after merge**

```bash
git tag -a v0.2.0 -m "Reliable task recovery and concurrency"
git push origin v0.2.0
```
