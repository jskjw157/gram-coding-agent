# MAC-02 macOS Service Lifecycle Design

**Status:** DRAFT — written-design review pending; MAC-02 is not implemented.  
**Date:** 2026-09-20 (Asia/Seoul)  
**Repository:** `jskjw157/gram-coding-agent`  
**Documentation branch / PR:** `docs/macos-operations-agent-design` / #136  
**Parent:** `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md` at `8f9a31da2e57e998c0e2055d9fe51dbd59b03556`  
**Delivery index:** `docs/superpowers/plans/2026-09-20-macos-operations-delivery-index.md` at the same commit.

## 1. Intent and authorization

Build the service foundation for an always-on Apple Silicon Mac that will operate HAAR. Coding remains one capability of the eventual operations agent, not its entire purpose. This increment makes the core and transport start, stop, report health, and recover from process/network interruption without pretending that website login or interrupted business work has recovered.

The user approved continuing after MAC-01 implementation. Existing decisions remain: one repository, separate platform adapters, dedicated non-admin `gram-agent`, FileVault retained, API-first operations, user-session browser/GUI support, and no raw secrets through MCP. The new requirements below are proposed MAC-02 design decisions. Approval to continue does not constitute installation consent, a reviewed MAC-02 implementation plan, permission to merge, or authorization to access a live store.

Success has two separate gates: a tested lifecycle package, and observed operation on the user's Mac. Neither is achieved by this document.

## 2. Fresh repository baseline and concrete seams

Refs observed in this pass:

