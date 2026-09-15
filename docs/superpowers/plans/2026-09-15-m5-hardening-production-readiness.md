# M5 Hardening & Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the agent against policy bypass, path/symlink escape, environment and secret leakage, corrupted state, log growth, and failed upgrades; then document one-command WSL bootstrap and disaster recovery for daily use.

**Architecture:** Security tests attack the same public/application interfaces used by production rather than testing private helpers only. Operational hardening adds bounded logs, SQLite backup/integrity recovery, self-diagnostics, and versioned upgrade/rollback scripts without weakening the core MCP, Policy, Repo Lock, and secret invariants.

**Tech Stack:** Existing stack, Vitest fuzz/table tests, SQLite backup/integrity tools, systemd/journald or file rotation, shell bootstrap scripts, Git tags/releases.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Global Constraints

- MCP remains loopback-only and uses OpenAI `tunnel-client` only.
- Policy Engine bypass/disable remains DENY.
- Secrets never appear in Git, SQLite task/audit payloads, logs, or MCP responses.
- Raw Windows shell remains approval-gated.
- Typed Windows integrations remain non-arbitrary.
- Protected-branch force push/delete remains DENY.
- CI observation remains lock-free.
- Recovery/dirty/unpushed worktrees remain protected from automatic deletion.
- Dashboard and multi-agent orchestration are not required for v1.0.

---

## File Map

```text
docs/security/
├─ threat-model.md
└─ policy-invariants.md
tests/security/
├─ command-bypass.test.ts
├─ path-traversal.test.ts
├─ symlink-escape.test.ts
├─ env-injection.test.ts
├─ secret-exposure.test.ts
└─ mcp-auth.test.ts
packages/observability/src/
├─ rotating-file-sink.ts
├─ diagnostics-service.ts
└─ *.test.ts
packages/persistence/src/
├─ backup-service.ts
├─ integrity-service.ts
└─ *.test.ts
scripts/
├─ bootstrap-wsl.sh
├─ backup-state.sh
├─ restore-state.sh
├─ upgrade.sh
└─ rollback.sh
docs/operations/
├─ installation.md
├─ tailscale-admin-network.md
├─ github-authentication.md
├─ secure-mcp-tunnel.md
├─ backup-restore.md
└─ disaster-recovery.md
```

---

### Task 1: Write the explicit threat model and security invariants

**Files:**
- Create: `docs/security/threat-model.md`
- Create: `docs/security/policy-invariants.md`

**Interfaces:**
- Produces: attacker model and testable invariant list consumed by the security suite.

- [ ] **Step 1: Document trust boundaries**

Include:

```text
ChatGPT / connector
OpenAI tunnel control plane
local tunnel-client
loopback MCP server
Task Engine
Policy Engine
raw shell/process boundary
WSL filesystem
Windows boundary
GitHub
secret store
```

- [ ] **Step 2: Document attacker/control cases**

At minimum:

```text
malicious/accidental prompt requests destructive command
crafted shell composition attempts policy bypass
path traversal and symlink escape
malicious repository scripts
stdout/stderr contains secrets
clipboard contains secrets
compromised task attempts Windows shell escape
stale lock after crash
corrupted SQLite/log file
untrusted repo attempts to modify agent config
```

- [ ] **Step 3: Turn each design invariant into a test ID**

Example:

```text
SEC-MCP-001 MCP binds only loopback
SEC-TUN-001 runtime has no admin key
SEC-POL-001 protected force push denied
SEC-WIN-001 raw powershell requires approval
SEC-WIN-002 typed Windows tool cannot select executable
SEC-SEC-001 generic secret read does not exist
SEC-LOCK-001 CI observation does not hold repo lock
```

- [ ] **Step 4: Commit**

```bash
git add docs/security
git commit -m "docs: define gram agent threat model"
```

---

### Task 2: Harden shell parser against composition bypass

**Files:**
- Create: `tests/security/command-bypass.test.ts`
- Modify: `packages/policy/src/command-parser.ts`
- Modify: `packages/policy/src/risk-classifier.ts`

**Interfaces:**
- Produces: policy behavior that cannot be lowered by shell composition/encoding tricks supported by the parser.

- [ ] **Step 1: Add table-driven bypass cases**

Cover:

```text
git status && rm -rf /
git status; rm -rf /
false || rm -rf /
printf x | powershell.exe -Command whoami
( rm -rf / )
sh -c 'rm -rf /'
bash -c 'powershell.exe -Command whoami'
env FOO=bar cmd.exe /c dir
sudo -- powershell.exe -Command whoami
```

