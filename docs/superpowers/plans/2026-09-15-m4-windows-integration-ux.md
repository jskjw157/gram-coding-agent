# M4 Windows Integration & Developer UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe typed Windows integration and privileged system-management conveniences without opening a generic Windows command-execution backdoor, while extending GitHub operations needed for day-to-day ChatGPT-only use.

**Architecture:** Windows functionality is exposed as typed operations (`path`, `open`, `reveal`, `clipboard`) behind a dedicated adapter. Raw `powershell.exe`, `pwsh.exe`, `cmd.exe`, and arbitrary Windows executables continue through the normal shell Policy Engine and remain approval-gated. System operations use explicit typed services for packages/processes/systemd rather than broad root-shell shortcuts.

**Tech Stack:** Existing stack, WSL `wslpath`, Windows Explorer/open integration, fixed PowerShell clipboard adapter where required, systemd, GitHub API/CLI adapter.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Global Constraints

- There is no `windows_exec(command)` API.
- Raw PowerShell/CMD/arbitrary Windows executable invocation remains `NEEDS_APPROVAL` by default.
- Typed Windows integration tools are ALLOW only for their constrained operations.
- Typed adapters must not interpolate MCP input into arbitrary PowerShell source.
- Clipboard is text-only, size-bounded, secret-redacted, and raw clipboard data is not stored in audit logs.
- WSL remains the active development filesystem; Windows paths are convenience views/opens.
- Protected-branch force push/delete remains DENY.
- Dashboard work remains outside the v1 critical path.

---

## File Map

```text
packages/windows-integration/src/
├─ windows-path-service.ts
├─ windows-open-service.ts
├─ windows-reveal-service.ts
├─ windows-clipboard-service.ts
├─ fixed-windows-runner.ts
└─ *.test.ts
packages/system/src/
├─ package-service.ts
├─ process-service.ts
├─ systemd-service.ts
└─ *.test.ts
packages/github/src/
├─ issue-service.ts
├─ pull-request-service.ts
├─ actions-log-service.ts
└─ *.test.ts
packages/mcp/src/tools/
├─ windows-tools.ts
├─ system-tools.ts
└─ github-tools.ts
tests/security/
└─ windows-escape.test.ts
```

---

### Task 1: Implement Windows path conversion service

**Files:**
- Create: `packages/windows-integration/package.json`
- Create: `packages/windows-integration/src/windows-path-service.ts`
- Test: `packages/windows-integration/src/windows-path-service.test.ts`
- Create: `packages/windows-integration/src/index.ts`
- Create: `packages/mcp/src/tools/windows-tools.ts`

**Interfaces:**
- Produces:
  - `WindowsPathService.toWindows(linuxPath: string): Promise<string>`
  - `WindowsPathService.toLinux(windowsPath: string): Promise<string>`
  - MCP `windows_path`.

- [ ] **Step 1: Write conversion tests with a fake fixed runner**

Assert input is passed as a single argument to `wslpath`, not embedded in a shell string.

```ts
expect(await service.toWindows('/home/user/file.txt')).toBe('C:\\fake\\file.txt');
expect(runner.calls[0]).toEqual({ executable: 'wslpath', args: ['-w', '/home/user/file.txt'] });
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @gram/windows-integration test
```

- [ ] **Step 3: Implement conversion using direct process arguments**

Use no `shell: true`. Reject NUL bytes and unbounded path lengths before invocation.

- [ ] **Step 4: Register MCP tool**

Zod schema:

```ts
z.object({ path: z.string().min(1).max(8192), target: z.enum(['windows', 'linux']) })
```

Policy classification for this typed tool is ALLOW.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/windows-integration test
git add packages/windows-integration packages/mcp/src/tools/windows-tools.ts
git commit -m "feat: add safe windows path conversion"
```

---

### Task 2: Implement typed Windows open and reveal operations

**Files:**
- Create: `packages/windows-integration/src/fixed-windows-runner.ts`
- Create: `packages/windows-integration/src/windows-open-service.ts`
- Create: `packages/windows-integration/src/windows-reveal-service.ts`
- Test: `packages/windows-integration/src/windows-open-service.test.ts`
- Test: `packages/windows-integration/src/windows-reveal-service.test.ts`
- Modify: `packages/mcp/src/tools/windows-tools.ts`

**Interfaces:**
- Produces:
  - `WindowsOpenService.openPath(path): Promise<void>`
  - `WindowsOpenService.openUrl(url): Promise<void>` for `http`/`https` only.
  - `WindowsRevealService.revealPath(path): Promise<void>`.

- [ ] **Step 1: Write schema/security tests first**

Reject:

```text
command parameter
file:// URL
shell: URL
ms-settings: URL
javascript: URL
custom protocols
```

Allow only paths and `http://`/`https://` URLs.

