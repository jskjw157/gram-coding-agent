# M2 First End-to-End Coding Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first real coding vertical slice from `task_create` through repository resolution, exclusive mutation lock, task worktree, scoped code changes, verification, commit/push, confirmed lock release, PR creation, lock-free CI observation, and `COMPLETED`.

**Architecture:** `TaskRunner` orchestrates ports implemented by repository, lock, workspace, filesystem, verification, Git, publishing, and GitHub adapters. The mutation lock is held through confirmed push and released before PR creation or CI observation. CI repair starts a new mutation cycle by reacquiring the lock and reusing the same task worktree.

**Tech Stack:** Existing M0–M1 stack plus Git CLI, GitHub CLI/API adapter, Node child-process APIs, SQLite repositories, Vitest integration fixtures.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Global Constraints

- Canonical Task ID is UUIDv7; display sequence is human-facing only.
- Same-repository mutation is serialized; different repositories may run concurrently.
- Normal task edits occur only in task-specific Git worktrees.
- Default publishing mode is branch → commit → push → PR.
- Direct `main` mode requires an explicit task grant.
- A successful process exit from `git push` is insufficient; remote commit confirmation is required.
- Repository lock releases immediately after remote push confirmation.
- PR creation and CI observation run without the repository lock.
- CI repair must reacquire the repository lock before changing code.
- Required verification evidence must exist before the task becomes verified/completed.
- Browser/dashboard features are not required for this milestone.

---

## File Map

```text
packages/task-engine/src/
├─ task-service.ts
├─ task-runner.ts
├─ state-machine.ts
├─ failure-classifier.ts
└─ *.test.ts
packages/repo-registry/src/
├─ repo-resolver.ts
├─ repo-inspector.ts
├─ repo-profiler.ts
└─ *.test.ts
packages/repo-lock/src/
├─ repo-lock-service.ts
├─ lease-heartbeat.ts
└─ *.test.ts
packages/workspace/src/
├─ worktree-service.ts
├─ workspace-resolver.ts
├─ path-mapper.ts
└─ *.test.ts
packages/filesystem/src/
├─ code-search.ts
├─ file-service.ts
├─ patch-service.ts
├─ diff-service.ts
└─ *.test.ts
packages/shell/src/
├─ command-runner.ts
├─ output-capture.ts
└─ *.test.ts
packages/verification/src/
├─ change-classifier.ts
├─ verification-planner.ts
├─ verification-runner.ts
├─ evidence-collector.ts
├─ completion-evaluator.ts
└─ *.test.ts
packages/git/src/
├─ git-service.ts
├─ branch-service.ts
├─ commit-service.ts
├─ remote-service.ts
└─ *.test.ts
packages/github/src/
├─ github-client.ts
├─ pull-request-service.ts
├─ checks-service.ts
└─ *.test.ts
packages/publishing/src/
├─ publishing-service.ts
└─ publishing-service.test.ts
packages/mcp/src/tools/
├─ task-tools.ts
├─ repo-tools.ts
├─ code-tools.ts
├─ git-tools.ts
├─ verification-tools.ts
└─ github-tools.ts
tests/e2e/
├─ fixtures/
└─ vertical-slice.test.ts
```

---

### Task 1: Implement `task_create` application flow and MCP tool

**Files:**
- Create: `packages/task-engine/package.json`
- Create: `packages/task-engine/src/state-machine.ts`
- Create: `packages/task-engine/src/task-service.ts`
- Test: `packages/task-engine/src/task-service.test.ts`
- Create: `packages/task-engine/src/index.ts`
- Create: `packages/mcp/src/tools/task-tools.ts`
- Modify: `packages/mcp/src/server.ts`

**Interfaces:**
- Consumes: `TaskRepository.create`, domain Task types.
- Produces:
  - `TaskService.create(input: CreateTaskInput): Promise<TaskView>`
  - MCP tool `task_create({ repo, goal, publishMode? })`

- [ ] **Step 1: Write a failing application-service test**

```ts
it('creates a queued task with UUIDv7 identity and display sequence', async () => {
  const task = await service.create({ repo: 'mamf-web', goal: 'Fix Excel download URL', publishMode: 'PULL_REQUEST' });
  expect(task.id).toMatch(/-7[0-9a-f]{3}-/);
  expect(task.displayId).toBe('TASK-000001');
  expect(task.status).toBe('QUEUED');
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @gram/task-engine test
```

