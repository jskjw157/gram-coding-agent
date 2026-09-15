# M0–M1 Foundation & Secure Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the private `gram-coding-agent` repository, establish the TypeScript monorepo and GitHub backlog, persist core state in SQLite, expose an authenticated loopback-only MCP server, run OpenAI `tunnel-client` as the sole MCP tunnel, and enforce the first security-policy boundary.

**Architecture:** One deployable Node.js service contains strongly separated packages. SQLite is the durable state store; the MCP transport package only adapts tool calls into application services. `gram-coding-agent` and OpenAI `tunnel-client` run as separate systemd units, with the agent listening only on loopback and rejecting requests that lack the internal shared-secret header.

**Tech Stack:** Node.js 24 LTS, pnpm workspaces, TypeScript 6+, Vitest, ESLint, Prettier, `@modelcontextprotocol/server` v2, `@modelcontextprotocol/node`, `better-sqlite3`, `uuid`, Zod, systemd, OpenAI `tunnel-client`.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Global Constraints

- Target runtime is Windows 11 LG Gram + WSL2 Ubuntu.
- Main implementation is TypeScript / Node.js.
- Architecture is a modular monolith + internal workers.
- SQLite runs in WAL mode with foreign keys enabled.
- Canonical Task ID is UUIDv7; display sequence is human-facing only.
- MCP binds to loopback only.
- OpenAI `tunnel-client` is the sole ChatGPT MCP tunnel implementation.
- Long-running runtime stores no tunnel administration credential.
- Raw PowerShell/CMD execution is approval-gated.
- Protected-branch force push/delete is denied.
- M0 architecture issues #7–#12 represent already-completed design work and must be marked Done when the backlog is created.
- No dashboard work is part of this plan.

---

## File Map

The following files are created in this plan and establish the stable project boundaries used by later plans.

```text
.
├─ .github/
│  ├─ workflows/ci.yml
│  ├─ ISSUE_TEMPLATE/config.yml
│  └─ pull_request_template.md
├─ apps/agent/
│  ├─ package.json
│  ├─ src/main.ts
│  └─ src/main.test.ts
├─ packages/domain/
│  └─ src/{index.ts,task.ts,policy.ts}
├─ packages/persistence/
│  ├─ src/{database.ts,migrator.ts,index.ts}
│  ├─ src/migrations/001_initial.sql
│  └─ src/repositories/{task-repository.ts,task-repository.test.ts,audit-repository.ts}
├─ packages/secrets/
│  └─ src/{secret-provider.ts,file-secret-provider.ts,redactor.ts,redactor.test.ts,index.ts}
├─ packages/observability/
│  └─ src/{logger.ts,health-service.ts,index.ts}
├─ packages/policy/
│  └─ src/{command-parser.ts,risk-classifier.ts,policy-engine.ts,approval-service.ts,index.ts,policy-engine.test.ts}
├─ packages/mcp/
│  └─ src/{server.ts,auth.ts,auth.test.ts,index.ts}
├─ config/
│  ├─ agent.example.yaml
│  └─ tunnel-client.example.yaml
├─ scripts/
│  ├─ bootstrap-wsl.sh
│  └─ github-backlog.sh
├─ systemd/
│  ├─ gram-coding-agent.service
│  └─ openai-mcp-tunnel.service
├─ AGENTS.md
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.mjs
├─ prettier.config.mjs
└─ vitest.workspace.ts
```

---

### Task 1: Create the private repository, GitHub Project backlog, and monorepo baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `prettier.config.mjs`
- Create: `vitest.workspace.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `AGENTS.md`
- Create: `scripts/github-backlog.sh`

**Interfaces:**
- Consumes: approved architecture spec.
- Produces: pnpm monorepo; `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; GitHub Project/milestone/issue bootstrap commands.

- [ ] **Step 1: Create the private GitHub repository and default branch**

Run from an authenticated GitHub CLI session:

```bash
gh repo create gram-coding-agent --private --clone --description "ChatGPT-controlled WSL2 coding agent with secure MCP transport"
cd gram-coding-agent
git branch -M main
git push -u origin main
```

Expected: private repository exists and `main` is the default working branch.

- [ ] **Step 2: Add the root workspace manifest**

Create `package.json`:

