# macOS Operations Agent — Working Design

**Status:** DRAFT / written-spec review pending; not an implementation plan  
**Repository:** `jskjw157/gram-coding-agent`  
**Design branch:** `docs/macos-operations-agent-design`  
**Target:** Apple Silicon macOS, always-on dedicated Mac  
**Date started:** 2026-09-18  
**Last reviewed:** 2026-09-20 (Asia/Seoul)

This revision preserves the agreed product direction and incorporates the reboot/session discussion. It separates user-approved direction, verified repository facts, external platform constraints, and proposed implementation details. Approval of the overall direction does not mean that the Mac runtime exists or that every provider integration has been verified.

## 1. Product direction

Evolve the existing repository into a cross-platform operations agent for HAAR shopping-mall operations. Coding is one capability, not the product boundary. The primary interaction remains ChatGPT.

The intended scope includes storefront/marketplace operations, product registration and editing, orders/CS, advertising, email/messaging, Drive/files, spreadsheets/CSV, image/video workflows, browser/native-app automation, and code/site maintenance including tests, deployment and GitHub.

Do not reinterpret the project as a headless coding-only server. Deliver this broad scope through independently reviewable capability increments, not one all-or-nothing implementation.

## 2. Repository and branch strategy

**Approved:** one repository, shared core, platform-specific adapters. No separate Mac repository or permanent fork of the Windows core.

Current work is documentation-only on `docs/macos-operations-agent-design`. Leave `main` and `feat/m2-vertical-slice` unchanged. Open a separate draft design PR; do not merge, rebase, force-push, or close the Windows PR from this workflow.

After written design and implementation-plan review, use short-lived feature branches based on the then-current reviewed `main`. Any change to shared M2 contracts waits for their integration, or requires an explicitly reviewed dependency-extraction plan. Do not silently cherry-pick the unmerged M2 implementation.

The branch separates development; the folders remain after PR merge. A local implementation checkout should use a separate worktree so it cannot disturb a Windows development checkout.

## 3. Platform architecture

**Approved:** Platform Adapter boundaries. This is a target structure, not existing folders:

```text
packages/
  domain/                 shared identity and task contracts
  persistence/            shared durable state
  policy/                 shared authorization and approvals
  mcp/                    shared gateway
  secrets/                credential-use contracts
  platform/src/
    contracts.ts
    detect.ts
    linux-wsl/
    macos/
platform/
  linux-wsl/               eventual systemd/bootstrap home
  macos/                  launchd/bootstrap
```

Reuse Task Engine, audit, Git/GitHub, verification and recovery as they become available. Add business/browser/native-app capabilities behind ports; do not import orchestration into platform adapters.

Do not move existing `systemd/` or `scripts/bootstrap-wsl.sh` in the first Mac change. Add Mac files first; any later WSL relocation must update its installers, docs and tests together in a separate PR.

## 4. macOS support target

**Approved:** Apple Silicon, always-on dedicated Mac. Intel compatibility is outside the initial target.

The exact target macOS build, installed Aside version, runtime paths and native dependency support have not been inspected on the real Mac. Record them during bootstrap validation; do not infer them from a browser user-agent. Native runtime support and recovery features have separate compatibility checks.

## 5. Runtime account and privilege model

**Approved:** dedicated local non-admin `gram-agent` account, separate browser/application state and workspaces. Administrator participation is for installation or explicitly approved system changes, not standing root privileges for the agent.

Application approval does not itself grant OS authorization. Do not add broad passwordless sudo or give the runtime permission to rewrite its own privileged launchd configuration.

A dedicated account separates personal data, but is not a sandbox between processes running as that account. Repository scripts must not inherit browser credentials or gain access to broker secrets merely because they share a user ID. Executor isolation and authenticated broker IPC are required security design work before real store credentials are onboarded; environment filtering alone is not proof of isolation.

## 6. launchd model and capability boundary

**Agreed direction:** background core/tunnel plus a logged-in user-session helper.

```text
authenticated data-volume unlock
  -> LaunchDaemon: core, running as gram-agent
  -> LaunchDaemon: tunnel, running as gram-agent
  -> core recovery and non-GUI capabilities

actual gram-agent GUI login
  -> LaunchAgent: browser/native helper
  -> user credential/vault availability checks
  -> browser session checks
  -> eligible GUI/browser work
```

