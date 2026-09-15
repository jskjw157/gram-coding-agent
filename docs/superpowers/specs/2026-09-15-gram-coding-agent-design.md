# Gram Coding Agent — Architecture Design Specification

**Status:** Approved design, ready for implementation planning  
**Date:** 2026-09-15  
**Repository:** `gram-coding-agent` (Private)  
**Target runtime:** Windows 11 LG Gram + WSL2 Ubuntu  
**Primary interface:** ChatGPT via MCP  
**Implementation language:** TypeScript / Node.js  
**Architecture:** Modular monolith + internal workers  
**Remote transport:** OpenAI `tunnel-client` only

---

## 1. Purpose

`gram-coding-agent` turns a dedicated Windows LG Gram into a remotely operated AI coding machine controlled primarily through ChatGPT.

The user should be able to ask ChatGPT to inspect, modify, test, build, commit, push, and create pull requests for GitHub repositories without using a separate coding UI for normal operation.

The system must retain enough state to recover interrupted tasks, enforce repository and host safety policies, verify changes before publishing, and provide auditable evidence for completed work.

## 2. Goals

1. Allow ChatGPT to perform end-to-end coding work inside WSL2.
2. Provide full WSL2 Ubuntu operating authority while retaining explicit safety boundaries.
3. Use task-scoped Git worktrees so the canonical repository checkout stays clean.
4. Track every substantial coding request as a resumable Task.
5. Persist task state, steps, verification evidence, publishing state, and audit history in SQLite.
6. Serialize writes per repository while allowing different repositories to run concurrently.
7. Default to branch → commit → push → PR; allow direct `main` push only when explicitly requested.
8. Release the repository lock immediately after remote push confirmation.
9. Observe PR/CI state without holding a repository lock.
10. Use OpenAI `tunnel-client` as the only ChatGPT-to-local MCP tunnel mechanism.
11. Keep raw Windows shell execution approval-gated while exposing typed, allowlisted Windows integration tools.
12. Keep the v1 user experience ChatGPT-only while preserving clean extension points for a later dashboard.

## 3. Non-goals for v1

- Standalone web dashboard.
- Multi-agent distributed orchestrator.
- Microservices.
- PostgreSQL or another remote database.
- Arbitrary raw Windows command execution as an automatically allowed capability.
- Automatic protected-branch force pushes.
- Repository deletion or destructive disk administration.
- Browser automation as a prerequisite for the first vertical slice.

## 4. Confirmed design decisions

| Area | Decision |
|---|---|
| Runtime | WSL2 Ubuntu on Windows 11 |
| WSL authority | Full WSL authority |
| Main implementation | TypeScript / Node.js |
| Architecture | Modular monolith + internal workers |
| Task model | Stateful Task Engine |
| Persistence | SQLite, WAL mode |
| Task ID | UUIDv7 canonical ID + atomic human-readable sequence |
| Concurrency | Same repo serialized; different repos may run in parallel |
| Task workspace | One Git worktree per task |
| Git policy | PR by default; direct `main` only on explicit user instruction |
| Protected history | Force push/delete protected branch denied |
| MCP exposure | localhost only |
| Tunnel | OpenAI `tunnel-client` only |
| Tailscale | Device/admin network, not ChatGPT MCP transport |
| Security | Normal dev auto-allowed; risky ops approval-gated; destructive ops denied |
| Repository discovery | Registry first; auto-discover and onboard unknown GitHub repos |
| Verification | Change-aware verification + evidence + CI observation |
| UX | ChatGPT-only v1; dashboard-capable internals |
| Windows raw shell | `powershell.exe`, `pwsh.exe`, `cmd.exe` require approval |
| Windows typed tools | Path/open/reveal/clipboard operations auto-allowed |
| CI locking | No repo lock while observing CI |

## 5. System architecture

```text
ChatGPT
   |
   | MCP
   v
OpenAI tunnel-client
   |
   | localhost only
   v
127.0.0.1:<mcp-port>
+------------------------------------------------+
| gram-coding-agent                              |
|                                                |
|  MCP Gateway                                   |
|      |                                         |
|      v                                         |
|  Task Engine -------- SQLite                   |
|      |                                         |
|      +-- Repo Registry                         |
|      +-- Repo Lock                             |
|      +-- Workspace / Worktree                  |
|      +-- Filesystem / Code Operations          |
|      +-- Git                                   |
|      +-- Verification                          |
|      +-- Publishing                            |
|      +-- GitHub / CI Observer                  |
|      +-- Policy Engine                         |
|      +-- Secret Provider                       |
|      +-- Windows Integration                   |
|      +-- Audit / Observability                 |
+------------------------------------------------+
```