- [ ] **Step 3: Implement `TaskService.create`**

Resolve no repository yet; store the user repo selector in task metadata and transition only after the runner starts. `TaskService.create` must emit `TASK_CREATED` audit event without recording secrets.

- [ ] **Step 4: Register `task_create` MCP schema**

Use Zod input:

```ts
const TaskCreateInput = z.object({
  repo: z.string().min(1),
  goal: z.string().min(1),
  publishMode: z.enum(['PULL_REQUEST', 'DIRECT_MAIN']).default('PULL_REQUEST')
});
```

`DIRECT_MAIN` is only a declared request here; Policy/Git publishing checks enforce the grant later.

- [ ] **Step 5: Run package tests and commit**

```bash
pnpm --filter @gram/task-engine test
pnpm --filter @gram/mcp test
git add packages/task-engine packages/mcp
git commit -m "feat: create persistent coding tasks via mcp"
```

---

### Task 2: Implement repository registry resolution and onboarding

**Files:**
- Create: `packages/repo-registry/package.json`
- Create: `packages/repo-registry/src/repo-resolver.ts`
- Create: `packages/repo-registry/src/repo-inspector.ts`
- Create: `packages/repo-registry/src/repo-profiler.ts`
- Test: `packages/repo-registry/src/repo-resolver.test.ts`
- Modify: `packages/persistence/src/repositories/repository-repository.ts`
- Create: `packages/mcp/src/tools/repo-tools.ts`

**Interfaces:**
- Produces:
  - `RepoResolver.resolve(selector: string): Promise<RepositoryProfile>`
  - `RepositoryProfile.githubRepositoryId: number`
  - `RepositoryProfile.defaultBranch: string`
  - `RepositoryProfile.localBasePath: string`

- [ ] **Step 1: Write registry-first resolution tests**

Test that an existing registry row avoids GitHub discovery and that an unknown selector calls the GitHub discovery port exactly once, inspects the repository, and persists the resulting immutable GitHub repository ID.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/repo-registry test
```

- [ ] **Step 3: Implement project profiling**

Detect in priority order:

```text
pnpm-lock.yaml -> pnpm
package-lock.json -> npm
yarn.lock -> yarn
build.gradle / gradlew -> gradle
pom.xml -> maven
pyproject.toml -> python
```

For Node repos, inspect `package.json` scripts and persist existing `lint`, `test`, `build`, and `dev` commands only; do not invent commands absent from the repo.

- [ ] **Step 4: Implement canonical base checkout path**

```ts
const localBasePath = path.join(homeDir, 'workspace', 'github', owner, name);
```

If missing, clone/fetch through the Git service port; registry code must not call the shell directly.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/repo-registry test
git add packages/repo-registry packages/persistence/src/repositories/repository-repository.ts packages/mcp/src/tools/repo-tools.ts
git commit -m "feat: resolve and onboard github repositories"
```

---

### Task 3: Implement exclusive Repo Lock with SQLite lease + filesystem lock

**Files:**
- Create: `packages/repo-lock/package.json`
- Create: `packages/repo-lock/src/repo-lock-service.ts`
- Create: `packages/repo-lock/src/lease-heartbeat.ts`
- Test: `packages/repo-lock/src/repo-lock-service.test.ts`
- Create: `packages/repo-lock/src/index.ts`
- Modify: `packages/persistence/src/repositories/lock-repository.ts`

**Interfaces:**
- Produces:
  - `RepoLockService.acquire(repoId, taskId): Promise<RepoLockLease>`
  - `RepoLockLease.heartbeat(): Promise<void>`
  - `RepoLockLease.release(): Promise<void>`
- Defaults: TTL 60s; heartbeat interval 15s.

- [ ] **Step 1: Write same-repo exclusion and different-repo concurrency tests**

```ts
const first = await locks.acquire(100, taskA);
await expect(locks.acquire(100, taskB)).rejects.toThrow(RepoLockedError);
await expect(locks.acquire(200, taskB)).resolves.toBeDefined();
await first.release();
```

- [ ] **Step 2: Write filesystem-lock collision test**

Pre-create `~/.gram-agent/locks/repos/100.lock` and assert acquisition fails even if SQLite is empty.

- [ ] **Step 3: Verify tests fail**