| Reference | Observed commit / status |
|---|---|
| `main` | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` |
| Windows branch `feat/m2-vertical-slice` | `c7fc805511bd777059d93c6a8360596a934919dc` |
| MAC-01 branch `feat/macos-platform-readiness` | `a98c8ff45497f8524bc2ffa9bda19ad60898faf1`; PR #137 open, Draft, unmerged |
| Documentation branch before this addition | `8f9a31da2e57e998c0e2055d9fe51dbd59b03556` |

The delivery index's statement that MAC-01 implementation had not started is a historical planning checkpoint, not current status. PR #137 now records its diagnostic-only implementation and prior CI evidence. No tests were rerun during this design inspection. Independent MAC-01 review and the user's real-machine acceptance are still not established. [R1]

Direct source observations:

- `apps/agent/src/main.ts` exports `startAgent`, defaults to `127.0.0.1:3847`, opens `agent.sqlite`, runs migrations, uses `FileSecretProvider`, and supports SIGTERM/SIGINT shutdown. Its executable entry reads `GRAM_AGENT_STATE_DIR` and `GRAM_AGENT_SECRET_DIR`. It does not perform interrupted-task reconciliation. [R2]
- `packages/mcp/src/server.ts` handles `/healthz` before the internal-secret check. `/mcp` requires `X-Gram-Agent-Auth`; the inspected main version registers `agent_health`. Therefore an HTTP 200 from `/healthz` proves neither authenticated MCP access nor business readiness. [R3]
- The WSL tunnel unit uses systemd dependencies, `EnvironmentFile`, and `tunnel-client run --config`. Those service-manager semantics cannot simply be copied into a plist. [R4]
- The existing tunnel configuration uses environment/file references and a separate loopback health listener at port 8080. This is a repository contract, not proof of compatibility with an uninspected Mac binary. [R5]
- MAC-01's `CORE`, `ISOLATION`, credential and provider observations are distinct and context-bound. Its internal types are not an authenticated IPC protocol. [R6]

Refresh these refs before implementation. Do not resurrect already completed Windows work or copy unmerged M2 modules.

## 3. Chosen approach and alternatives

**Proposed:** two system LaunchDaemons running as the non-admin service account, with a small fixed-purpose supervisor for each. Add a user-session helper later in MAC-04. This preserves background service availability after an authenticated volume unlock while keeping browser/GUI work in the correct future session boundary.

A LaunchAgent-only deployment is simpler but loses core service availability when the user logs out. A root, all-in-one automation daemon increases privilege and mixes interactive and noninteractive capabilities. Neither matches the approved product/security direction. Apple documents the daemon versus logged-in-user agent lifecycle; its archived guidance is not a substitute for testing the actual macOS build. [E1]

MAC-02 intentionally has **LAB_ONLY** execution scope: the existing health-only core, synthetic local authentication, and optional separately authorized test-tunnel validation. Real store credentials, repository-script execution, and business-task scheduling remain disabled by absence of those capabilities, not merely by a label in a report.

## 4. Requirement boundary

- **L01 — Preserve existing work:** no changes to Windows files, M2 contracts, existing MCP routes, TaskStatus, policy rules, backlog manifest, or live credentials.
- **L02 — Least privilege:** long-running processes run as `gram-agent`, never root; no passwordless sudo or remote privileged control tool.
- **L03 — Validate before mutation:** preview is read-only; installation requires an explicit local administrative apply action against the exact reviewed configuration digest.
- **L04 — Own only our services:** fixed labels, paths and executables; refuse foreign files, conflicting jobs and occupied ports rather than replacing or killing them.
- **L05 — Separate service and work recovery:** restart does not replay tasks, approve actions, or infer successful side effects.
- **L06 — Protect secrets:** no secret values in plist, argv, install manifest, logs, diagnostic JSON, Git, task state or MCP output.
- **L07 — Bounded recovery:** backoff, persistent circuit state and controlled shutdown; no rapid restart or repeated authentication loops.
- **L08 — Evidence-based health:** match service ownership, current launch generation, local health and authenticated MCP; missing checks remain unknown.
- **L09 — Preserve security settings:** no FileVault, automatic-login, TCC, sleep, firewall, SSH or account-security changes.
- **L10 — Reversible service deployment:** atomic configuration replacement and service rollback; preserve databases, profiles, keys and workspaces.
- **L11 — Separate acceptance:** simulated tests, hosted native-Mac tests, real-device service tests and live-workflow tests are different records.
- **L12 — No competing engines:** no new business scheduler, secret vault, GUI IPC protocol or Task Engine in this increment.

## 5. Processes and service identity

| Component | Proposed identity | Responsibilities |
|---|---|---|
| Core supervisor | `com.haar.gram-agent.core` | Validate installation, launch the fixed core entry, observe owned child, sanitize diagnostics, track restart generation |
| Tunnel supervisor | `com.haar.gram-agent.tunnel` | Wait for verified core, launch the installed OpenAI tunnel binary, observe transport readiness, stop on unsafe core state |
| Future GUI helper | Reserved for MAC-04; not installed here | Browser/native app/session and user-vault operations |

Both installed plists live under `/Library/LaunchDaemons/`; neither uses a user's interactive shell profile. `UserName` selects `gram-agent`. The generated `ProgramArguments` is an XML-escaped array of an absolute executable path and fixed arguments, never a shell command string. [E1]

Use `RunAtLoad: true`, `KeepAlive: true`, proposed `ThrottleInterval: 30`, `ExitTimeOut: 30`, and umask 077 (plist integer 63). Confirm these keys with `plutil -lint` and the target system's launchd manuals and behavior tests before installation. The supervisor stays in the foreground. It must not daemonize, launch an unrestricted shell, or rely on `NetworkState` as proof of internet availability.

No third watchdog is introduced. launchd restarts a dead supervisor; each supervisor owns only its own fixed child. Process-group cleanup after unexpected supervisor death is a real launchd acceptance test, not an assumption derived from unit mocks.

## 6. Files, release provenance and ownership

Proposed installation layout:

```text
/Library/Application Support/HAAR/GramAgent/
  releases/<release-id>/        administrator-owned, verified immutable runtime bundle
  config/                      administrator-owned service configuration and manifest
  state/lab/                   service-owned, 0700; dedicated MAC-02 test database
  run/                         service-owned, 0700; bounded lifecycle status/circuit files
  secrets/                     service-owned, 0700; synthetic/test-only credential files
  logs/                        service-owned, 0700; redacted, rotated logs
/Library/LaunchDaemons/
  com.haar.gram-agent.core.plist
  com.haar.gram-agent.tunnel.plist