The deployment unit is one `gram-coding-agent` service. Internal modules remain strongly separated so future extraction is possible without requiring distributed deployment in v1.

## 6. MCP transport authentication and authorization

MCP transport security is a hard prerequisite for every other safety layer.

### 6.1 OpenAI workspace / connector authorization

The tunnel is associated with the intended ChatGPT workspace/connector. Possessing a tunnel identifier alone must not be sufficient to obtain useful access.

### 6.2 OpenAI tunnel runtime credential

The Gram runtime stores only a restricted runtime credential sufficient to use/read the configured tunnel. The long-running Gram service must not contain a tunnel administration credential capable of creating, deleting, or reconfiguring tunnels.

Conceptual runtime configuration:

```text
CONTROL_PLANE_TUNNEL_ID=<tunnel-id>
CONTROL_PLANE_API_KEY=<restricted-runtime-key>
```

### 6.3 Local MCP shared secret

The MCP service binds only to loopback:

```text
127.0.0.1:<mcp-port>
```

Bootstrap generates a random internal secret. `tunnel-client` supplies it as a fixed local request header such as:

```text
X-Gram-Agent-Auth: <secret>
```

The MCP server rejects missing or incorrect credentials before tool dispatch.

### 6.4 Secret handling

Tunnel/runtime/internal MCP secrets:

- must not be committed to Git,
- must not be stored in task SQLite records,
- must not be emitted into MCP responses,
- must not be written to audit logs,
- must be redacted from process output.

### 6.5 Services

Preferred systemd units:

```text
gram-coding-agent.service
openai-mcp-tunnel.service
```

## 7. Task identity

Each Task uses:

```text
Canonical ID: UUIDv7
Display sequence: TASK-000201
```

Schema principle:

```text
tasks.id   = UUIDv7 TEXT PRIMARY KEY
tasks.seq  = INTEGER UNIQUE
```

All durable references use UUIDv7. The display sequence is allocated atomically in SQLite and is human-facing only.

## 8. Task lifecycle

Primary states:

```text
QUEUED
WAITING_REPO_LOCK
PREPARING
RUNNING
VERIFYING
PUBLISHING
COMPLETED
```

Exceptional/control states:

```text
NEEDS_APPROVAL
NEEDS_RECOVERY
FAILED
INTERRUPTED
CANCELLED
```

Logical steps include:

```text
repo.resolve
repo.lock
repo.sync
workspace.create
analyze
implement
verify
commit
push
pr.create
ci.observe
```

External commands never execute while a long SQLite transaction remains open.

## 9. First vertical slice

The first implementation target is:

```text
task_create
   -> repo_resolve
   -> repo_lock.acquire
   -> git fetch
   -> worktree.create
   -> repository instructions load
   -> analyze
   -> modify
   -> verification.plan
   -> test/lint/build
   -> diff review
   -> secret scan
   -> commit
   -> push
   -> remote push confirmation
   -> repo_lock.release
   -> PR create
   -> CI observe
   -> COMPLETED
```

### Critical lock boundary

```text
LOCKED
  resolve
  fetch
  worktree
  analyze
  modify
  verify
  commit
  push
  remote-confirm

RELEASE LOCK

UNLOCKED
  create PR
  observe CI
  update task status
```

If CI fails and repair is necessary:

```text
CI FAIL
  -> reacquire repo lock
  -> reuse task worktree
  -> repair
  -> verify
  -> push
  -> remote confirm
  -> release lock
  -> observe CI again
```

CI observation itself never acquires a repository lock.

## 10. Repository registry

Known repositories have a profile containing GitHub identity, default branch, local base path, project type, language, package manager, standard commands, and optional verification metadata.

Unknown repositories may be discovered on GitHub, inspected, then registered.

Repository lock identity uses the immutable GitHub repository ID rather than `owner/name`.

## 11. Repository locking

Same-repository mutation is serialized; different repositories may execute concurrently.

`repo_locks` contains:

```text
repo_id
owner_task_id
lease_token
acquired_at
heartbeat_at
lease_until
owner_pid
owner_boot_id
```

Defaults:

```text
Lease TTL: 60 seconds
Heartbeat: 15 seconds
```

A filesystem lock complements the SQLite lease:

```text
~/.gram-agent/locks/repos/<github-repo-id>.lock
```

On boot, recovery runs before normal queued work. A repository with an unresolved interrupted owner is recovery-blocked.

## 12. Worktree strategy

Canonical checkout:

```text
/home/<user>/workspace/github/<owner>/<repo>
```