```bash
pnpm --filter @gram/repo-lock test
```

- [ ] **Step 4: Implement transactional SQLite lease acquisition**

Use `BEGIN IMMEDIATE`/better-sqlite3 transaction semantics to insert a unique `repo_id` row and transition the task from `WAITING_REPO_LOCK` to `PREPARING` in the same application operation.

- [ ] **Step 5: Implement atomic filesystem lock creation**

Open lock file with exclusive create semantics (`wx`). Write task UUID, PID, boot ID, and timestamp. If either SQLite or filesystem acquisition fails, roll back/release the other side.

- [ ] **Step 6: Add heartbeat timer**

Every 15 seconds update `heartbeat_at` and `lease_until = now + 60s`. Heartbeat failure transitions the task toward recovery rather than silently continuing mutation.

- [ ] **Step 7: Test and commit**

```bash
pnpm --filter @gram/repo-lock test
git add packages/repo-lock packages/persistence/src/repositories/lock-repository.ts
git commit -m "feat: serialize repository mutation with leases"
```

---

### Task 4: Implement task worktrees and WSL/Windows path mapping

**Files:**
- Create: `packages/workspace/package.json`
- Create: `packages/workspace/src/worktree-service.ts`
- Create: `packages/workspace/src/workspace-resolver.ts`
- Create: `packages/workspace/src/path-mapper.ts`
- Test: `packages/workspace/src/worktree-service.test.ts`
- Test: `packages/workspace/src/path-mapper.test.ts`
- Create: `packages/workspace/src/index.ts`

**Interfaces:**
- Produces:
  - `WorktreeService.create({ taskId, repo, baseRef, branch }): Promise<Workspace>`
  - `Workspace.linuxPath`
  - `Workspace.windowsPath`
  - `PathMapper.toWindows(linuxPath): Promise<string>`

- [ ] **Step 1: Write worktree path/isolation tests**

Assert path form:

```ts
expect(workspace.linuxPath).toBe(`${home}/.gram-agent/worktrees/84722133/${taskId}`);
expect(workspace.linuxPath).not.toContain('/workspace/github/company/mamf-web/.git/worktrees');
```

Create a temporary Git repo + bare remote, create a worktree, modify a file there, and assert canonical checkout remains unchanged.

- [ ] **Step 2: Write path-mapping tests using an injected `wslpath` runner**

The mapper must delegate conversion rather than hard-code `Ubuntu-24.04` or username.

- [ ] **Step 3: Implement branch naming**

Default branch name:

```text
fix/task-000201-<slug>
feat/task-000201-<slug>
chore/task-000201-<slug>
```

Choose prefix from task type; use display sequence only for readability, never as identity.

- [ ] **Step 4: Implement `git worktree add` through Git port**

The service receives `baseRef`, usually `origin/<defaultBranch>`, and persists workspace metadata only after Git confirms creation.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/workspace test
git add packages/workspace
git commit -m "feat: isolate tasks in git worktrees"
```

---

### Task 5: Implement policy-gated command execution and evidence capture

**Files:**
- Create: `packages/shell/package.json`
- Create: `packages/shell/src/command-runner.ts`
- Create: `packages/shell/src/output-capture.ts`
- Test: `packages/shell/src/command-runner.test.ts`
- Modify: `packages/persistence/src/repositories/command-run-repository.ts`

**Interfaces:**
- Produces:
  - `CommandRunner.run(request: CommandRequest): Promise<CommandResult>`
  - request always carries `taskId`, `cwd`, executable/args or shell text, and operation category.

- [ ] **Step 1: Write test proving policy is consulted before process spawn**

Inject a fake spawner. For a DENY decision assert the spawner is never called. For `NEEDS_APPROVAL`, assert no spawn occurs until a matching consumed approval is provided.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/shell test
```

- [ ] **Step 3: Implement process spawning without secret inheritance**

Construct a minimal environment allowlist from safe process variables. High-value credentials must only be added by specialized adapters; raw command execution cannot inherit GitHub/tunnel/internal-MCP credentials.

- [ ] **Step 4: Persist command lifecycle outside long DB transactions**

```text
insert RUNNING command_run -> commit
spawn process
capture/redact stdout + stderr to files
update result/exit_code -> commit
```

Store logs under:

