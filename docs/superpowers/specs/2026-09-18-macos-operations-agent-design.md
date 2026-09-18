# macOS Operations Agent — Working Design

**Status:** DRAFT / design in progress  
**Repository:** `jskjw157/gram-coding-agent`  
**Target:** Apple Silicon macOS, always-on dedicated Mac  
**Date started:** 2026-09-18

> This document records decisions already approved in the design discussion.
> It is intentionally not an implementation plan yet. Open questions remain and implementation must not begin from this document alone.

---

## 1. Product direction

The existing `gram-coding-agent` will evolve from a Windows/WSL-focused coding agent into a **cross-platform operations agent**.

Coding remains a first-class capability, but it is only one module.

The macOS target is intended to run day-to-day HAAR / shopping-mall operations, including:

- storefront and marketplace operations,
- product registration and editing,
- order / CS workflows,
- advertising operations,
- file and Google Drive workflows,
- spreadsheets and CSV processing,
- image / video production workflows,
- email and messaging workflows,
- browser-based operational work,
- site maintenance,
- code changes, testing, deployment, Git and GitHub operations.

The primary interaction remains ChatGPT.

---

## 2. Repository strategy

**Decision:** Keep one repository.

Do not create a separate `mac-coding-agent` repository.

The existing repository becomes multi-platform and shares the same domain, policy, persistence, MCP, Git, GitHub, verification, audit and recovery layers.

Platform-specific capabilities are isolated behind adapters.

---

## 3. Platform architecture

**Decision:** Introduce a Platform Adapter layer.

Conceptual structure:

```text
packages/
  domain/
  persistence/
  policy/
  mcp/
  secrets/
  platform/
    src/
      contracts.ts
      detect.ts
      linux-wsl/
      macos/

platform/
  linux-wsl/
    systemd/
    bootstrap.sh
  macos/
    launchd/
    bootstrap.sh
```

Shared core:

- Task Engine
- SQLite / WAL persistence
- Policy Engine
- MCP
- audit / observability
- Git / GitHub
- worktree lifecycle
- verification
- recovery
- publishing

Platform adapters own OS-specific concerns such as:

- service lifecycle,
- paths,
- opening / revealing files,
- clipboard,
- package management,
- native application integration,
- GUI-session bridging.

---

## 4. macOS support target

**Decision:** Apple Silicon only for the first macOS version.

Intel Mac compatibility is out of scope for the initial implementation.

**Decision:** The primary deployment target is an **always-on dedicated Mac**, not a personal laptop used intermittently.

---

## 5. Runtime account and privilege model

**Decision:** Use a dedicated local account named conceptually `gram-agent`.

Properties:

- local non-admin account,
- dedicated to agent operation,
- separate home directory,
- separate browser and application state,
- separate workspaces, downloads, uploads and secret storage,
- no standing administrator privilege.

Installation/bootstrap may require an administrator account, but long-running processes must run as `gram-agent`.

The agent should not inherit broad access to a human user's personal Desktop, Documents, iCloud Drive or Keychain by default.

---

## 6. launchd model

The macOS deployment replaces the WSL/systemd-specific service layer.

Proposed split:

```text
macOS boot
   |
   +-- background core service
   |     +-- Operations Agent
   |     +-- localhost MCP
   |     +-- Task Engine
   |     +-- persistence
   |     +-- Git / filesystem / API work
   |
   +-- OpenAI tunnel-client service
   |
   +-- logged-in GUI session helper
         +-- browser interaction
         +-- Finder / open / reveal
         +-- clipboard
         +-- screenshots
         +-- native app automation
```

The background core and GUI-session automation are separate trust and capability boundaries.

Exact LaunchDaemon / LaunchAgent topology will be finalized with reboot/login recovery design.

---

## 7. Operations-first capability model

The macOS version is **not** a headless coding-only server.

Major capability groups:

### Core Runtime

- Task Engine / scheduler
- SQLite persistence
- audit / recovery
- Policy Engine
- Secret Provider
- MCP gateway

### Business Adapters

- shopping mall / marketplace APIs
- advertising APIs
- Gmail / Drive / Sheets integrations
- GitHub / deployment
- image / video services
- other business SaaS integrations

### Browser Automation

- navigate
- click
- type
- upload
- download
- read page state
- complete operational browser flows

### macOS GUI Automation

- Finder / native file picker
- open / reveal
- clipboard
- screenshots / vision
- native application interaction

### Coding

- repository discovery
- worktrees
- file editing
- test / build
- commit / push / PR
- CI observation

---

## 8. Automation priority

**Decision:** Prefer structured APIs/connectors before browser or GUI automation.

Priority:

```text
1. API / native connector
2. dedicated typed adapter
3. browser DOM automation
4. native macOS GUI automation
```

Examples:

- use an official marketplace API when available,
- use Gmail / Drive connectors rather than webmail clicking when available,
- use browser automation for services that expose only web UI,
- use native GUI automation only when DOM/API access cannot complete the workflow.

This reduces brittleness and unnecessary exposure to GUI permissions.

---

## 9. Browser execution model

Use a dedicated operational browser environment owned by `gram-agent`.

Do not automate the human user's everyday Chrome profile.

Conceptual storage:

```text
/Users/gram-agent/
  agent/
    state/
    workspaces/
    downloads/
    uploads/
    browser/
      operations-profile/
```