Task worktree:

```text
/home/<user>/.gram-agent/worktrees/<github-repo-id>/<task-uuid>/
```

Normal task edits never occur in the canonical checkout.

## 13. Windows ↔ WSL path mapping

Active repositories and builds live inside the WSL filesystem rather than `/mnt/c`.

Example:

```text
/home/<user>/.gram-agent/worktrees/123456/<task-uuid>
```

Windows-visible equivalent:

```text
\\wsl.localhost\Ubuntu-24.04\home\<user>\.gram-agent\worktrees\123456\<task-uuid>
```

Conversion is dynamic, e.g. via `wslpath`, rather than hard-coded.

## 14. Worktree cleanup policy

- `COMPLETED`: retain clean worktree 24 hours, then remove automatically.
- `FAILED` / `CANCELLED`: retain 7 days by default.
- `NEEDS_APPROVAL`: retain until resolved.
- `NEEDS_RECOVERY`: never auto-delete.

Janitor must not delete worktrees with uncommitted changes, unconfirmed remote commits, or unresolved recovery state.

Disk pressure policy:

- `<80%`: normal,
- `>=80%`: prioritize oldest eligible completed worktrees,
- `>=90%`: aggressively clear eligible completed worktrees and safe caches.

## 15. Git publishing policy

Default:

```text
branch -> commit -> push -> PR
```

Direct `main` push is allowed only when explicitly requested for the task.

Hard invariants:

```text
force push protected branch     DENY
force-with-lease protected      DENY
delete protected branch         DENY
delete GitHub repository        DENY
```

The pushed remote commit must be confirmed before repo lock release.

## 16. Verification policy

Verification is change-aware.

| Change class | Typical required verification |
|---|---|
| Documentation | relevant syntax/content checks |
| Config | validation + relevant build/check |
| Frontend logic | lint + targeted/full tests + build |
| UI | frontend checks + browser verification when available/required |
| Backend | tests + build + startup/log check as appropriate |
| DB migration | migration-specific validation |
| CI workflow | workflow syntax + remote CI observation |

Evidence includes command, working directory, timestamps, exit code, stdout/stderr references, and artifacts where applicable.

An unverified check is `SKIPPED` or `NOT_REQUIRED`, never implied to have passed.

## 17. Policy Engine

Every sensitive operation resolves to:

```text
ALLOW
NEEDS_APPROVAL
DENY
```

Shell policy is parsed and normalized, not implemented as a raw regex blacklist.

Evaluation pipeline:

1. parse shell composition,
2. split pipelines / `&&` / `;` / subshells,
3. resolve executable,
4. normalize arguments,
5. canonicalize paths,
6. classify each operation,
7. apply the highest risk decision.

### ALLOW examples

- normal file read/search,
- task-worktree edits,
- Git status/diff/log/blame,
- fetch/pull,
- task branch creation,
- feature branch commits/pushes,
- npm/pnpm/yarn install/test/build,
- Gradle/Maven build/test,
- Python test/install workflows,
- development servers,
- ordinary `apt install`,
- status/log queries,
- PR creation/update,
- CI status/log observation,
- typed Windows integration tools.

### NEEDS_APPROVAL examples

- large recursive delete,
- `git reset --hard`,
- `git clean -fdx`,
- direct protected-branch push without explicit grant,
- important `/etc` changes,
- package purge/removal,
- durable service enable/disable,
- user/group changes,
- broad permission changes,
- SSH configuration changes,
- firewall changes,
- destructive DB operations,
- important secret rotation,
- shutdown/reboot,
- raw Windows shell execution.

### DENY examples

- `rm -rf /`,
- destructive `/mnt/c` root operations,
- `mkfs.*`,
- `wipefs`,
- destructive block-device writes/partitioning,
- fork bombs,
- force push to protected branches,
- protected-branch deletion,
- GitHub repository deletion,
- Policy Engine bypass/disable,
- secret dumping.

Approvals are bound to an operation hash and cannot be reused for a different operation.

## 18. Windows integration

Raw Windows command execution remains approval-gated:

```text
powershell.exe ...
pwsh.exe ...
cmd.exe /c ...
arbitrary Windows .exe execution
```

Typed Windows tools are auto-allowed:

```text
windows_path
windows_open
windows_reveal
windows_clipboard_read
windows_clipboard_write
```

There is intentionally no `windows_exec(command)`.

An adapter may internally use a fixed PowerShell implementation where unavoidable, but MCP/user input must not become arbitrary PowerShell source.

Clipboard operations are text-only, size-bounded, secret-redacted, and their raw content is not copied into audit logs.