```

This does not move existing Windows or personal Mac data. Do not share a live SQLite database or browser profile across machines. Releases identify the source commit, dependency-lock digest, Node binary digest, and optional tunnel-binary version/digest. An operator verifies provenance against an independently reviewed artifact digest; a manifest cannot establish its own trust merely by containing hashes.

Build and resolve dependencies without root before staging. Installation must not run npm/pnpm scripts, download executables, execute a user-writable release, or extract an unchecked archive as root. Staged internal package links must resolve within the sealed release; reject escaping symlinks and untrusted writable ancestors. Resolve the actual account UID/GID; do not assume a numeric UID or that the `staff` group is secret-safe.

Plists/configuration are root-owned and not writable by the runtime. Secret files are regular files, 0600, readable only in the test service context; reject symlinks, unexpected owners, oversized values and extra links. Same-user file permissions are **not** isolation from untrusted code. LAB_ONLY scope cannot be promoted to real operations until the parent isolation/broker requirements are satisfied.

## 7. Inputs and preflight

The local operator supplies an already staged release ID, its independently reviewed digest, and a service configuration file. Real account password, API key or cookie values are not CLI inputs. The configuration contains paths/references and fixed-mode options only; reject unknown keys.

Preflight checks native `darwin/arm64`, Node 24, existing non-admin account, trusted release paths, installed binary digests, expected core tool surface, free configured ports, safe directory ownership, plist serialization, and existing-installation identity. An x64 process on Apple Silicon is not treated as a successful native check. No account or platform support is inferred from browser user-agent information.

Defaults remain core port 3847 and tunnel health port 8080, loopback only. A conflict returns `PORT_IN_USE` and leaves the other process alone; no automatic port reassignment. Supporting configurable core ports would need a reviewed wrapper/API adaptation because the current direct core entry uses its default port.

The default local command is `preview --json`. It validates without writing, starting jobs, connecting a tunnel, loading credentials, or changing accounts. Root-only `apply` rechecks the complete input and expected current-installation digest immediately before mutation. A stale preview returns `CONFIG_CHANGED`; it does not silently apply new content.

## 8. Installation, start, stop and rollback

All names here are a proposed local CLI contract, not commands already implemented:

| Action | Behavior |
|---|---|
| `preview --json` | Read-only validation; safe changes summary; no secrets or full private paths in shared JSON |
| `apply` | Explicit administrative operation; stage owned files, validate, atomically publish configuration, then start selected services |
| `status --json` | Read-only ownership/liveness/readiness summary; no corrective action |
| `start` | Explicit administrative enable/bootstrap for fixed owned labels only |
| `stop` | Disable then boot out owned tunnel before core; verify absence so KeepAlive cannot undo the stop |
| `restart` | Preserve desired enabled state, stop tunnel/core, start core, verify it, then start eligible tunnel |
| `reset-failure` | Explicit local acknowledgement of a circuit failure; increments generation and revalidates before retry |
| `rollback` | Restore a previous verified release/configuration only when database compatibility is proven |
| `uninstall` | Stop/remove only manifest-owned launchd registration and matching plist files; preserve all state and releases |

Use fixed argument vectors to `/bin/launchctl`; never offer `exec(command)` or arbitrary labels. Mutating commands require actual OS authorization; an application approval flag alone cannot grant it. No MCP wrapper for these administrative actions is added.

Hold an exclusive installation-operation lock across the configuration transition, not across PR/CI or ongoing runtime work. Stage in a root-owned temporary directory on the same filesystem; validate path ownership again before atomic rename. Record a nonsecret operation journal so interruption yields a diagnosable partial installation, not a false success. A second apply of identical bytes is a no-op.

Capture prior enabled/disabled state, manifest and hashes before changing anything. On service-start failure, stop new owned jobs and restore the prior configuration when it is compatible. The current core runs migrations at startup; therefore no automatic executable rollback onto an unproven database schema. An incompatible or uncertain schema yields `ROLLBACK_BLOCKED_SCHEMA`, with the database preserved. Never repair that condition by deleting the database or copying an active SQLite/WAL pair. Uninstall has no purge flag in MAC-02.

## 9. Runtime state and health contract

Service lifecycle is distinct from TaskStatus and business authorization:

```text
STOPPED -> VALIDATING -> STARTING -> LOCAL_CORE_HEALTHY
                    \-> BLOCKED_CONFIGURATION