```json
{
  "name": "gram-coding-agent",
  "private": true,
  "packageManager": "pnpm@10",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run --workspace vitest.workspace.ts",
    "test:watch": "vitest --workspace vitest.workspace.ts"
  },
  "devDependencies": {
    "@eslint/js": "latest",
    "@types/node": "latest",
    "eslint": "latest",
    "prettier": "latest",
    "typescript": "^6.0.0",
    "typescript-eslint": "latest",
    "vitest": "latest"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

- [ ] **Step 3: Add TypeScript, lint, format, and Vitest workspace configuration**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"],
    "skipLibCheck": true
  }
}
```

Create `vitest.workspace.ts`:

```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace(['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts']);
```

Use flat ESLint config with TypeScript strict rules and Prettier only for formatting; do not mix formatting rules into ESLint.

- [ ] **Step 4: Add CI baseline**

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 5: Add repository operating instructions**

Create `AGENTS.md` with these mandatory rules:

```markdown
# Gram Coding Agent Development Rules

- Read the architecture spec before architectural changes.
- Use TDD for behavior changes.
- Keep package boundaries from the spec; do not import application orchestration into adapters.
- Never add a generic Windows command-execution API.
- Never bind MCP to 0.0.0.0.
- OpenAI tunnel-client is the only MCP tunnel implementation.
- Never store secrets in SQLite, Git, logs, or MCP responses.
- Do not hold the repository mutation lock while creating PRs or observing CI.
- A remote push must be confirmed before releasing the repository lock.
```

- [ ] **Step 6: Create backlog bootstrap script**

Create `scripts/github-backlog.sh` that uses `gh api` for milestone CRUD, `gh issue create` for issues, and `gh project`/GraphQL for Project v2 fields/items to create M0–M5, Project fields, epics, and implementation issues from the approved backlog. Include explicit commands to close/mark Done the six design issues:

```text
#7  Write complete architecture specification
#8  Define SQLite schema and migrations
#9  Define MCP tool contracts
#10 Define Policy Engine rule specification
#11 Define task state machine
#12 Define vertical-slice acceptance criteria
```

The script must be idempotent by title lookup: rerunning it must reuse existing milestones/issues instead of duplicating them.

- [ ] **Step 7: Install dependencies and run baseline checks**

Run:

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs prettier.config.mjs vitest.workspace.ts .github AGENTS.md scripts/github-backlog.sh pnpm-lock.yaml
git commit -m "chore: bootstrap gram coding agent repository"
```

---

### Task 2: Define domain primitives and Task identity contracts

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/vitest.config.ts`
- Create: `packages/domain/src/task.ts`
- Create: `packages/domain/src/policy.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/task.test.ts`

**Interfaces:**
- Consumes: no runtime adapters.
- Produces:
  - `type TaskId = string`
  - `type TaskStatus = ...`
  - `type PublishMode = 'PULL_REQUEST' | 'DIRECT_MAIN'`
  - `createTaskId(): TaskId`
  - `formatTaskSequence(seq: number): string`
  - `canTransitionTaskStatus(from, to): boolean`
  - `type PolicyDecisionKind = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY'`

- [ ] **Step 1: Write failing UUIDv7 and display-sequence tests**

```ts
import { describe, expect, it } from 'vitest';
import { createTaskId, formatTaskSequence } from './task.js';

it('creates RFC9562 version 7 task ids', () => {
  const id = createTaskId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('formats a stable human sequence', () => {
  expect(formatTaskSequence(201)).toBe('TASK-000201');
});
```

- [ ] **Step 2: Run the tests and verify failure**

```bash
pnpm --filter @gram/domain test
```

Expected: FAIL because `createTaskId` and `formatTaskSequence` are missing.

- [ ] **Step 3: Implement Task ID and lifecycle types**

Use `uuid`'s RFC9562 v7 implementation:

```ts
import { v7 as uuidv7 } from 'uuid';

export type TaskId = string;
export type PublishMode = 'PULL_REQUEST' | 'DIRECT_MAIN';
export type TaskStatus =
  | 'QUEUED'
  | 'WAITING_REPO_LOCK'
  | 'PREPARING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'PUBLISHING'
  | 'NEEDS_APPROVAL'
  | 'NEEDS_RECOVERY'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED';

export const createTaskId = (): TaskId => uuidv7();
export const formatTaskSequence = (seq: number): string => `TASK-${String(seq).padStart(6, '0')}`;
```