## 19. Secret architecture

No generic MCP `secret_get` is exposed.

Use domain-specific credential status/use operations. Credentials are injected only into the worker/process that needs them.

Raw shell execution does not inherit high-value credentials such as GitHub tokens, the internal MCP secret, or tunnel runtime credentials.

Secret scanning is required before normal publishing.

## 20. Automatic startup and recovery

WSL uses systemd.

On restart:

1. load SQLite,
2. find previously active tasks,
3. inspect worktrees/branches/process state,
4. reacquire safe locks where appropriate,
5. resume only when state is consistent,
6. otherwise mark `NEEDS_RECOVERY`.

## 21. SQLite persistence model

Database:

```text
~/.gram-agent/state/agent.db
```

Configuration:

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = configured
```

Core tables:

- `tasks` — UUIDv7 PK + unique display sequence and lifecycle state.
- `task_steps` — logical workflow steps/attempts.
- `command_runs` — actual process evidence and log references.
- `repositories` — repo registry/profile.
- `repo_locks` — exclusive write lease.
- `workspaces` — worktree paths, cleanup/dirty/unpushed state.
- `verification_plans` — change class/risk/plan.
- `verification_checks` — required/optional checks and evidence.
- `git_commits` — task commits and remote confirmation.
- `pull_requests` — PR identity/state.
- `ci_runs` — lock-free CI observation state.
- `policy_decisions` — normalized operation/risk/decision/rule/hash.
- `approvals` — operation-specific approval lifecycle.
- `audit_events` — secret-safe structured lifecycle/security events.

State writes use short DB transactions. External commands execute outside DB transactions.

## 22. TypeScript module boundaries

```text
gram-coding-agent/
├─ apps/
│  └─ agent/
└─ packages/
   ├─ domain/
   ├─ task-engine/
   ├─ persistence/
   ├─ repo-registry/
   ├─ repo-lock/
   ├─ workspace/
   ├─ filesystem/
   ├─ shell/
   ├─ policy/
   ├─ verification/
   ├─ git/
   ├─ github/
   ├─ publishing/
   ├─ windows-integration/
   ├─ secrets/
   ├─ mcp/
   └─ observability/
```

Responsibilities:

- `domain`: pure types/invariants.
- `task-engine`: orchestration/scheduling/recovery/state transitions.
- `persistence`: SQLite repositories/migrations only.
- `repo-registry`: resolve/discover/inspect/profile repositories.
- `repo-lock`: lease/heartbeat/stale lock recovery.
- `workspace`: worktree creation/path mapping/cleanup.
- `filesystem`: task-scoped file/code operations.
- `shell`: process execution/output capture.
- `policy`: parsing/risk/path/Git/Windows/approval rules.
- `verification`: classification/planning/execution/evidence/completion.
- `git`: local Git only.
- `github`: GitHub repos/issues/PRs/Actions.
- `publishing`: commit/push/remote confirm/lock-release boundary.
- `windows-integration`: typed Windows operations only.
- `secrets`: provider/injection/redaction/scanning.
- `mcp`: external transport/tool adapters only.
- `observability`: structured logs/audit/health/metrics.

Dependency direction:

```text
MCP -> application/task services -> domain
Adapters -> application ports/domain contracts
```

## 23. MCP surface

v1 groups:

- Tasks: create/get/list/cancel/resume/retry/approve/logs/result.
- Repositories: resolve/list/get/discover/inspect/register.
- Code/filesystem: search/read/tree/patch/write/move/delete/diff.
- Git: status/diff/log/blame/fetch/pull/branch/commit/push.
- GitHub: issues/PR create-get-update-comment/checks-Actions-logs.
- Verification: plan/run/status/evidence.
- System: shell/process/packages/services.
- Windows: path/open/reveal/clipboard read-write.
- Agent: status/health/logs.

Task-aware APIs prefer `task_id + relative_path` over unrestricted absolute paths.

## 24. GitHub Project and backlog

Project: `Gram Coding Agent — Engineering`

Fields:

- Status: Backlog / Ready / In Progress / Blocked / Review / Done
- Priority: P0 / P1 / P2 / P3
- Area: Core / MCP / Security / Task / Git / GitHub / Workspace / Verify / Windows / Ops
- Risk: Low / Medium / High / Critical
- Milestone: M0–M5
- Size: XS / S / M / L / XL

Minimal labels:

```text
type:epic
type:feature
type:bug
type:test
type:security
type:docs
needs:approval
breaking-change
```

## 25. Milestones

### M0 — Architecture & Repository Foundation

Repository/project foundation remains implementation work.

Architecture issues #7–#12 are not new design work. They are represented by this already-approved specification and must be created/marked Done when the GitHub backlog is materialized:

```text
#7  Write complete architecture specification          DONE
#8  Define SQLite schema and migrations                DONE (design)
#9  Define MCP tool contracts                          DONE (design)
#10 Define Policy Engine rule specification            DONE (design)
#11 Define task state machine                          DONE (design)
#12 Define vertical-slice acceptance criteria          DONE (design)
```

Implementation/migration code remains tracked by later implementation issues.

### M1 — Secure Agent Runtime

- agent bootstrap/config/systemd/health,
- SQLite runtime and migrations,
- UUIDv7 + display sequence implementation,
- localhost MCP server,
- OpenAI `tunnel-client`,
- restricted runtime credential loading,
- local MCP shared secret,
- secret redaction,
- Policy Engine v1.

### M2 — First End-to-End Coding Task

Critical path:

```text
task_create
-> repo registry
-> repo lock
-> worktree
-> code ops
-> verification
-> commit
-> push
-> remote confirm
-> LOCK RELEASE
-> PR
-> CI OBSERVE WITHOUT LOCK
-> COMPLETED
```

M2 requires a real automated vertical-slice E2E test.

Target release: `v0.1.0`.

### M3 — Reliability & Recovery

Interrupted task recovery, bounded retry, worktree lifecycle, concurrency hardening, stale lock recovery.

Target release: `v0.2.0`.

### M4 — Windows Integration & Developer UX

Typed Windows path/open/reveal/clipboard, Windows escape security tests, safe system operations, enhanced GitHub functions.

### M5 — Hardening & Production Readiness

Threat model, parser/path/symlink/injection/bypass testing, credential tests, logs/rotation, DB backup/integrity recovery, diagnostics, upgrade/rollback, WSL bootstrap/recovery documentation.

Target release: `v1.0.0`.

Dashboard remains Future backlog and is not on the v1 critical path.

## 26. Critical dependency chain

```text
Repository foundation
  -> SQLite/task identity
  -> MCP authentication
  -> Policy Engine
  -> task_create
  -> Repo Registry
  -> Repo Lock
  -> Worktree
  -> Code operations
  -> Verification
  -> Commit
  -> Push
  -> Remote confirmation
  -> LOCK RELEASE
  -> PR
  -> Lock-free CI observe
  -> Vertical Slice E2E