Expected decision is the highest inner-operation risk; wrapping in `sh -c`, `bash -c`, `sudo`, or `env` does not hide the nested executable.

- [ ] **Step 2: Run security test and observe failures**

```bash
pnpm vitest run tests/security/command-bypass.test.ts
```

- [ ] **Step 3: Add recursive wrapper analysis**

Recognize shell/elevation/environment wrappers and recursively parse their command payload where semantically known. Unknown command-string wrappers default to `NEEDS_APPROVAL`, not ALLOW.

- [ ] **Step 4: Run policy + security suites**

```bash
pnpm --filter @gram/policy test
pnpm test:security
```

- [ ] **Step 5: Commit**

```bash
git add packages/policy tests/security/command-bypass.test.ts
git commit -m "security: harden command policy composition parsing"
```

---

### Task 3: Harden path traversal and symlink behavior

**Files:**
- Create: `tests/security/path-traversal.test.ts`
- Create: `tests/security/symlink-escape.test.ts`
- Modify: `packages/filesystem/src/workspace-path-guard.ts`
- Modify: `packages/policy/src/path-policy.ts`

**Interfaces:**
- Produces: canonical path decisions robust to non-existing targets and symlink parents.

- [ ] **Step 1: Add traversal cases**

Cover POSIX `..`, repeated separators, encoded-looking names, absolute paths, `/proc`, `/etc`, `/mnt/c`, and paths whose nearest existing parent is outside the worktree.

- [ ] **Step 2: Add symlink cases**

Create symlinks inside a worktree pointing to:

```text
/etc
/home/<user>/.config/gram-coding-agent
/mnt/c/Users
another task worktree
```

Reads/writes through these links must be denied by task-scoped filesystem APIs unless a separate explicitly authorized system operation exists.

- [ ] **Step 3: Implement nearest-existing-parent canonicalization**

For a new file, resolve `realpath` of its nearest existing ancestor, then ensure it remains under the canonical task-workspace root before creating descendants.

- [ ] **Step 4: Run security tests and commit**

```bash
pnpm test:security
git add packages/filesystem packages/policy/src/path-policy.ts tests/security/path-traversal.test.ts tests/security/symlink-escape.test.ts
git commit -m "security: block workspace path and symlink escapes"
```

---

### Task 4: Harden environment and secret exposure boundaries

**Files:**
- Create: `tests/security/env-injection.test.ts`
- Create: `tests/security/secret-exposure.test.ts`
- Modify: `packages/shell/src/command-runner.ts`
- Modify: `packages/secrets/src/redactor.ts`
- Modify: `packages/mcp/src/server.ts`

**Interfaces:**
- Produces: proof that raw shell/task output/MCP surfaces cannot expose registered high-value secrets.

- [ ] **Step 1: Add environment tests**

Seed process environment with fake:

```text
GITHUB_TOKEN
CONTROL_PLANE_API_KEY
GRAM_MCP_INTERNAL_SECRET
OPENAI_ADMIN_KEY
```

Assert raw `CommandRunner` child environment excludes all four unless a specialized adapter explicitly leases the credential. `OPENAI_ADMIN_KEY` must never be available to the long-running application at all.

- [ ] **Step 2: Add output-redaction tests**

Have a fake command print registered secrets to stdout/stderr; assert log files, SQLite metadata, audit events, and MCP result objects contain only redacted values.

- [ ] **Step 3: Add clipboard/GitHub adapter boundary tests**

Clipboard secret content returns redacted text. GitHub adapter may use its credential internally but returned structures/logging cannot reveal it.

- [ ] **Step 4: Run security tests and commit**

```bash
pnpm test:security
git add tests/security/env-injection.test.ts tests/security/secret-exposure.test.ts packages/shell packages/secrets packages/mcp
git commit -m "security: prevent credential leakage across agent boundaries"
```

---

### Task 5: Harden MCP authentication and transport configuration

