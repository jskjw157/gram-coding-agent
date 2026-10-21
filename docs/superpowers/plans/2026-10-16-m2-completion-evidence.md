# M2 Completion Evidence Implementation Plan

**Status:** Active; implementation and live evidence are pending
**Design:** `docs/superpowers/specs/2026-10-16-m2-completion-evidence-design.md`

## Goal

Repair external-review changed-path metadata, add independent provider-boundary Repo Lock evidence, prove both with regression tests and a new Windows 11/WSL2 disposable-repository smoke, and produce acceptance and release-readiness reports without merging or releasing.

## Constraints

- Preserve TASK-000005 and every failed Task/worktree/SQLite record.
- Use TDD for production behavior changes.
- Keep `packages/github` free of `@gram/repo-lock` dependencies.
- Do not add a global CI lock-absence gate.
- Do not fabricate historical observations.
- Do not skip failing tests or weaken required checks.
- Do not merge main, create a release/tag, weaken branch protection, or integrate M3/M4/M5 drafts.
- Public smoke evidence is functional evidence only; Private acceptance remains a formal blocker without an approved exception.

## Task 1: Freeze the baseline and integration boundaries

**Evidence to capture:**

- [ ] Record current branch, working-tree status, base SHA, and remote PR heads for #135 and #196.
- [ ] Confirm expected M2 heads `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` and `db44c08881ce07d5b2c05000f3d93b36999a32ae` against GitHub.
- [ ] Identify changed files in active M3/M4/M5 draft PRs and establish no-overwrite boundaries.
- [ ] Preserve a read-only TASK-000005 evidence snapshot and checksum under the diagnostics area.
- [ ] Record that TASK-000005 lacks independent provider-boundary lock samples; do not create them retrospectively.

## Task 2: Repair PR changed-path evidence with TDD

**Primary files:**

- `packages/persistence/src/repositories/pull-request-evidence-repository.ts`
- `packages/persistence/src/repositories/pull-request-evidence-repository.test.ts`
- relevant migration/review repository files only if the existing schema cannot express an exact join

**RED cases:**

- [ ] Accepted `external-review:` evidence for the same Task, latest plan, exact HEAD, and exact review ID returns approved paths.
- [ ] Existing `diff-review:` evidence remains compatible.
- [ ] A different Task, older plan, different HEAD, rejected/pending review, wrong review ID, malformed evidence, or unapproved path contributes no path.
- [ ] Duplicate and unsafe/path-manipulation values are rejected or normalized without leaking secret-like evidence content.
- [ ] PR metadata renders the actual changed file instead of `None recorded`.

**Implementation and verification:**

- [ ] Implement the smallest exact relational lookup.
- [ ] Run the targeted persistence and GitHub metadata tests to GREEN.
- [ ] Run package typecheck/lint for affected packages.
- [ ] Obtain an independent code review and repair all valid findings.

## Task 3: Add the smoke-only provider-boundary observer with TDD

**Primary files:**

- `apps/agent/src/smoke-lock-observer.ts`
- `apps/agent/src/smoke-lock-observer.test.ts`
- `apps/agent/src/github-services.ts`
- `apps/agent/src/github-services.test.ts`
- `apps/agent/src/task-runner-composition.ts`
- `apps/agent/src/task-runner-composition.test.ts`
- `apps/agent/src/main.ts`
- `apps/agent/src/main.test.ts`

**RED cases for observation storage:**

- [ ] Dedicated production-state reader is truly read-only and sees WAL updates.
- [ ] Exact SQLite row absence/presence and exact lock-file absence/presence are recorded.
- [ ] Symlink, non-regular file, permission failure, and unavailable database fail measurement closed for the scoped smoke. BEFORE failure prevents provider I/O; AFTER failure preserves the earlier record and reports that remote effects may already exist.
- [ ] Regular-file contents are never read. Malformed contents and DB/file presence disagreement cannot be reported as absence; measured presence remains evidence that rejects smoke acceptance, without adding a runtime lock-presence policy.
- [ ] Lease token and file contents never appear in the evidence journal or thrown errors.
- [ ] Restart appends new samples; existing samples are byte-for-byte unchanged.
- [ ] An unrelated repository bypasses the observer.
- [ ] A valid lock presence is recorded and later rejects smoke acceptance without creating a global CI policy.

**RED cases for actual provider boundaries:**

- [ ] PR lookup and PR create each receive BEFORE/AFTER samples.
- [ ] CI rulesets, legacy statuses, required-check protection, and every check-runs page each receive BEFORE/AFTER samples.
- [ ] HTTP and transport failures preserve BEFORE and add a sanitized AFTER failure.
- [ ] Pagination with 100 results proves page 1 and page 2 are separately sampled.
- [ ] The wrapper records no authorization header, token, request/response body, or raw URL.

**Correlation cases:**

- [ ] PR samples bind Task/repo/published HEAD before an internal PR ID exists.
- [ ] After persistence, a separate binding row links the correlation to an exact validated internal PR row/provider number.
- [ ] CI samples directly bind Task/repo/HEAD/internal PR row.
- [ ] Wrong Task/repo/branch/provider number prevents binding and does not rewrite old evidence.

**Implementation and verification:**

- [ ] Carry published HEAD into the application PR composition context.
- [ ] Build per-operation GitHub clients with a context-bound fetch wrapper only when the trusted smoke repository setting matches.
- [ ] Open the state DB through a dedicated read-only connection and write to a separate owner-only append journal.
- [ ] Leave the observer absent by default and preserve current normal runtime behavior.
- [ ] Retain the existing `CI_OBSERVATION_STARTED` audit as logical-poll evidence; do not relabel it as HTTP-boundary evidence.
- [ ] Run targeted agent/GitHub tests to GREEN.
- [ ] Run the package boundary test proving `@gram/github` still has no Repo Lock dependency.
- [ ] Obtain an independent security/architecture review and repair all valid findings.