- [ ] **Step 2: Implement `FixedWindowsRunner`**

The runner accepts an enum operation and validated arguments, never arbitrary command text:

```ts
type FixedWindowsOperation =
  | { kind: 'OPEN_PATH'; windowsPath: string }
  | { kind: 'REVEAL_PATH'; windowsPath: string }
  | { kind: 'OPEN_URL'; url: string };
```

- [ ] **Step 3: Implement fixed adapters**

Internal implementation may invoke fixed Windows executables such as `explorer.exe` with argument arrays. User-provided strings are arguments only and cannot select an executable or add command switches outside the adapter's fixed construction.

- [ ] **Step 4: Register ALLOW typed tools**

Expose `windows_open` and `windows_reveal`. Audit metadata records normalized target path/URL, never an arbitrary generated command string.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/windows-integration test
git add packages/windows-integration/src packages/mcp/src/tools/windows-tools.ts
git commit -m "feat: add typed windows open and reveal tools"
```

---

### Task 3: Implement text-only clipboard operations

**Files:**
- Create: `packages/windows-integration/src/windows-clipboard-service.ts`
- Test: `packages/windows-integration/src/windows-clipboard-service.test.ts`
- Modify: `packages/mcp/src/tools/windows-tools.ts`

**Interfaces:**
- Produces:
  - `readText(): Promise<ClipboardReadResult>`
  - `writeText(text: string): Promise<void>`
  - MCP `windows_clipboard_read`, `windows_clipboard_write`.

- [ ] **Step 1: Write size and audit tests**

Use a 1 MiB maximum text payload. Assert oversized writes reject. Assert clipboard audit events include character count and result only, not clipboard body.

- [ ] **Step 2: Write secret-redaction test**

If clipboard contains a registered secret or token-shaped value, MCP-visible output must return the redacted representation rather than raw secret text.

- [ ] **Step 3: Implement fixed PowerShell adapter only if needed**

The script body is a code constant owned by the adapter. MCP input is transmitted via stdin or a safely encoded data channel, never string-interpolated into the PowerShell program. The caller cannot change executable, flags, or script source.

- [ ] **Step 4: Keep raw PowerShell policy unchanged**

Add a regression test proving:

```text
windows_clipboard_read() -> ALLOW
shell_run("powershell.exe ...") -> NEEDS_APPROVAL
```

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/windows-integration test
pnpm --filter @gram/policy test
git add packages/windows-integration/src/windows-clipboard-service.ts packages/windows-integration/src/windows-clipboard-service.test.ts packages/mcp/src/tools/windows-tools.ts packages/policy
git commit -m "feat: add redacted windows clipboard tools"
```

---

### Task 4: Add Windows escape security suite

**Files:**
- Create: `tests/security/windows-escape.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: regression proof that typed Windows tools cannot become arbitrary execution.

- [ ] **Step 1: Test malicious path and URL inputs**

Cover quotes, semicolons, newlines, ampersands, pipes, PowerShell subexpressions, `%COMSPEC%`, `$(...)`, UNC paths, and `file:`/custom URI schemes.

- [ ] **Step 2: Assert no operation can choose executable/script**

Runtime schemas must reject fields named `command`, `executable`, `args`, `script`, or equivalent unknown properties because Zod schemas run in strict mode.

- [ ] **Step 3: Test raw Windows executable policy**

```text
powershell.exe -> NEEDS_APPROVAL
pwsh.exe       -> NEEDS_APPROVAL
cmd.exe        -> NEEDS_APPROVAL
notepad.exe    -> NEEDS_APPROVAL by default arbitrary-Windows-executable rule
```

- [ ] **Step 4: Run security suite and commit**

```bash
pnpm test:security
git add tests/security/windows-escape.test.ts package.json
git commit -m "test: prevent windows integration shell escape"
```

---

### Task 5: Implement typed WSL package, process, and systemd services

**Files:**
- Create: `packages/system/package.json`
- Create: `packages/system/src/package-service.ts`
- Create: `packages/system/src/process-service.ts`
- Create: `packages/system/src/systemd-service.ts`
- Test: `packages/system/src/package-service.test.ts`
- Test: `packages/system/src/systemd-service.test.ts`
- Create: `packages/system/src/index.ts`
- Create: `packages/mcp/src/tools/system-tools.ts`

**Interfaces:**
- Produces:
  - `PackageService.installApt(packages: string[]): Promise<void>`
  - `ProcessService.status/start/stop` for task-owned processes.
  - `SystemdService.status/start/stop/restart`; enable/disable remains approval-gated.

- [ ] **Step 1: Write typed-package policy tests**

`apt install jq` via `PackageService` is ALLOW. `apt purge jq` is NEEDS_APPROVAL. Package names must match Debian package-name grammar; shell metacharacters reject at schema validation.

- [ ] **Step 2: Write systemd policy tests**

```text
status/start/stop/restart known service -> ALLOW according to context
systemctl enable/disable                -> NEEDS_APPROVAL
arbitrary unit file edit                -> normal filesystem/system policy, not hidden by this service
```

- [ ] **Step 3: Implement direct argv process execution**

Do not construct `sudo apt install ${userString}` shell strings. Use explicit executable/argument arrays routed through the Policy Engine.

- [ ] **Step 4: Register MCP typed tools**

Expose package install, process management, and safe systemd operations with strict schemas.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/system test
git add packages/system packages/mcp/src/tools/system-tools.ts
git commit -m "feat: add typed wsl system operations"
```