Add an explicit transition map and `canTransitionTaskStatus` rather than accepting arbitrary string transitions.

- [ ] **Step 4: Define policy domain contracts**

```ts
export type PolicyDecisionKind = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  ruleId: string;
  reason: string;
  operationHash: string;
}
```

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm --filter @gram/domain test
pnpm --filter @gram/domain typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain package.json pnpm-lock.yaml
git commit -m "feat: define task and policy domain primitives"
```

---

### Task 3: Create SQLite schema, migrator, and atomic Task allocation

**Files:**
- Create: `packages/persistence/package.json`
- Create: `packages/persistence/tsconfig.json`
- Create: `packages/persistence/vitest.config.ts`
- Create: `packages/persistence/src/database.ts`
- Create: `packages/persistence/src/migrator.ts`
- Create: `packages/persistence/src/migrations/001_initial.sql`
- Create: `packages/persistence/src/repositories/task-repository.ts`
- Test: `packages/persistence/src/repositories/task-repository.test.ts`
- Create: `packages/persistence/src/repositories/audit-repository.ts`
- Create: `packages/persistence/src/index.ts`

**Interfaces:**
- Consumes: `TaskId`, `TaskStatus`, `PublishMode` from `@gram/domain`.
- Produces:
  - `openDatabase(path: string): Database.Database`
  - `runMigrations(db): void`
  - `TaskRepository.create(input): StoredTask`
  - `TaskRepository.get(id: TaskId): StoredTask | null`
  - `TaskRepository.transition(id, expectedFrom, to): void`
  - `AuditRepository.append(event): void`

- [ ] **Step 1: Write failing tests for WAL, foreign keys, UUID storage, and atomic display sequence**

Create two repository instances against one temporary SQLite file and create 100 tasks interleaved. Assert:

```ts
expect(new Set(tasks.map((t) => t.id)).size).toBe(100);
expect(new Set(tasks.map((t) => t.seq)).size).toBe(100);
expect(tasks.map((t) => t.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
```

Also assert:

```sql
PRAGMA journal_mode;
-- wal
PRAGMA foreign_keys;
-- 1
```

- [ ] **Step 2: Run the persistence test and verify failure**

```bash
pnpm --filter @gram/persistence test
```

Expected: FAIL because database/migration/repository code is absent.

- [ ] **Step 3: Create the initial schema**

`001_initial.sql` must create all spec tables now so later plans do not reshape core identities:

```sql
CREATE TABLE IF NOT EXISTS task_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_value INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO task_sequence(singleton, next_value) VALUES (1, 1);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  goal TEXT NOT NULL,
  repo_id INTEGER,
  status TEXT NOT NULL,
  task_type TEXT NOT NULL,
  publish_mode TEXT NOT NULL,
  base_branch TEXT,
  working_branch TEXT,
  base_commit TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  failure_class TEXT,
  failure_message TEXT,
  result_code TEXT,
  result_summary TEXT
) STRICT;
```

The same migration must create: `task_steps`, `command_runs`, `repositories`, `repo_locks`, `workspaces`, `verification_plans`, `verification_checks`, `git_commits`, `pull_requests`, `ci_runs`, `policy_decisions`, `approvals`, `audit_events`, with foreign keys matching the approved spec.

- [ ] **Step 4: Open SQLite with mandatory pragmas**

```ts
import Database from 'better-sqlite3';

export function openDatabase(path: string): Database.Database {
  const db = new Database(path, { timeout: 5_000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
```

- [ ] **Step 5: Implement atomic sequence allocation**

Use one immediate transaction:

```ts
const allocate = db.transaction(() => {
  const row = db.prepare('SELECT next_value FROM task_sequence WHERE singleton = 1').get() as { next_value: number };
  db.prepare('UPDATE task_sequence SET next_value = ? WHERE singleton = 1').run(row.next_value + 1);
  return row.next_value;
});
```

Create UUIDv7 outside or inside the same application operation; the database transaction guarantees display-sequence uniqueness.

- [ ] **Step 6: Implement guarded status transition**

`transition(id, expectedFrom, to)` must update with:

```sql
UPDATE tasks
SET status = ?, updated_at = ?
WHERE id = ? AND status = ?;
```

If `changes !== 1`, throw `ConcurrentTaskTransitionError` rather than silently overwriting state.

- [ ] **Step 7: Run persistence tests**

```bash
pnpm --filter @gram/persistence test
pnpm --filter @gram/persistence typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/persistence package.json pnpm-lock.yaml
git commit -m "feat: add sqlite state model and task allocation"
```

---

### Task 4: Add configuration, secret providers, and redaction

**Files:**
- Create: `packages/secrets/package.json`
- Create: `packages/secrets/src/secret-provider.ts`
- Create: `packages/secrets/src/file-secret-provider.ts`
- Create: `packages/secrets/src/redactor.ts`
- Test: `packages/secrets/src/redactor.test.ts`
- Create: `packages/secrets/src/index.ts`
- Create: `config/agent.example.yaml`

**Interfaces:**
- Produces:
  - `SecretProvider.getForUse(name: CredentialName): Promise<SecretLease>` for internal adapters only.
  - `SecretRedactor.redact(text: string): string`
  - no public/MCP secret-read interface.

- [ ] **Step 1: Write redaction tests**

```ts
it('redacts registered exact secrets and token-shaped values', () => {
  const redactor = new SecretRedactor(['super-secret-value']);
  expect(redactor.redact('x super-secret-value y')).toBe('x ***REDACTED*** y');
  expect(redactor.redact('Authorization: Bearer sk-test-1234567890')).not.toContain('sk-test-1234567890');
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/secrets test
```

- [ ] **Step 3: Implement file-backed secret references with strict permissions**

Secret files live below `~/.config/gram-coding-agent/secrets/`, are loaded on demand, and are required to have mode `0600` or stricter. Return a lease object that exposes the value only to internal adapter code and supports explicit disposal.

- [ ] **Step 4: Implement redaction before any log sink**

Redaction must happen in-memory before strings reach `console`, file logs, SQLite metadata, or MCP responses.

- [ ] **Step 5: Add non-secret config example**

`config/agent.example.yaml`:

```yaml
mcp:
  host: 127.0.0.1
  port: 3847
state:
  database: ~/.gram-agent/state/agent.db
  logs: ~/.gram-agent/logs
workspace:
  baseRepositories: ~/workspace/github
  worktrees: ~/.gram-agent/worktrees
policy:
  protectedBranches: [main, master]
```

- [ ] **Step 6: Test and commit**

```bash
pnpm --filter @gram/secrets test
pnpm --filter @gram/secrets typecheck
git add packages/secrets config/agent.example.yaml
git commit -m "feat: add secret isolation and output redaction"
```

---

### Task 5: Implement authenticated loopback-only MCP server

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/src/auth.ts`
- Test: `packages/mcp/src/auth.test.ts`
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/index.ts`

**Interfaces:**
- Consumes: an application-service registry supplied by `apps/agent`.
- Produces: `createMcpHttpServer({ host, port, internalSecret, tools }): Promise<RunningMcpServer>`.

- [ ] **Step 1: Write authentication tests before server code**

Use an ephemeral loopback port and assert:

```ts
expect((await request('/mcp')).status).toBe(401);
expect((await request('/mcp', { 'x-gram-agent-auth': 'wrong' })).status).toBe(401);
expect((await request('/mcp', { 'x-gram-agent-auth': secret })).status).not.toBe(401);
```

Also assert server configuration rejects `host: '0.0.0.0'`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/mcp test
```

- [ ] **Step 3: Implement constant-time shared-secret comparison**

Use `crypto.timingSafeEqual` after comparing buffer lengths. Never log the supplied header value.

- [ ] **Step 4: Build MCP server with the stable v2 packages**

Use `@modelcontextprotocol/server` and the official Node transport adapter. Register only a temporary `agent_health` tool in M1; the actual coding tools arrive in M2.

The HTTP listener must validate:

```ts
if (host !== '127.0.0.1' && host !== '::1') {
  throw new Error('MCP server must bind to loopback');
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @gram/mcp test
pnpm --filter @gram/mcp typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp package.json pnpm-lock.yaml
git commit -m "feat: add authenticated loopback mcp server"
```

---

### Task 6: Implement Policy Engine v1 and approval boundary

**Files:**
- Create: `packages/policy/package.json`
- Create: `packages/policy/src/command-parser.ts`
- Create: `packages/policy/src/risk-classifier.ts`
- Create: `packages/policy/src/policy-engine.ts`
- Create: `packages/policy/src/approval-service.ts`
- Test: `packages/policy/src/policy-engine.test.ts`
- Create: `packages/policy/src/index.ts`

**Interfaces:**
- Consumes: `PolicyDecision` from `@gram/domain` and persistence ports for decisions/approvals.
- Produces:
  - `PolicyEngine.evaluate(operation: NormalizedOperation, context: PolicyContext): PolicyDecision`
  - `normalizeShellCommand(command: string, cwd: string): NormalizedOperation[]`
  - `ApprovalService.approve(approvalId, operationHash): void`

- [ ] **Step 1: Write the rule-matrix tests first**

Cover at minimum:

```ts
expect(decide('git status')).toBe('ALLOW');
expect(decide('pnpm test')).toBe('ALLOW');
expect(decide('sudo apt install jq')).toBe('ALLOW');
expect(decide('powershell.exe -Command Get-ChildItem')).toBe('NEEDS_APPROVAL');
expect(decide('pwsh.exe -Command Get-ChildItem')).toBe('NEEDS_APPROVAL');
expect(decide('cmd.exe /c dir')).toBe('NEEDS_APPROVAL');
expect(decide('git reset --hard HEAD~1')).toBe('NEEDS_APPROVAL');
expect(decide('git clean -fdx')).toBe('NEEDS_APPROVAL');
expect(decide('rm -rf /')).toBe('DENY');
expect(decide('git push --force origin main')).toBe('DENY');
expect(decide('git push --force-with-lease origin main')).toBe('DENY');
```

Add composition cases:

```ts
expect(decide('git status && rm -rf /')).toBe('DENY');
expect(decide('echo ok; powershell.exe -Command whoami')).toBe('NEEDS_APPROVAL');
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @gram/policy test
```

- [ ] **Step 3: Parse composed shell operations rather than raw-regex matching**

The parser must preserve operator boundaries (`&&`, `||`, `;`, pipeline, subshell) and return one normalized operation per executable invocation. The overall decision is the maximum risk of all contained operations.

- [ ] **Step 4: Canonicalize path-sensitive operations**

Resolve relative filesystem targets against `cwd`, call `realpath` for existing paths, and retain both requested and canonical paths for audit. A path-resolution failure on a destructive operation defaults to `NEEDS_APPROVAL`, never ALLOW.

- [ ] **Step 5: Bind approvals to SHA-256 operation hashes**

Hash normalized operation type + executable + normalized arguments + canonical targets + task ID. `ApprovalService` must reject reuse when the recomputed hash differs.

- [ ] **Step 6: Run the full policy suite and commit**

```bash
pnpm --filter @gram/policy test
pnpm --filter @gram/policy typecheck
git add packages/policy
git commit -m "feat: enforce command and approval policy"
```

---

### Task 7: Add observability and application bootstrap

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/logger.ts`
- Create: `packages/observability/src/health-service.ts`
- Create: `packages/observability/src/index.ts`
- Create: `apps/agent/package.json`
- Create: `apps/agent/tsconfig.json`
- Create: `apps/agent/vitest.config.ts`
- Create: `apps/agent/src/main.ts`
- Test: `apps/agent/src/main.test.ts`

**Interfaces:**
- Produces: application composition root and `/healthz`/MCP `agent_health` status.

- [ ] **Step 1: Write a composition-root smoke test**

Create a temporary state directory and internal secret, start the app on port `0`, assert the MCP listener is loopback-only and health returns:

```json
{ "status": "healthy", "database": "ok", "mcp": "ready" }
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/agent test
```

- [ ] **Step 3: Implement secret-safe structured logger**

Every logger call passes through `SecretRedactor`. Metadata values are recursively redacted before serialization.

- [ ] **Step 4: Compose configuration, database, repositories, health, policy, and MCP**

`main.ts` is the composition root only. It must not contain SQL, policy rules, or MCP tool business logic.

- [ ] **Step 5: Handle SIGTERM/SIGINT gracefully**

Shutdown order:

```text
stop accepting MCP requests
-> stop background timers
-> close MCP HTTP server
-> close SQLite
-> exit 0
```

- [ ] **Step 6: Run smoke test and commit**

```bash
pnpm --filter @gram/agent test
pnpm test
pnpm typecheck
git add apps/agent packages/observability
git commit -m "feat: compose secure agent runtime"
```

---

### Task 8: Install OpenAI tunnel-client as the sole MCP tunnel and create systemd units

**Files:**
- Create: `config/tunnel-client.example.yaml`
- Create: `systemd/gram-coding-agent.service`
- Create: `systemd/openai-mcp-tunnel.service`
- Create: `scripts/bootstrap-wsl.sh`
- Create: `docs/operations/tunnel-setup.md`
- Test: `tests/ops/systemd-contract.test.ts`

**Interfaces:**
- Consumes: loopback MCP URL and internal secret file.
- Produces: boot-persistent agent and OpenAI tunnel-client services.

- [ ] **Step 1: Write a static systemd contract test**

Test must read both unit files and assert:

```ts
expect(agentUnit).toContain('Restart=on-failure');
expect(tunnelUnit).toContain('Restart=on-failure');
expect(tunnelUnit).toContain('After=gram-coding-agent.service');
expect(tunnelUnit).not.toContain('OPENAI_ADMIN_KEY');
```

Also assert `config/tunnel-client.example.yaml` targets `http://127.0.0.1:3847` and references the internal auth header via an environment/file secret reference rather than a literal secret.

- [ ] **Step 2: Verify the test fails before files exist**

```bash
pnpm test -- tests/ops/systemd-contract.test.ts
```

- [ ] **Step 3: Add tunnel-client configuration**

The example must require exactly:

```text
CONTROL_PLANE_TUNNEL_ID
CONTROL_PLANE_API_KEY
GRAM_MCP_INTERNAL_SECRET_FILE
```

Document that the runtime API key is Restricted with Tunnels Read + Use, and that an Admin key is never installed on the Gram long-lived service.

- [ ] **Step 4: Add systemd service units**

`gram-coding-agent.service` runs the built Node application under the dedicated Linux user.

`openai-mcp-tunnel.service` runs `tunnel-client run --config /etc/gram-coding-agent/tunnel-client.yaml`, starts after the agent, and uses an EnvironmentFile containing only runtime references.

- [ ] **Step 5: Add WSL bootstrap script**

`bootstrap-wsl.sh` must:

```text
verify WSL/systemd
verify Node 24
verify pnpm
create ~/.gram-agent directories
create ~/.config/gram-coding-agent/secrets with mode 0700
generate internal MCP secret if absent
install service files
reload systemd
```

It must not create or request an OpenAI Admin key.

- [ ] **Step 6: Verify tunnel configuration with the official client**

On the target Gram after credentials are installed:

```bash
tunnel-client --version
tunnel-client doctor --config /etc/gram-coding-agent/tunnel-client.yaml --explain
systemctl status gram-coding-agent
systemctl status openai-mcp-tunnel
```

Expected: doctor succeeds, agent is healthy, tunnel service is active.

- [ ] **Step 7: Run all repository checks and commit**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git add config systemd scripts/bootstrap-wsl.sh docs/operations tests/ops
git commit -m "feat: add openai secure mcp tunnel runtime"
```

---

### Task 9: Validate M0–M1 acceptance and synchronize GitHub backlog status

**Files:**
- Modify: `scripts/github-backlog.sh`
- Create: `docs/operations/m0-m1-acceptance.md`

**Interfaces:**
- Produces: auditable M0–M1 acceptance record and Project issue states.

- [ ] **Step 1: Run the complete local verification**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Run the security acceptance matrix**

Execute policy tests proving:

```text
powershell.exe       NEEDS_APPROVAL
pwsh.exe             NEEDS_APPROVAL
cmd.exe              NEEDS_APPROVAL
rm -rf /             DENY
git push --force main DENY
MCP missing secret   401
MCP wrong secret     401
MCP loopback bind    PASS
```

- [ ] **Step 3: Verify runtime on WSL2**

```bash
systemctl is-active gram-coding-agent
systemctl is-active openai-mcp-tunnel
curl -fsS http://127.0.0.1:3847/healthz
```

Expected: both services active and health is successful.

- [ ] **Step 4: Update GitHub Project**

Run `scripts/github-backlog.sh --sync-status`. It must mark architecture issues #7–#12 Done, and mark implemented M0/M1 issues Done only when their acceptance checks have evidence.

- [ ] **Step 5: Commit acceptance record**

```bash
git add docs/operations/m0-m1-acceptance.md scripts/github-backlog.sh
git commit -m "docs: record secure runtime acceptance"
```
