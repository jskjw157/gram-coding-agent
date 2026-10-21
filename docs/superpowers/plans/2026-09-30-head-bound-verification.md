# Head-bound verification implementation plan

> For agentic workers: use superpowers:executing-plans task-by-task with TDD and independent whole-branch review.

**Goal:** Complete #158 using persisted task/HEAD/snapshot/diff-review evidence.
**Architecture:** Keep the existing orchestration, add sealed evidence to plan_json and a policy-gated snapshot adapter; verify committed contents before push.
**Tech Stack:** Node 24, pnpm 10.34.5, TypeScript, SQLite, Vitest, Git.
**Spec:** docs/superpowers/specs/2026-09-30-head-bound-verification-design.md

## Global constraints
No #151/#159/Mac changes, no policy widening or credential transfer. No new dependencies or old migration edits. Preserve remote-confirmation/lock ordering. Cloud/Linux verification only; Windows/WSL live tests excluded. Parent coordinates all remote publication.

## Review focus
- Same HEAD but different dirty bytes/modes: refuse publication
- Passed checks from another task/plan: never inherit authorization
- Deleted/renamed/untracked paths: preserve intended content and exclude unapproved changes
- Hooks changing a committed file or adding another path: refuse push and retain recovery state
- Crash/drift between verification and evidence sealing: never make incomplete proof publishable

### Task 1: Persist coherent evidence
Files: packages/persistence/src/repositories/verification-repository.ts; packages/verification/src/completion-evaluator.ts; new bound-evidence tests.
Interfaces: VerificationSnapshot {version:1,taskId,headSha,entries:{path,mode:'000000'|'100644'|'100755',oid:string|null}[]}; BoundVerificationPlan {id,taskId,headSha,snapshot,approvedPaths,checks}. Repository getBoundPlan(taskId,headSha,planId?) and sealSnapshot(planId,snapshot), finishCheck(...,approvedPaths?). Exact-HEAD listForTask(taskId,headSha?) preserves task-only compatibility.
- [x] Add RED tests for wrong HEAD, no matching plan, missing snapshot, forged reserved metadata, missing review, cross-task command evidence and stale plan selection.
- [x] Run targeted verification tests and observe failure.
- [x] Implement atomic evidence recording and strict bound decoding; require a passed required diff-review with explicit paths and all required checks carrying evidence.
- [x] Run target tests + typecheck; commit.

### Task 2: Capture stable workspace and committed content
Files: apps/agent/src/verification-snapshot.ts and tests; command-adapters.ts and tests.
Interfaces: TaskVerificationSnapshots({runner,workspaces}).capture(taskId):Promise<VerificationSnapshot>; assertCommitted(taskId,snapshot,approvedPaths,sha):Promise<void>. PolicyGitAdapter.headSha(worktree,taskId).
- [x] Add RED real temporary-Git tests for binary bytes, mode/deletion/rename changes, path/symlink rejection, task attribution, changed commit/extra file/wrong parent rejection.
- [x] Observe RED, implement fixed policy-gated status/HEAD/diff/show calls and byte-safe hashing. Do not add policy allow rules.
- [x] Run target tests + typecheck; commit.

### Task 3: Seal actual verification results
Files: packages/verification/src/verification-runner.ts, evidence-collector.ts and tests.
Interfaces: runner optional snapshots.capture(taskId); evidence optional sealSnapshot(planId,snapshot); recordNonCommandResult adds approvedPaths for actual passed diff-review; PersistedVerificationPlan carries headSha.
- [x] Add RED for real diff-review paths flowing into evidence; mismatching task/HEAD/snapshot; failures/crashes must not seal; capture before and after all required checks.
- [x] Observe RED, implement using Task 1 snapshot type and repository sealing. Preserve legacy unsealed diagnostic behavior.
- [x] Run verification suite; commit.

### Task 4: Wire production publication
Files: persistence-adapters.ts, task-runner-composition.ts, main.ts, task-engine port types, publishing-service.ts and tests.
Interfaces: composition verification.getVerifiedPlan(taskId,headSha) returns the Task 1 bound plan or undefined; verification result/publish context carries plan evidence; publishing verification.assertCommitted?(taskId,sha).
- [x] Add RED for production adapter exact HEAD and plan, missing snapshot/review failure, same-HEAD drift, commit callback before push, concurrent task attribution.
- [x] Observe RED, thread taskId through HEAD, use coherent bound plan and mandatory production snapshot checks. No task-only production fallback; no new shared state.
- [x] Run full root tests and quality checks; commit.

### Task 5: Integration and independent review
Files: tests/e2e/vertical-slice.test.ts after #157 integration, plus production adapter regression tests.
- [x] Refresh parent-approved M2 integration baseline only after #156/#157 coordination; do not duplicate their code/publication.
- [x] Replace test-only HEAD/path readers with production adapters and real persisted evidence. Keep external capabilities deterministic until #159.
- [x] Run frozen install, lint, typecheck, unit, E2E and build. Read results; no native acceptance claims.
- [x] Independent fresh reviewer examines whole branch, snapshot races/content binding and evidence ownership; fix important findings with RED->GREEN.
- [ ] Publish tested tree through the supported connected GitHub API only after parent coordination; verify draft PR exact-head CI/reviews/gates, merge to M2 without bypass, and verify postmerge CI.