---

### Task 6: Add GitHub issue/PR/check log conveniences

**Files:**
- Create: `packages/github/src/issue-service.ts`
- Modify: `packages/github/src/pull-request-service.ts`
- Create: `packages/github/src/actions-log-service.ts`
- Test: `packages/github/src/issue-service.test.ts`
- Test: `packages/github/src/actions-log-service.test.ts`
- Modify: `packages/mcp/src/tools/github-tools.ts`

**Interfaces:**
- Produces:
  - issue get/search,
  - PR get/update/comment,
  - Actions/check log retrieval.

- [ ] **Step 1: Write credential-boundary tests**

Assert GitHub credentials are requested only inside GitHub adapter execution and never copied into `CommandRunner` global env or task metadata.

- [ ] **Step 2: Implement issue read/search**

Return structured issue ID/number/title/state/labels/body excerpt. Do not mix issue reads with Task mutation automatically.

- [ ] **Step 3: Implement PR update/comment**

Updates are idempotent where possible and record audit events.

- [ ] **Step 4: Implement Actions/check log retrieval**

Read-only. No repository lock dependency.

- [ ] **Step 5: Test and commit**

```bash
pnpm --filter @gram/github test
git add packages/github packages/mcp/src/tools/github-tools.ts
git commit -m "feat: extend github issue and ci tooling"
```

---

### Task 7: Implement explicit direct-main grants

**Files:**
- Modify: `packages/domain/src/task.ts`
- Modify: `packages/policy/src/policy-engine.ts`
- Modify: `packages/publishing/src/publishing-service.ts`
- Test: `packages/publishing/src/direct-main.test.ts`

**Interfaces:**
- Produces: a task-scoped explicit grant that allows a normal push to a protected main branch while still denying history rewrite/delete.

- [ ] **Step 1: Write direct-main tests**

```text
PULL_REQUEST task -> push origin main => NEEDS_APPROVAL
DIRECT_MAIN task with explicit grant -> normal push origin main => ALLOW
either mode -> --force main => DENY
either mode -> delete main => DENY
```

- [ ] **Step 2: Store explicit grant on task creation**

The grant must derive from the user's explicit request and be persisted as a task capability, not inferred from agent preference.

- [ ] **Step 3: Keep remote-confirm/release invariant unchanged**

Direct-main flow:

```text
verify -> commit -> push main -> remote confirm -> release repo lock -> complete/CI observe
```

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @gram/publishing test
pnpm --filter @gram/policy test
git add packages/domain packages/policy packages/publishing
git commit -m "feat: support explicit direct main publishing grants"
```

---

### Task 8: M4 acceptance

**Files:**
- Create: `docs/operations/m4-windows-acceptance.md`

- [ ] **Step 1: Run normal repository verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:security
```

- [ ] **Step 2: Run on the target Windows/WSL machine**

Verify:

```text
windows_path converts a live worktree path
windows_open opens one approved test path
windows_reveal selects one approved test file
clipboard read/write round-trip works with non-secret text
raw powershell still pauses for approval
```

- [ ] **Step 3: Record acceptance and commit**

```bash
git add docs/operations/m4-windows-acceptance.md
git commit -m "docs: record windows integration acceptance"
```