The browser profile is treated as sensitive authentication state.

Browser cookies / local storage must not be copied into Git, task SQLite payloads or audit logs.

---

## 10. Aside + Playwright strategy

**Decision:** Use a layered browser model.

### Primary: Aside

Aside is preferred when available because it can operate against a real logged-in browser state.

### Fallback: Playwright

A dedicated persistent Playwright / Chromium profile provides a second execution path when Aside is unavailable or unsuitable.

Conceptual selection:

```text
Aside READY
  -> use Aside

Aside unavailable / crashed
  -> use persistent Playwright profile

Playwright session not authenticated
  -> attempt safe session recovery

Session cannot be recovered automatically
  -> NEEDS_APPROVAL
```

Exact Aside integration details remain subject to implementation verification.

---

## 11. Session persistence and recovery

**Decision:** Do not depend on one long-lived browser tab or one cookie session.

Use layered recovery:

### Tier 1 — existing browser session

Reuse real browser cookies / local storage when the service session remains valid.

### Tier 2 — persistent fallback browser state

Use the dedicated persistent Playwright profile and safe cookie/session reuse.

### Tier 3 — credential-assisted reauthentication

If the service session expires, a local Credential Broker attempts reauthentication using macOS Keychain-backed credentials where appropriate.

If authentication requires human-presence or an unsupported challenge, transition to `NEEDS_APPROVAL`.

Examples likely requiring approval:

- CAPTCHA,
- passkey / Touch ID,
- device verification,
- unfamiliar-device confirmation,
- unsupported OTP challenge.

---

## 12. macOS Keychain Credential Broker

**Decision:** Use macOS Keychain as a local secret backend for session recovery and operational credentials.

Possible stored credential classes:

- account passwords,
- API tokens,
- refresh tokens,
- app passwords,
- other service-specific secrets.

### Hard security rule

Do **not** expose a generic MCP secret-reading interface.

Forbidden model:

```text
get_password("service")
-> raw password
```

Preferred model:

```text
auth_login(service, account)
-> local broker obtains secret
-> local adapter uses it directly
-> MCP receives only status / redacted evidence
```

Secret values must not appear in:

- ChatGPT responses,
- MCP results,
- audit logs,
- Task records,
- command output retained in SQLite,
- Git commits.

The broker should lease/use credentials for a narrowly scoped operation rather than returning them to generic callers.

---

## 13. Browser/session security

Browser profiles and cookie stores are security-sensitive assets.

Requirements:

- dedicated `gram-agent` ownership,
- restrictive filesystem permissions,
- no Git tracking,
- no raw cookie dumping into diagnostics,
- backup strategy must exclude or encrypt authentication state,
- browser auth state is not considered a substitute for Keychain-based recovery credentials,
- Keychain credentials are not considered permission to bypass MFA / human-presence challenges.

---

## 14. Policy model for business operations

The existing `ALLOW / NEEDS_APPROVAL / DENY` model remains.

Illustrative direction:

### ALLOW candidates

- read product information,
- read orders,
- check inventory,
- read ad reports,
- upload approved assets,
- routine product edits within defined rules,
- normal code/test/build operations.

### NEEDS_APPROVAL candidates

- significant advertising budget changes,
- refunds,
- payments / purchases,
- account security changes,
- bulk destructive edits,
- credential / login changes,
- unusual high-impact publication actions.

### DENY candidates

- account deletion,
- store deletion,
- destructive mass deletion without a separately designed recovery path,
- credential exfiltration,
- attempts to bypass hard platform security boundaries.

Exact thresholds and operation-specific rules will be defined later.

---

## 15. Relationship to existing Windows / WSL architecture

The existing core concepts remain valid:

- stateful Task Engine,
- SQLite WAL,
- task-scoped worktrees,
- same-repo serialization,
- different-repo concurrency,
- branch -> commit -> push -> PR by default,
- explicit direct-main grant only,
- protected-branch force push/delete denied,
- localhost-only MCP,
- OpenAI tunnel-client as remote MCP transport,
- approval-gated high-risk operations,
- audit evidence.

WSL/systemd/Windows-specific implementations become one platform implementation rather than assumptions embedded into the shared core.

---

## 16. Open decisions

The following items are intentionally unresolved:

1. exact LaunchDaemon vs LaunchAgent split for the core/tunnel/helper processes,
2. reboot recovery when no GUI user is logged in,
3. whether the dedicated `gram-agent` account uses automatic login,
4. FileVault implications for unattended reboot,
5. Keychain unlock behavior for unattended operation,
6. macOS TCC permissions:
   - Accessibility,
   - Screen Recording,
   - Automation,
   - Full Disk Access,
   - protected-folder access,
7. exact browser choice and Aside lifecycle ownership,
8. TOTP handling,
9. OTP retrieval paths,
10. GUI automation technology below the browser layer,
11. operational adapters required for the first HAAR vertical slice,
12. business-operation approval thresholds,
13. backup / restore policy for browser state and Keychain references,
14. health checks and self-healing for browser / GUI-session helpers.

---

## 17. Current design gate

This document is a working decision record.

Before implementation begins:

1. resolve the remaining architecture questions,
2. convert this working draft into an approved design specification,
3. self-review the specification for ambiguity / contradictions,
4. obtain explicit user approval,
5. write the implementation plan,
6. only then begin code changes.