**Files:**
- Create: `tests/security/mcp-auth.test.ts`
- Modify: `packages/mcp/src/auth.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `scripts/bootstrap-wsl.sh`
- Modify: `systemd/openai-mcp-tunnel.service`

**Interfaces:**
- Produces: enforced loopback/auth runtime contract.

- [ ] **Step 1: Test listener restrictions**

Attempt application startup with `0.0.0.0`, a non-loopback LAN address, and empty host; each must fail. `127.0.0.1` and `::1` are allowed.

- [ ] **Step 2: Test timing-safe internal auth behavior**

Missing, wrong-length, and wrong-content secrets all return authorization failure without logging supplied credentials.

- [ ] **Step 3: Test unit/bootstrap files for admin-key absence**

Search service/config/bootstrap text for `OPENAI_ADMIN_KEY`; acceptance requires no long-lived runtime reference.

- [ ] **Step 4: Verify official tunnel-client doctor procedure remains documented**

The operational docs must use restricted Tunnels Read + Use runtime credentials and `tunnel-client doctor` before enabling the service.

- [ ] **Step 5: Run security suite and commit**

```bash
pnpm test:security
git add tests/security/mcp-auth.test.ts packages/mcp scripts/bootstrap-wsl.sh systemd/openai-mcp-tunnel.service docs/operations
git commit -m "security: harden mcp tunnel authentication"
```

---

### Task 6: Add bounded structured logging and rotation

**Files:**
- Create: `packages/observability/src/rotating-file-sink.ts`
- Test: `packages/observability/src/rotating-file-sink.test.ts`
- Modify: `packages/observability/src/logger.ts`
- Create: `config/logging.example.yaml`

**Interfaces:**
- Produces: bounded task/system logs with redaction before write.

- [ ] **Step 1: Write rotation tests**

Configure 1 KiB test threshold and assert rollover, retention count, and redaction. Production default:

```text
agent log max file: 25 MiB
retained files: 10
task command logs: governed by task/worktree retention + explicit max 100 MiB per command
```

Oversized command output is truncated with a recorded `truncated=true` flag while preserving beginning/end diagnostic samples after redaction.

- [ ] **Step 2: Implement rotation after redaction**

No unredacted buffer may be passed to the sink.

- [ ] **Step 3: Run tests and commit**

```bash
pnpm --filter @gram/observability test
git add packages/observability config/logging.example.yaml
git commit -m "feat: bound and rotate secret-safe logs"
```

---

### Task 7: Add SQLite integrity checking and backup/restore

**Files:**
- Create: `packages/persistence/src/integrity-service.ts`
- Create: `packages/persistence/src/backup-service.ts`
- Test: `packages/persistence/src/integrity-service.test.ts`
- Test: `packages/persistence/src/backup-service.test.ts`
- Create: `scripts/backup-state.sh`
- Create: `scripts/restore-state.sh`
- Create: `docs/operations/backup-restore.md`

**Interfaces:**
- Produces:
  - `IntegrityService.check(): IntegrityResult`
  - `BackupService.create(target): BackupMetadata`

- [ ] **Step 1: Write integrity tests**

Healthy DB returns `ok`. A deliberately corrupted copied fixture returns unhealthy and must prevent normal task scheduling.

- [ ] **Step 2: Write backup round-trip test**

Create DB with tasks/repositories, take a consistent backup, restore into a new path, migrate/check integrity, and assert identities/rows match.

- [ ] **Step 3: Implement online-safe backup**

Use SQLite's supported backup/consistent copy mechanism through the selected driver; never copy only the main `.db` file while active WAL data may exist.

- [ ] **Step 4: Implement restore safety**

Restore script stops agent/tunnel services, snapshots current state, restores requested backup into a new file, runs integrity+migrations, then atomically swaps the DB and restarts services.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/persistence test
git add packages/persistence scripts/backup-state.sh scripts/restore-state.sh docs/operations/backup-restore.md
git commit -m "feat: add sqlite integrity and state backups"
```

---

### Task 8: Add self-diagnostics service

**Files:**
- Create: `packages/observability/src/diagnostics-service.ts`
- Test: `packages/observability/src/diagnostics-service.test.ts`
- Modify: `packages/mcp/src/server.ts`
- Create: `docs/operations/diagnostics.md`

**Interfaces:**
- Produces: MCP `agent_diagnostics` read-only tool and CLI/health diagnostic summary.

- [ ] **Step 1: Define diagnostic checks**

Return structured, secret-safe statuses for:

```text
SQLite integrity
state/log disk usage
worktree disk usage
stale/recovery-blocked locks
MCP loopback bind
internal secret configured
Git CLI
GitHub auth status (boolean/user only, no token)
tunnel-client binary/version/service status
systemd service status
pending NEEDS_RECOVERY tasks
```

- [ ] **Step 2: Write tests ensuring diagnostics never return secret values**

Inject secret-like values in adapter outputs and assert redaction/omission.

- [ ] **Step 3: Implement and register read-only tool**