These are separate capability boundaries. The helper receives typed, scoped requests through authenticated local IPC; it must not expose an unrestricted shell, script, or secret-reading endpoint. Installation files and executable identity need tamper-resistant ownership.

Missing GUI login, locked screen, missing TCC permission, locked vault, disconnected browser and expired website authentication are different conditions. A process being alive does not prove a workflow is runnable.

## 7. Operations-first capability model

Keep these groups separate: core runtime/scheduler; business adapters; browser automation; macOS GUI automation; coding.

A non-coding task must not need a fabricated repository, Git branch or PR. Coding tasks retain UUIDv7 identity, atomic display sequence, worktree isolation and existing publishing rules. Proposed future task extensions must remain backward compatible with the current coding API and database migrations.

Browser/account resource leases are not Repo Locks. Serialize incompatible mutations against the same store/account/profile, and release a browser lease before waiting for a human challenge. Reconcile the page and account again on resume.

Each machine owns its own local state. Do not share a live SQLite file or browser profile between the Gram and Mac. Cross-machine mutation coordination is not implemented; initially assign a single writer for each live operational account/resource.

## 8. Automation priority

**Approved:** API/connector first, typed local adapter next, browser DOM automation next, native GUI last.

ChatGPT-connected Gmail/Drive or other plugins are not automatically callable by an unattended local daemon. Connector-executed steps and locally implemented OAuth/API steps must be distinguished. Do not assume that a disconnected ChatGPT conversation can keep choosing new actions or that a browser subagent consumes no separate provider entitlement.

Without an active reasoning client, only already-authorized deterministic local workflows may continue. An ambiguous step stops for reconnection or human input. No additional paid AI API dependency is introduced by this design.

## 9. Browser execution model

Use dedicated `gram-agent` operational browser state, never the person's daily browsing profile.

Conceptual storage, subject to bootstrap path validation:

```text
/Users/gram-agent/agent/
  state/
  workspaces/
  uploads/
  downloads/
  browser/
    aside/                logical reference to Aside-owned state
    playwright/           separate persistent profile
```

The Aside path is not a promise that its physical profile location is configurable. Discover provider-owned locations through supported mechanisms.

Only one owning browser process may use a given profile directory. Aside and Playwright do not concurrently open the same profile. Browser profiles/auth state are sensitive, excluded from Git, task payloads and ordinary diagnostics. [P1]

## 10. Aside + Playwright strategy

**Approved preference:** Aside primary when healthy and capable; dedicated persistent Playwright fallback; native GUI for steps not supported by APIs/DOM.

Aside's official documentation describes CLI, MCP and REPL interfaces, including continuing an agent session with `--session`. That does not establish the lifetime of every REPL object, compatibility with every Playwright API, or post-crash resumability. Probe the installed version and expose a capability/health result before routing. [A1]

Use the local Aside integration behind the existing gateway/policy boundary. Do not expose a second remote tunnel or treat Aside's nested task permissions as a replacement for our approval policy.

A provider switch is an execution fallback, not an authentication guarantee. Recheck account/store identity, login state and last observed side effects before resuming. Stop when equivalent account/domain permissions cannot be enforced.

## 11. Session persistence and recovery

Track four independent layers: ChatGPT/MCP connection; durable Task/checkpoint; browser process/profile; website login/OAuth state.

Recovery order:

1. Recover persisted task/checkpoint and reconcile any in-flight external effect.
2. Reconnect to a healthy browser using that provider's persistent state.
3. Check authenticated account/store identity, not merely absence of a login form.
4. Use a supported refresh or locally brokered login action within its grant.
5. Wait for human action when MFA, CAPTCHA, passkey presence, identity confirmation or vault unlock is required.

Use bounded retry/backoff. Do not loop password attempts indefinitely. Credentials do not keep expired/revoked server sessions alive. Do not automatically import or decrypt another browser's cookie database as the default fallback; a migration would require a separately validated, scoped and authorized path.

Do not treat reconnect as authorization to repeat a write. After a timeout following a product save, upload, refund or send action, query the remote result/idempotency key first. Uncertain effects remain blocked for reconciliation.

## 12. Credential Broker and two secret contexts

**Approved:** credentials are used locally; generic MCP `secret_get`, `get_password` and raw cookie export are forbidden. Return status/redacted evidence only.

**Two-context direction:**