```text
~/.gram-agent/logs/tasks/<task-uuid>/cmd-<command-run-id>.{stdout,stderr}
```

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/shell test
git add packages/shell packages/persistence/src/repositories/command-run-repository.ts
git commit -m "feat: execute policy-gated task commands"
```

---

### Task 6: Implement task-scoped code and file operations

**Files:**
- Create: `packages/filesystem/package.json`
- Create: `packages/filesystem/src/workspace-path-guard.ts`
- Create: `packages/filesystem/src/code-search.ts`
- Create: `packages/filesystem/src/file-service.ts`
- Create: `packages/filesystem/src/patch-service.ts`
- Create: `packages/filesystem/src/diff-service.ts`
- Test: `packages/filesystem/src/file-service.test.ts`
- Create: `packages/mcp/src/tools/code-tools.ts`

**Interfaces:**
- Produces MCP/application operations taking `taskId + relativePath`, not unrestricted absolute paths.

- [ ] **Step 1: Write traversal/symlink escape tests**

Reject:

```text
../../etc/passwd
absolute /etc/passwd
symlink inside worktree -> /etc
```

Allow normal worktree-relative files.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/filesystem test
```

- [ ] **Step 3: Implement canonical workspace path guard**

Resolve requested paths beneath the task workspace and verify the canonical target or nearest existing parent remains within the canonical workspace root.

- [ ] **Step 4: Implement code search**

Prefer `rg --json` through `CommandRunner` so search is audited/policy-checked. Parse results into structured `{ path, line, column, text }` records.

- [ ] **Step 5: Implement exact patch/write operations**

`file_patch` must fail if the expected old hunk is absent rather than silently applying to the wrong code.

- [ ] **Step 6: Test and commit**

```bash
pnpm --filter @gram/filesystem test
git add packages/filesystem packages/mcp/src/tools/code-tools.ts
git commit -m "feat: add task-scoped code operations"
```

---

### Task 7: Implement local Git operations and repository sync

**Files:**
- Create: `packages/git/package.json`
- Create: `packages/git/src/git-service.ts`
- Create: `packages/git/src/branch-service.ts`
- Create: `packages/git/src/commit-service.ts`
- Create: `packages/git/src/remote-service.ts`
- Test: `packages/git/src/git-service.test.ts`
- Create: `packages/mcp/src/tools/git-tools.ts`

**Interfaces:**
- Produces:
  - `GitService.fetch(repoPath): Promise<void>`
  - `GitService.status(worktree): Promise<GitStatus>`
  - `GitService.diff(worktree, baseRef?): Promise<string>`
  - `CommitService.commitExplicit(worktree, paths, message): Promise<string>`
  - `RemoteService.push(worktree, branch): Promise<void>`
  - `RemoteService.confirmRemoteSha(remote, branch, expectedSha): Promise<boolean>`

- [ ] **Step 1: Write explicit staging test**

Create files `intended.ts` and `unrelated.tmp`; call `commitExplicit(['intended.ts'])`; assert only intended file is committed.

- [ ] **Step 2: Write remote-confirmation test with a local bare remote**

Push a commit then verify `git ls-remote origin refs/heads/<branch>` matches expected SHA. Also test mismatch returns `false`.

- [ ] **Step 3: Implement Git operations through `CommandRunner`**

Do not bypass Policy Engine by invoking `child_process` directly in `@gram/git`.

- [ ] **Step 4: Enforce protected-branch publishing policy**