```

## 27. Definition of Done for v0.1.0

A real task can:

1. be created with UUIDv7 identity and display sequence,
2. resolve/onboard a GitHub repository,
3. acquire the exclusive repository lock,
4. create a task worktree,
5. inspect and modify code only in the intended workspace,
6. execute required verification and persist evidence,
7. stage and commit intended files,
8. push the task branch,
9. confirm the remote commit,
10. release the repository lock,
11. create/reuse a pull request,
12. observe required CI without reacquiring the lock,
13. mark the task completed only after required checks pass,
14. maintain auditable state without exposing secrets.

## 28. Design invariants

1. OpenAI `tunnel-client` is the sole ChatGPT MCP tunnel implementation.
2. MCP listens on loopback only.
3. Long-running runtime does not carry tunnel admin credentials.
4. Canonical task identity is UUIDv7.
5. Same-repo mutations are serialized.
6. Canonical repo checkout is not a normal task-edit workspace.
7. Repo lock is released after confirmed push, before PR creation/CI observation.
8. CI observation is lock-free.
9. CI repair reacquires the repo lock before changing code.
10. Raw PowerShell/CMD execution is approval-gated.
11. Typed Windows integration cannot expose arbitrary command execution.
12. Protected-branch force push/delete is denied.
13. Dirty/unpushed/recovery worktrees cannot be janitor-deleted automatically.
14. Required verification must have recorded evidence before verified completion.
15. Secrets are never exposed through a generic MCP secret-read operation.

## 29. Future extension points

- local/web dashboard,
- richer Playwright/browser verification,
- n8n integration,
- webhook-driven tasks,
- multiple workers or remote worker nodes,
- external secret managers,
- additional repository providers.

Future extensions must preserve the safety and locking invariants above.

## 30. Specification completion status

This document consolidates all architecture decisions approved in the design conversation.

Self-review:

- Placeholder scan: **PASS — no required TBD/TODO items**
- Internal consistency: **PASS**
- Scope: **PASS — implementation planning can proceed by milestone**
- Ambiguity review: **PASS**
- M0 architecture issues #7–#12: **Design work complete; mark Done when GitHub backlog is created**
- Tunnel implementation choice: **OpenAI `tunnel-client` only**