- Service context: minimal tunnel/internal MCP and explicitly provisioned machine credentials. Use a daemon-compatible file-based/System Keychain provider with item access control and verified executable identity. Access as the non-admin service user must pass a real-machine test; placing an item in System Keychain does not by itself prove access.
- User context: `gram-agent` website credentials, user OAuth credentials and browser login recovery. Use the appropriate user Keychain or provider-owned vault through a constrained credential-use operation.

Apple documents that the data-protection Keychain requires a user login context; a launchd daemon must target file-based Keychain storage. These are not interchangeable implementations. [K1]

Aside already provides a Password Manager that autofills matched credentials without returning raw passwords to its agent. Treat it as a provider-owned credential-use facility, not as a proven generic macOS Keychain API or a readable store for Playwright. Its documented per-item/access policies and possible human challenges still apply. Never weaken its vault policy silently. [A2]

Keychain remains the intended backend for our own scoped machine/API/login brokers. Do not duplicate/export passwords between Aside and the broker by default. Disable screenshots, DOM-value capture, traces and credential-bearing logs during sensitive fill steps. Tokens, passwords and unlock material must not enter argv, task state, logs, Git or MCP results.

## 13. FileVault, reboot and health recovery

**Agreed direction:** FileVault ON, staged core/GUI recovery, two secret contexts. This does not promise zero-interaction recovery after a power failure.

Apple does not allow ordinary passwordless automatic login while FileVault is enabled. Do not disable FileVault or screen-lock protections to meet an uptime claim. [F1]

Before the data volume is unlocked, the installed agent/tunnel cannot be assumed available. After unlock, start core recovery and only advertise capabilities whose required stores/services are ready. GUI login and user-vault readiness remain independent checks.

macOS 26 documents FileVault volume unlock via SSH password authentication when Remote Login is enabled; normal shell access is not initially available and the connection drops during completion of the unlock. This is an optional operator recovery path, subject to real hardware/OS/network verification, not automatic browser recovery. [F2]

Do not assume a VPN running on the locked Mac provides its own pre-unlock rescue path. If remote rescue is required, design a separately available trusted network path; do not open public SSH or store the FileVault password in agent config. No network topology is provisioned by this document. Planned authenticated restart support is also a target-machine verification gate, not a guaranteed Apple Silicon capability.

Proposed observable conditions, not new values silently inserted into the current TaskStatus enum:

| Condition | Runnable work | Required recovery |
|---|---|---|
| Data volume locked / host unreachable | None through this local agent | Operator unlock or separately approved rescue path |
| CORE_RECOVERING | Diagnostics only | DB/lease/workspace/in-flight-effect reconciliation |
| CORE_READY, no GUI session | Eligible API/file/Git work with available credentials | Actual user login for GUI-dependent work |
| GUI session locked or permission missing | Independently eligible core/DOM work only | Unlock/permission action; verify capability before continuing |
| Vault locked / AUTH_REQUIRED | Unrelated work only | Approved local login or human challenge |
| BROWSER_READY + account verified | Scoped browser work | Normal checkpointed execution |
| External write outcome unknown | Read-only reconciliation | Confirm remote effect before any retry |

Human authentication waits and infrastructure waits are distinct from permission approval. Keep existing coding Task states unchanged until an additive lifecycle design/migration is reviewed.

Scheduler direction: persist schedule identity, time zone, due occurrence, attempt and completion checkpoint. Define catch-up/coalesce/expire per workflow. Reports may catch up; missed publishing, refunds, payments and sends must not be replayed blindly. A restart must not manufacture fresh authorization.

## 14. Policy model for business operations

Retain `ALLOW / NEEDS_APPROVAL / DENY` and bind grants to account, normalized operation, resource, material parameters and expiry. Recheck before the external commit action.

Read-only product/inventory/ad reporting and preparing local drafts are low-risk candidates. Routine live edits or approved asset uploads can be automated only within an explicit operational grant. Provider switching must not widen that grant.

Until specific thresholds are agreed, new live publication, pricing changes, ad-budget changes, refunds, payments, outbound CS messages and bulk mutations stop for review. Account/store deletion, credential exfiltration, protected-history destruction and security-boundary bypass remain blocked.

Remote pages, emails, documents and repository instructions are untrusted task data, not authorization to change policies or reveal credentials. Store only necessary/redacted customer data in evidence.

## 15. Relationship to existing Windows / WSL architecture

Preserve UUIDv7 + display sequence, SQLite WAL, coding worktrees, same-repo serialization, different-repo concurrency, PR-by-default and explicit direct-main grants, localhost-only MCP, OpenAI tunnel-client, secret-safe audit, and remote SHA confirmation before Repo Lock release. PR creation and CI observation stay lock-free.