## Task 4: Extend deterministic E2E coverage

- [ ] Update the vertical-slice fixture to assert changed paths from external-review evidence.
- [ ] Assert remote SHA confirmation precedes lock release.
- [ ] Assert PR creation occurs after release.
- [ ] Assert every fake-provider request has matching append-only lock samples and both lock representations are absent.
- [ ] Assert CI completes only after the exact required check succeeds.
- [ ] Assert retry/restart/new HEAD appends evidence without overwriting the first sample.
- [ ] Assert a same-repo reacquisition is recorded as a smoke failure but does not alter global CI behavior.

Run:

```bash
pnpm --filter @gram/persistence test
pnpm --filter @gram/github test
pnpm --filter @gram/agent test
pnpm test:e2e
```

## Task 5: Run the full repository gates

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e`
- [ ] `pnpm build`
- [ ] Confirm root test collection includes every new test; otherwise record and connect the missing suite.
- [ ] Keep M5 #208 security RED results separate; do not present them as passing M2 security evidence.

Any failure returns to diagnosis, repair, targeted verification, and then the full gate. No failing test may be skipped or weakened.

## Task 6: Publish the code changes for review

- [ ] Review the diff for scope, secrets, generated files, and overlap with other draft PRs.
- [ ] Commit only intended files on the independent M2 completion branch.
- [ ] Push the branch normally and confirm the remote SHA.
- [ ] Open a Draft PR describing both evidence gaps, the exact before/after behavior, and validation commands.
- [ ] Wait for GitHub CI and repair failures on the same branch.
- [ ] Record Draft PR URL, HEAD SHA, workflow run IDs, and conclusions.

## Task 7: Prepare a fresh disposable smoke repository

- [ ] Use a new disposable repository; never reuse a failed or completed smoke repository as the new acceptance target.
- [ ] Configure the correct Node 24 fixture, deterministic intentional bug, lint/test/build commands, Git identity, Actions `verify`, and Classic Branch Protection.
- [ ] Confirm base checkout clean, local HEAD equals `origin/main`, required `verify` is GitHub Actions-backed, and no Ruleset bypass exists.
- [ ] Register the repository through the production repository service.
- [ ] Configure the smoke observer through trusted local service configuration for this exact repository ID.
- [ ] Confirm agent build SHA equals the reviewed candidate, agent/tunnel are healthy, Node/npm are resolvable, and Repo Lock count is zero before creating a Task.
- [ ] Record Public visibility as a deviation from the approved Private requirement when GitHub Free cannot provide the required Private protection combination.

## Task 8: Execute one live Windows 11/WSL2 smoke

Submit exactly one Task through the normal authenticated MCP path and do not manually edit its worktree, database, lock, PR, or CI result.

Expected sequence:

```text
task_create -> resolve -> lock -> worktree -> instructions -> analyze -> modify
-> verify -> commit -> push -> remote confirm -> lock release
-> PR -> required CI -> COMPLETED
```

Collect:

- [ ] Task UUID/display ID, repository ID, agent candidate SHA, worktree, and branch.
- [ ] Verification plan/HEAD and persistent evidence for every required PASS.
- [ ] Commit SHA, remote branch SHA, `remote_confirmed_at`, and release audit time.
- [ ] PR provider number, internal row ID, URL, created time, exact one-file diff, and rendered changed path.
- [ ] First logical `CI_OBSERVATION_STARTED` audit and all provider-boundary samples.
- [ ] BEFORE/AFTER absence of both SQLite row and filesystem lock for PR and every CI provider request.
- [ ] Required check/run IDs, exact HEAD, start/completion times, URLs, and success conclusion.
- [ ] Final `COMPLETED` status and zero active lock rows/files.
- [ ] Independent GitHub API/read-only SQLite confirmation without exposing credentials.

If the run fails, preserve the Task, worktree, database evidence, and lock state. Diagnose and follow the safe recovery procedure; never mark PASS manually or reuse the failed repository for the final smoke.

## Task 9: Validate integration of #135 and #196

- [ ] Fetch current remote heads and base branches for Draft PR #135 and PR #196.
- [ ] Reproduce the intended integration in an isolated branch/worktree without merging main.
- [ ] Resolve only conflicts inside M2-owned files; do not absorb M3/M4/M5 work.
- [ ] Run targeted tests, full gates, and GitHub CI on the exact integrated candidate.
- [ ] Record the validated integration order, component SHAs, resulting candidate SHA, conflicts, and any remaining review requirement.
- [ ] Do not merge either PR under this plan.

## Task 10: Produce final reports and status

Create or update:

- [ ] M2 Acceptance Report preserving TASK-000005 and separating its historical evidence gap from the new smoke.
- [ ] Windows/WSL2 Live Smoke Evidence Report.
- [ ] Release Readiness Report with code PRs, candidate SHA, GitHub CI, timeline, provider-boundary lock evidence, integration plan, and security findings.

The report must choose exactly one status:

- `M2_RELEASE_READY` only after all technical gates and the official Private requirement or an approved exception are satisfied.
- `PUBLIC_FUNCTIONAL_PASS_FORMAL_GATE_BLOCKED` when the Public smoke passes but the Private requirement remains unmet.
- `BLOCKED_WITH_EVIDENCE` when a technical, security, permission, or external dependency prevents completion after all safe work is exhausted.

Main merge, tag creation, release publication, deployment, acceptance-criteria waiver, paid-plan change, token scope expansion, and M3/M4/M5 integration remain explicit user decisions.