Diagnostic operations must not mutate repository state or acquire repo mutation locks.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/observability test
pnpm --filter @gram/mcp test
git add packages/observability packages/mcp docs/operations/diagnostics.md
git commit -m "feat: add secret-safe agent diagnostics"
```

---

### Task 9: Add versioned upgrade and rollback workflow

**Files:**
- Create: `scripts/upgrade.sh`
- Create: `scripts/rollback.sh`
- Create: `docs/operations/upgrade-rollback.md`
- Test: `tests/ops/upgrade-contract.test.ts`

**Interfaces:**
- Produces: safe release update procedure preserving state and allowing rollback.

- [ ] **Step 1: Write upgrade contract tests**

Static test requires upgrade sequence:

```text
verify clean agent source checkout
backup state DB
fetch target tag
install frozen dependencies
build/test smoke
stop services
run migrations
switch release
start agent
diagnostics check
start/confirm tunnel
```

Rollback must restore prior source tag and a compatible state backup when migration compatibility requires it.

- [ ] **Step 2: Implement scripts with `set -euo pipefail` and explicit trap handling**

Never run destructive cleanup on failed upgrade. Preserve logs and the pre-upgrade backup path in failure output.

- [ ] **Step 3: Test scripts against a temporary fake release tree**

No system service mutation in unit tests; inject command runner/function hooks or test a dry-run mode.

- [ ] **Step 4: Commit**

```bash
git add scripts/upgrade.sh scripts/rollback.sh docs/operations/upgrade-rollback.md tests/ops/upgrade-contract.test.ts
git commit -m "feat: add safe agent upgrade and rollback"
```

---

### Task 10: Finish one-command WSL bootstrap and operator documentation

**Files:**
- Modify: `scripts/bootstrap-wsl.sh`
- Create: `docs/operations/installation.md`
- Create: `docs/operations/tailscale-admin-network.md`
- Create: `docs/operations/github-authentication.md`
- Create: `docs/operations/secure-mcp-tunnel.md`
- Create: `docs/operations/disaster-recovery.md`

**Interfaces:**
- Produces: reproducible installation and recovery runbooks.

- [ ] **Step 1: Make bootstrap idempotent**

Running twice must not rotate existing secrets, duplicate service files, destroy state, or re-clone existing repositories unexpectedly.

- [ ] **Step 2: Document exact installation sequence**

Installation guide covers:

```text
Windows WSL2 + systemd prerequisites
Node 24 LTS + pnpm
repo clone
pnpm install/build
agent directories/permissions
GitHub auth
restricted OpenAI tunnel runtime key
internal MCP secret
systemd install/enable/start
tunnel-client doctor
ChatGPT connector setup
agent diagnostics
```

- [ ] **Step 3: Document Tailscale only as administration network**

State explicitly that Tailscale is not the ChatGPT MCP transport; OpenAI `tunnel-client` remains the sole MCP tunnel.

- [ ] **Step 4: Document disaster recovery cases**

Include:

```text
agent service fails
OpenAI tunnel service fails
SQLite integrity failure
stale repo lock
NEEDS_RECOVERY task
lost/rotated GitHub credential
lost/rotated tunnel runtime credential
broken upgrade
low disk/worktree pressure
```

- [ ] **Step 5: Run docs/bootstrap contract tests and commit**

```bash
pnpm test -- tests/ops
shellcheck scripts/*.sh
git add scripts/bootstrap-wsl.sh docs/operations
git commit -m "docs: complete gram agent operator runbooks"
```

---

### Task 11: Full v1.0 security and production acceptance

**Files:**
- Create: `docs/operations/v1-acceptance.md`

- [ ] **Step 1: Run complete automated suite**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:concurrency
pnpm test:security
shellcheck scripts/*.sh
```

Expected: PASS.

- [ ] **Step 2: Run threat-model checklist against the target Gram**

For every `SEC-*` invariant in `docs/security/policy-invariants.md`, record PASS with test/reference evidence. Any unresolved Critical/High invariant blocks v1.0.

- [ ] **Step 3: Run a real end-to-end coding task**

The task must modify a disposable private repo, verify, push, release lock before PR, observe CI lock-free, and finish `COMPLETED`.

- [ ] **Step 4: Test restart and backup/restore**

Perform one controlled restart/recovery and one state backup/restore validation on the target WSL environment.

- [ ] **Step 5: Run diagnostics**

Expected final status:

```text
SQLite integrity: healthy
MCP: loopback/authenticated
Tunnel: active
Recovery-blocked repos: 0
NEEDS_RECOVERY tasks: 0
Secret exposure findings: 0
Critical policy test failures: 0
```

- [ ] **Step 6: Commit acceptance and tag v1.0.0**

```bash
git add docs/operations/v1-acceptance.md
git commit -m "docs: record gram coding agent v1 acceptance"
git tag -a v1.0.0 -m "Gram Coding Agent v1.0.0"
git push origin v1.0.0
```