STARTING / RUNNING -> BACKOFF -> STARTING
                  \-> BLOCKED_RESTART_BUDGET
RUNNING -> STOPPING -> STOPPED
```

Tunnel reporting separately uses `DISABLED`, `WAITING_CORE`, `CONNECTING`, `TRANSPORT_READY`, `OFFLINE`, `AUTH_BLOCKED`, or `UNKNOWN`. Do not replace a missing probe with a green state.

`LOCAL_CORE_HEALTHY` requires a live owned child, the expected listener ownership, a bounded `/healthz` response with the expected schema, successful authenticated MCP initialization/health call, and the exact approved LAB_ONLY tool list. Verify listener identity **before** sending the internal authentication header; a foreign listener must not receive the secret. If listener identity cannot be established, return unknown and do not authenticate.

Health adapters use fixed loopback URLs, reject redirects, cap each response at 64 KiB and time out each request after 2 seconds. No arbitrary URL/headers are accepted. HTTP 200, an open TCP port, PID existence, or a stale status file alone is insufficient.

Generate a new opaque context on every supervisor start, release change, or owned-core replacement. Bind status to role, release and child generation, update on a 5-second observation cadence, and expire evidence after MAC-01's 30 seconds. Persist only safe status and circuit history; freshness depends on a live current owner, not the last saved timestamp. Clock anomalies and partial status files yield unknown.

Expose a lifecycle report without changing MAC-01's contract. If mapping a verified lab-core observation into `CORE`, leave `ISOLATION`, business-service credentials, user session, vault, browser and store-account probes unknown. Having a restricted tunnel key does not satisfy `SERVICE_AUTH` for a shopping API. All business capabilities remain unavailable in this increment.

## 10. Startup ordering, interruptions and retry budget

The two jobs may start in either order. The tunnel waits for a newly verified core rather than assuming systemd-like dependencies or socket activation that the existing HTTP server does not implement. [R3, R4, E1]

Proposed testable limits: 60 seconds to establish core health; precondition retry delays of 1, 2, 4, 8, 16, then 30 seconds; maximum five unexpected owned-child exits in a rolling five-minute window. These are new lifecycle choices, not changes to Repo Lock leases.

Unexpected child exit ends its supervisor attempt after status/circuit recording, allowing launchd to restart with throttling. On exhausted budget, the restarted supervisor remains idle in a blocked state until `reset-failure`; it does not spawn another child. Persist the block across supervisor/host restart; invalid history fails closed. Intentional stop is not a crash.

A healthy but disconnected tunnel gets time to perform its provider-supported reconnection; do not repeatedly restart the core because the internet is down. An explicit authentication rejection blocks automatic credential retries. Where the installed binary cannot expose a trustworthy reason, report `UNKNOWN` rather than guessing that the key is valid.

On core loss, stop forwarding by terminating the owned tunnel child, then reverify the new core generation before reconnecting. Under LAB_ONLY, no mutating business tool exists. Future in-flight business outcomes are reconciled by MAC-03; this supervisor cannot promise that an interrupted request did not execute.

For SIGTERM, stop admission through the tunnel first, send SIGTERM to the owned child and allow up to 20 seconds to drain inside launchd's proposed 30-second stop window. Force termination, if required, targets only the recorded owned child/process group. Never kill a PID merely because it occupies the desired port.

## 11. Tunnel and secret compatibility

Reuse OpenAI `tunnel-client` exclusively. The current official guide describes outbound-only transport, runtime Read + Use permissions, and distinct `/healthz` and `/readyz` surfaces. It does not validate our installed Mac binary or every YAML field used by the WSL setup. [E2]

Before enabling a real test tunnel, record the operator-provided binary version/digest and validate its supported configuration and health response schema. Do not force an assumed `run --config` contract onto an incompatible version. Inspect `help quickstart` and supported validation output with synthetic configuration first. MAC-02 cannot create/manage tunnels, request broader permissions, or silently use another transport.

The first default deployment is core-only. A separately authorized transport test may use a restricted test-tunnel credential; test fixtures must not contain real credentials. For the repository's environment-reference contract, the trusted launcher loads the private reference locally and places a value only in the tunnel child's minimal environment. No secret is stored in `EnvironmentVariables` inside a plist, sourced through a shell, passed in argv or inherited by the core. Clear temporary references after spawning; do not claim guaranteed JavaScript memory zeroization.

Use distinct synthetic/test credentials for local MCP and transport. Disable raw HTTP/body logging and drain/discard untrusted child output unless an allowlisted structured event can be emitted safely. Do not forward raw startup errors from the existing core entry; errors can include file paths or values. Keep only fixed codes, times, retry counts and release identity. Bound logs to three 5 MiB files per service.

The parent Keychain/Aside credential-use architecture is retained, not replaced by these lab files. Implementing either vault, unlocking it at boot, or claiming daemon access to a user vault belongs to MAC-04 and a separately tested credential design. Apple TN3137 remains a parent reference; its JavaScript-only page was not readable in this research pass, so no fresh verification of its detailed behavior is claimed.

## 12. Reboot, FileVault and GUI boundary

Preserve FileVault and require an authorized unlock path. Apple's ordinary automatic-login setting is unavailable while FileVault is on; do not weaken security settings for an uptime claim. Actual GUI readiness is observed, not inferred from a disk unlock or a login-screen appearance. [E3]

After data-volume unlock, launchd can start the configured noninteractive services. Before that, this local agent cannot report its own state; a remote timeout means unreachable, not proof of FileVault lock. Optional remote preboot recovery and planned authenticated restart remain outside MAC-02. No public SSH port or recovery password is configured.

No GUI LaunchAgent, TCC request, browser startup or vault unlock is installed here. Logout or screen lock must not be advertised as loss of all core functionality, but it also cannot be advertised as browser readiness. The future GUI helper will supply that evidence after its own reviewed IPC and identity design.

Reboot testing uses a lab database only. MAC-02 restarts service processes, never an interrupted order, publication, refund, customer message or advertising change. Service recovery, task recovery and website-session recovery remain three different deliverables.

## 13. Proposed module boundaries and allowed changes

Do not add filesystem/process behavior to MAC-01's pure platform package. Proposed new files belong to these cohesive components:

```text
packages/macos-lifecycle/src/
  contracts.ts              local lifecycle inputs, safe states, action results
  config.ts                 strict input and path-reference validation
  launchd-plist.ts           pure fixed-role plist generation
  install-service.ts        owned-file/journal/rollback orchestration through ports
  supervisor.ts             bounded owned-child lifecycle and shutdown
  health-probe.ts            listener ownership and bounded MCP/transport checks
  diagnostic.ts             safe status projection; no arbitrary exception text
  cli.ts                    explicit local operator entry
  adapters/                 narrow macOS filesystem/process/launchctl adapters
  *.test.ts                 component and integration contracts