The Windows M2/M3 recovery and verification modules are shared dependencies, not copied into a competing Mac engine. This draft does not alter the original approved Windows spec or its milestone gates.

## 16. Remaining design and validation gates

These are explicit pending gates, not implemented capabilities:

- Stable signed helper identity, authenticated IPC and executor isolation from real account secrets.
- Exact supported macOS/Aside versions; arm64 runtime/native-dependency and launchd smoke tests.
- Aside MCP/REPL capability probe and side-effect-safe cancellation/reconciliation behavior.
- Daemon Keychain access, user-vault locked behavior, and secret-free diagnostics on the actual Mac.
- TCC scope for Accessibility, Screen Recording, Automation and file access; no blanket Full Disk Access by default.
- Optional pre-unlock remote rescue route and planned restart support; no automatic-login/security changes are authorized.
- First real HAAR service/account fixture and approved mutation limits. TOTP/OTP remains provider-supported or human-assisted, not a generic bypass.
- Encrypted state backup/restore, excluded browser auth state, and re-provisioning of device-bound secrets; no export of hardware-protected keys.

## 17. Current design gate and next increment

This is still a Working Design. Review the written spec and resolve the applicable security/compatibility gates before deriving an executable implementation plan. Implementation begins only after that written plan is reviewed and an execution method is selected.

Proposed sequence, not an approved executable task plan:

1. Platform contracts and capability reporting, with WSL regression tests and no existing path relocation.
2. Mac core/tunnel lifecycle and staged readiness, using test credentials only.
3. Backward-compatible operations task/resource model after shared M2 dependencies are integrated.
4. Browser sessions, credential-use broker and GUI helper, with isolation/permission tests.
5. A HAAR vertical slice: inspect one product, prepare assets/draft, save evidence, stop before unapproved live publication.

Payments, live ad changes and CS sending are later separately gated workflows, not default acceptance fixtures.

## 18. Verified repository checkpoint — 2026-09-20

Observed through GitHub, not inferred from previous chat:

- `main`: `fdf5dda2211e011e473f1c89095b78d7cb565c2f`; PR #131 is merged.
- `feat/m2-vertical-slice`: `c7fc805511bd777059d93c6a8360596a934919dc`; PR #135 is open/draft/unmerged. Its progress record covers Tasks 1–7; Task 8 issue #58 is open.
- Actions run `35329853818` reports `completed/success` for that exact M2 head. This review checked the recorded run; it did not rerun product tests.
- Before this revision the Mac branch was one document commit (`f0de2f5`) ahead of main, zero behind, with no implementation changes.

Concrete integration seams found in M2 source:

- `packages/task-engine/src/task-service.ts`: requires `repo` and persists `taskType: 'CODING'`. Non-coding task support is not present.
- `packages/workspace/src/path-mapper.ts`: WSL-to-Windows conversion.
- `packages/workspace/src/worktree-service.ts`: requires `toWindows()` and returns `linuxPath`/`windowsPath`. A platform-neutral native path plus optional display paths needs an additive compatibility plan.
- Shared policy, persistence, MCP, task, shell, Git and workspace changes are still owned by the unmerged M2 work. Do not edit them from this documentation branch.

See `docs/operations/2026-09-20-macos-integration-checkpoint.md` for evidence links and handoff boundaries. Any implementation must refresh this snapshot first.

## 19. External references and corrected assumptions

These sources validate platform constraints; they are not evidence that our implementation works.

- [A1] Aside developer interfaces: https://docs.aside.com/help/developers
- [A2] Aside credential autofill and human challenges: https://docs.aside.com/help/password-manager
- [P1] Playwright persistent profiles and single-owner restriction: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- [K1] Apple TN3137, Keychain contexts: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- [F1] Apple automatic-login/FileVault constraints: https://support.apple.com/102316
- [F2] Apple OpenSSH FileVault unlock manual: https://github.com/apple-oss-distributions/OpenSSH/blob/main/apple_ssh_and_filevault.7

This revision explicitly narrows earlier conversational assumptions: Aside is not a verified cookie-export bridge; its own vault is not synonymous with our Keychain provider; fallback browser availability is not authenticated-session continuity; and FileVault unlock is not equivalent to GUI login or vault unlock. These distinctions preserve the approved security and operations goals without claiming untested behavior.