`RemoteService.push` must pass target branch/publish mode into Policy context. Direct protected-branch push without explicit task grant becomes `NEEDS_APPROVAL`; force/force-with-lease on protected branches is DENY.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/git test
git add packages/git packages/mcp/src/tools/git-tools.ts
git commit -m "feat: add safe local git operations"
```

---

### Task 8: Implement change-aware Verification Engine

**Files:**
- Create: `packages/verification/package.json`
- Create: `packages/verification/src/change-classifier.ts`
- Create: `packages/verification/src/verification-planner.ts`
- Create: `packages/verification/src/verification-runner.ts`
- Create: `packages/verification/src/evidence-collector.ts`
- Create: `packages/verification/src/completion-evaluator.ts`
- Test: `packages/verification/src/verification-planner.test.ts`
- Test: `packages/verification/src/completion-evaluator.test.ts`
- Create: `packages/mcp/src/tools/verification-tools.ts`

**Interfaces:**
- Produces:
  - `VerificationPlanner.plan(changeSet, repoProfile): VerificationPlan`
  - `VerificationRunner.run(plan, taskContext): Promise<VerificationResult>`
  - `CompletionEvaluator.requiredChecksPassed(taskId): boolean`

- [ ] **Step 1: Write planner matrix tests**

For frontend API logic with repo scripts `lint`, `test`, `build`, expect all three required. For docs-only changes, do not require absent build/test commands. For UI classification, include browser check as required only if repo profile declares browser verification capability; otherwise persist `SKIPPED` with explicit reason.

- [ ] **Step 2: Write completion-gate tests**

Required PASS → true. Required FAIL/SKIPPED → false. Optional NOT_REQUIRED does not block.

- [ ] **Step 3: Implement evidence persistence**

Each command check links to a `command_run_id` and stores evidence/log reference. No check may transition to PASS without an actual successful execution or an explicit non-command verifier result.

- [ ] **Step 4: Add secret scan and diff review gates**

Secret scan is always required before publishing. Diff review records changed paths and confirms no untracked unintended files are staged.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/verification test
git add packages/verification packages/mcp/src/tools/verification-tools.ts
git commit -m "feat: verify task changes with evidence"
```

---

### Task 9: Implement Publishing Service with confirmed-push lock release

**Files:**
- Create: `packages/publishing/package.json`
- Create: `packages/publishing/src/publishing-service.ts`
- Test: `packages/publishing/src/publishing-service.test.ts`
- Create: `packages/publishing/src/index.ts`

**Interfaces:**
- Consumes: Verification completion port, CommitService, RemoteService, RepoLockLease, persistence.
- Produces: `PublishingService.publish(taskContext): Promise<PublishedCommit>`.

- [ ] **Step 1: Write ordering test for the critical invariant**

Use fakes recording calls and assert exact sequence:

```ts
expect(events).toEqual([
  'verification.assertPassed',
  'commit',
  'push',
  'remote.confirm',
  'lock.release'
]);
```

Assert `lock.release` is not called when remote confirmation returns false.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/publishing test
```

- [ ] **Step 3: Implement publishing transaction boundaries**

Persist commit SHA after commit; persist `remote_confirmed=1` only after `ls-remote`/GitHub ref confirmation; then release lock; then transition task toward PR publishing.

- [ ] **Step 4: Add audit events**

Emit in order:

```text
COMMIT_CREATED
PUSH_STARTED
REMOTE_PUSH_CONFIRMED
REPO_LOCK_RELEASED
```

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/publishing test
git add packages/publishing
git commit -m "feat: release repo lock after confirmed push"
```

---

### Task 10: Implement GitHub PR creation/reuse without Repo Lock

**Files:**
- Create: `packages/github/package.json`
- Create: `packages/github/src/github-client.ts`
- Create: `packages/github/src/pull-request-service.ts`
- Test: `packages/github/src/pull-request-service.test.ts`
- Create: `packages/github/src/index.ts`
- Create: `packages/mcp/src/tools/github-tools.ts`

**Interfaces:**
- Produces: `PullRequestService.ensureForTask(task): Promise<PullRequestView>`.
- Constraint: service has no dependency on `RepoLockService` and must never acquire a repository lock.

- [ ] **Step 1: Write PR idempotency test**

If GitHub reports an open PR for `headBranch -> baseBranch`, `ensureForTask` returns it and never calls create.

- [ ] **Step 2: Write architecture test prohibiting repo-lock dependency**

Use static import scanning in a package-boundary test to assert `packages/github/**` does not import `@gram/repo-lock`.

- [ ] **Step 3: Implement GitHub adapter with scoped credential injection**

The adapter obtains GitHub credentials from `SecretProvider` only for the request/process. Raw `CommandRunner` environment remains credential-free.

- [ ] **Step 4: Build PR metadata from stored task evidence**