platform/macos/              packaging fixtures and nonsecret configuration examples
docs/operations/macos-service-lifecycle.md
.github/workflows/macos-lifecycle.yml
```

Reuse `@gram/platform` only after its reviewed integration into main, or through a separately approved dependency branch. Do not merge/cherry-pick PR #137 simply to unblock this work. Pure lifecycle/configuration tests may use local test fixtures while dependency integration is pending; no fixture can be packaged as a working core or tunnel.

A future feature branch is proposed as `feat/macos-service-lifecycle`, from then-current reviewed main, in an isolated worktree. It is **not created by this documentation checkpoint**. Only the new lifecycle package, Mac-specific packaging/workflow/runbook and their necessary lockfile importers are in its anticipated diff. A need to edit shared code must be surfaced and separately reviewed, not hidden as bootstrap cleanup.

## 14. Verification and acceptance matrix

Every row is a required future test, currently **NOT_RUN for MAC-02**:

| Test | Requirement | Expected evidence |
|---|---|---|
| macOS x64 / unsupported OS / invalid Node | L03, L11 | Preflight refusal, zero mutations |
| Path spaces/XML metacharacters/escaping links | L03, L04 | Correct argument preservation; unsafe paths rejected |
| Missing/admin runtime account | L02 | No service launch; no automatic account/security changes |
| Preview/apply digest race and concurrent applies | L03, L10 | Stale/concurrent mutation rejected |
| Foreign plist/job/port | L04, L06 | No overwrite/kill; no authentication sent to foreign listener |
| Empty or malformed health and unauthenticated 200 | L08 | Not healthy; no tunnel release |
| Stale/rebooted status or wrong child/release | L08 | Unknown until a new owned observation |
| Tunnel before core/core death/internet outage | L07, L08 | Bounded wait/reconnect; no core restart storm |
| Credential rejection and secret-bearing child output | L06, L07 | Blocked retry; no values in reports, argv or logs |
| Five crashes, supervisor kill, stop then reboot | L04, L07 | Persistent circuit; no orphan child or unwanted restart |
| Partial install and compatible/incompatible rollback | L10 | Owned-file recovery; DB preserved; schema uncertainty blocks rollback |
| Duplicate apply/uninstall with lab state present | L03, L10 | Idempotence; data, credentials and releases retained |
| LAB_ONLY tool-surface mismatch | L01, L05, L12 | Unexpected tools block tunnel activation |
| Healthy core without isolation/GUI/vault evidence | L05, L08 | Business readiness remains unknown/unavailable |
| Root regression suite and main-to-branch diff | L01, L11 | Existing tests pass; no WSL/M2 changes |
| Native hosted-Mac plist/process tests | L07, L11 | Actual arm64 job and exact commit recorded; not called user-device acceptance |
| User-Mac logout/reboot/reconnect acceptance | L09, L11 | Explicitly authorized real-device evidence with test state only |

Write failing tests first and observe their failure before production implementation. Simulation of launchctl is not proof of launchd recovery. Root CI success is not proof that account permissions, FileVault, Keychain or store sessions work. Record failed and skipped checks by name rather than dropping them from the report.

## 15. Delivery gates and next executable step

This spec narrows MAC-02 to service lifecycle and a laboratory transport path; it does not resolve the whole operations agent's security design. Review this written spec before generating its task-by-task implementation plan. Preserve the already chosen native sequential execution method, but do not execute a plan that has not been written and reviewed.

The implementation plan must cover validation/plist generation, installation transaction, supervision/health, and Mac acceptance as separately testable tasks with explicit RED/GREEN evidence. Start with pure configuration/plist tests. No administrator access or real secret is required to write those tests.

Real-device apply requires the exact target macOS build, account identity, verified artifacts, free ports and explicit operator approval. Those are deployment inputs, not an excuse to block the design and test-only implementation. A missing real tunnel binary/credential keeps tunnel acceptance pending; it does not permit a fake success.

Before merging, obtain independent review of privileged path handling, ownership checks, environment/log isolation and rollback behavior. No independent reviewer is presumed available. Keep code Draft until the applicable review/test gates have evidence. Do not close Windows issues or mark all HAAR operations complete.

## 16. Evidence sources and research limits

Repository sources were read through the connected GitHub tools. The observations in section 2 come from those files; other numbered requirements and numeric limits are new design proposals, not existing behavior.

- [R1] MAC-01 PR: https://github.com/jskjw157/gram-coding-agent/pull/137
- [R2] Core entry: https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/apps/agent/src/main.ts
- [R3] HTTP/MCP behavior: https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/packages/mcp/src/server.ts
- [R4] Existing WSL tunnel unit: https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/systemd/openai-mcp-tunnel.service
- [R5] Existing tunnel template: https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/config/tunnel-client.example.yaml
- [R6] MAC-01 contracts: https://github.com/jskjw157/gram-coding-agent/blob/a98c8ff45497f8524bc2ffa9bda19ad60898faf1/packages/platform/src/contracts.ts
- [R7] Repository rules: https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/AGENTS.md
- [E1] Apple, Creating Launch Daemons and Agents (archived): https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- [E2] OpenAI, Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- [E3] Apple, automatic login constraints: https://support.apple.com/en-mt/102316

The archived plist-manual URL and the JavaScript-only Keychain page did not provide readable detail in this pass. The successful Apple guide supports the lifecycle split, not every proposed plist knob. Exact installed-binary schema, launchd cleanup and daemon secret access remain explicit test gates. No configuration, binary, account or service was installed or changed on the user's Mac while preparing this document.