PR body includes Summary, Root Cause when known, changed paths summary, and exact verification statuses. Do not state a check passed unless persisted evidence says PASS.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/github test
git add packages/github packages/mcp/src/tools/github-tools.ts
git commit -m "feat: create idempotent pull requests"
```

---

### Task 11: Implement lock-free CI Observer

**Files:**
- Create: `packages/github/src/checks-service.ts`
- Test: `packages/github/src/checks-service.test.ts`
- Modify: `packages/persistence/src/repositories/ci-run-repository.ts`

**Interfaces:**
- Produces:
  - `ChecksService.observeRequiredChecks(pr): Promise<CiSummary>`
  - no lock dependency.

- [ ] **Step 1: Write lock-free architecture test**

Static import assertions:

```ts
expect(importsOf('packages/github/src/checks-service.ts')).not.toContain('@gram/repo-lock');
```

Also use a fake lock port that throws if touched and prove CI observation succeeds without it.

- [ ] **Step 2: Implement CI persistence**

Persist provider run/check IDs, workflow/check name, status, conclusion, started/finished times, and URL. Poll with bounded backoff; observation may stop and resume without changing repository files.

- [ ] **Step 3: Implement completion behavior**

When all required checks pass, transition task to `COMPLETED`. When checks fail, record CI failure; do not mutate code from the observer.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/github test
git add packages/github/src/checks-service.ts packages/github/src/checks-service.test.ts packages/persistence/src/repositories/ci-run-repository.ts
git commit -m "feat: observe ci without repository lock"
```

---

### Task 12: Implement CI repair mutation cycle

**Files:**
- Modify: `packages/task-engine/src/task-runner.ts`
- Test: `packages/task-engine/src/task-runner.test.ts`

**Interfaces:**
- Consumes: failed CI result.
- Produces: reacquire → repair → verify → push → confirm → release → observe sequence.

- [ ] **Step 1: Write ordering test**

Expected event order after CI failure requiring code change:

```text
ci.failed
lock.acquire
workspace.reuse
repair
verify
push
remote.confirm
lock.release
ci.observe
```

Assert no code-modification callback runs before lock reacquisition.

- [ ] **Step 2: Implement repair-cycle orchestration**

The CI observer emits a failure outcome; `TaskRunner` decides whether the failure is repairable. Only `TaskRunner` reacquires the lock and invokes mutation services.

- [ ] **Step 3: Test and commit**

```bash
pnpm --filter @gram/task-engine test
git add packages/task-engine/src/task-runner.ts packages/task-engine/src/task-runner.test.ts
git commit -m "feat: reacquire repo lock for ci repairs"
```

---

### Task 13: Wire the complete TaskRunner vertical slice

**Files:**
- Create: `packages/task-engine/src/task-runner.ts`
- Create: `packages/task-engine/src/failure-classifier.ts`
- Test: `packages/task-engine/src/task-runner.test.ts`
- Modify: `apps/agent/src/main.ts`

**Interfaces:**
- Produces: `TaskRunner.run(taskId): Promise<void>`.

- [ ] **Step 1: Write a fake-port orchestration test**

Assert the initial happy-path call sequence:

```text
repo.resolve
lock.acquire
repo.fetch
workspace.create
instructions.load
analyze
modify
verify
commit/push/confirm
lock.release
pr.ensure
ci.observe
complete
```

- [ ] **Step 2: Add failure tests for each lock boundary**

At minimum:

```text
verification fail -> lock remains until task mutation phase is explicitly stopped/recovered
push fail -> lock remains
remote confirmation fail -> lock remains
PR create fail after confirmed push -> lock is already released
CI timeout -> lock remains released
```

- [ ] **Step 3: Implement orchestration using ports only**

`TaskRunner` must not run shell commands or SQL directly.

- [ ] **Step 4: Wire real implementations in application composition root**

`apps/agent/src/main.ts` constructs dependencies and schedules QUEUED tasks. Same-repo serialization is enforced by RepoLock rather than a global single-task queue.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/task-engine test
pnpm --filter @gram/agent test
git add packages/task-engine apps/agent/src/main.ts
git commit -m "feat: orchestrate end to end coding tasks"
```

---

### Task 14: Add automated vertical-slice E2E fixture

**Files:**
- Create: `tests/e2e/fixtures/create-test-repo.ts`
- Create: `tests/e2e/fakes/fake-github-server.ts`
- Create: `tests/e2e/vertical-slice.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: deterministic local E2E proving all internal boundaries, plus optional live-GitHub smoke acceptance.

- [ ] **Step 1: Create a deterministic test repository fixture**

Fixture creates:

```text
bare remote
canonical clone
small TypeScript project
failing target behavior
package.json scripts: lint/test/build
```

- [ ] **Step 2: Create fake GitHub API for PR/check lifecycle**

Support only endpoints needed by the adapter:

```text
find PR by head/base
create PR
list required checks
check transitions pending -> success
```

- [ ] **Step 3: Write end-to-end test through `task_create` service boundary**

The test must prove:

```text
task gets UUIDv7 + sequence
repo lock acquired
worktree created outside canonical checkout
file changed in worktree only
verification evidence persisted
commit created
branch pushed
remote SHA confirmed
repo lock row absent before PR creation
PR created/reused
CI observed while lock table stays empty
task COMPLETED
```

- [ ] **Step 4: Run the complete E2E test**

```bash
pnpm test:e2e
```

Expected: PASS.

- [ ] **Step 5: Add live GitHub smoke test instructions**

Create `docs/operations/m2-live-smoke.md` with an authenticated disposable private repository procedure. The smoke run is required before tagging `v0.1.0`, but credentials are never committed.

- [ ] **Step 6: Run all checks and commit**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
git add tests package.json docs/operations/m2-live-smoke.md
git commit -m "test: prove first coding task vertical slice"
```

---

### Task 15: Expose the complete M2 read/control MCP surface

**Files:**
- Modify: `packages/mcp/src/tools/task-tools.ts`
- Modify: `packages/mcp/src/tools/repo-tools.ts`
- Modify: `packages/mcp/src/tools/git-tools.ts`
- Modify: `packages/mcp/src/tools/verification-tools.ts`
- Modify: `packages/mcp/src/tools/github-tools.ts`
- Create: `packages/mcp/src/tools/agent-tools.ts`
- Test: `packages/mcp/src/tools/tools-contract.test.ts`

**Interfaces:**
- Produces the v1 vertical-slice tool names needed to inspect work without raw shell access:
  - `task_get`, `task_list`, `task_logs`, `task_result`
  - `repo_resolve`, `repo_list`, `repo_get`, `repo_inspect`, `repo_register`
  - `git_status`, `git_diff`, `git_log`, `git_blame`
  - `verification_plan`, `verification_status`, `verification_evidence`
  - `github_pr_get`, `github_pr_checks`
  - `agent_status`, `agent_health`, `agent_logs`

- [ ] **Step 1: Write an MCP tool-name/schema contract test**

Assert the registered tool list contains every name above and rejects unknown fields via strict Zod schemas. Read/status tools must not require a repo mutation lock.

- [ ] **Step 2: Write authorization tests for task-scoped reads**

`task_logs` and `verification_evidence` accept a Task UUID/display ID resolver and return only data belonging to the selected task. They must not expose secret-file contents or raw credential metadata.

- [ ] **Step 3: Wire tools to application services only**

MCP handlers call Task/Repo/Git/Verification/GitHub/Health services and contain no SQL, shell, Git, or policy implementation.

- [ ] **Step 4: Run MCP contract tests**

```bash
pnpm --filter @gram/mcp test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools
git commit -m "feat: expose task and repository inspection tools"
```

---

### Task 16: M2 live acceptance and v0.1.0 release gate

**Files:**
- Create: `docs/operations/m2-acceptance.md`

**Interfaces:**
- Produces: recorded evidence for the first usable release.

- [ ] **Step 1: Execute one real task against a disposable private GitHub repo**

The requested change must require a real file modification, test/build, branch push, PR, and CI.

- [ ] **Step 2: Capture state evidence without secrets**

Record task UUID/display ID, repo ID, worktree path, commit SHA, remote-confirmation timestamp, lock-release timestamp, PR number, CI conclusion, and final Task state.

- [ ] **Step 3: Verify the core invariant from timestamps**

Acceptance fails unless:

```text
remote_push_confirmed_at <= repo_lock_released_at < pr_created_at <= ci_observed_at
```

The lock table must be empty for that repository during CI observation.

- [ ] **Step 4: Run final repository verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

- [ ] **Step 5: Commit and tag**

```bash
git add docs/operations/m2-acceptance.md
git commit -m "docs: record v0.1 vertical slice acceptance"
git tag -a v0.1.0 -m "First verified coding task vertical slice"
git push origin main --tags
```

Only perform the direct `main` push here if the release-maintenance task explicitly authorizes it; otherwise merge the release PR then push the tag.
