# Gram Coding Agent

Gram Coding Agent is a controller-driven coding runtime. An authenticated MCP controller submits a durable task; the
agent resolves and locks the target repository, creates a task-scoped Git worktree, exchanges coding steps and review
decisions with the controller, verifies an exact workspace snapshot, and only then commits, pushes, and observes a pull
request.

The design targets a dedicated Windows 11 LG Gram host with WSL2 Ubuntu. The agent listens only on loopback, and the
intended production transport is the OpenAI `tunnel-client` in front of the local MCP endpoint. This repository is a
reference implementation with substantial tests, not a claim that the service is deployed or production-accepted. See
[Status](#status) for the exact scope.

## Status

The labels below are deliberately narrow. "In source" means a code path exists. "Tests present" means repository tests
exist; it does not mean every environment or live integration was exercised here. "Off by default" means trusted local
configuration is required before the capability is composed.

| Area                                                               | In source | Repository tests                                   | Runtime status                                                  |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------- | --------------------------------------------------------------- |
| MCP loopback HTTP server and shared-secret authentication          | Yes       | Unit/integration                                   | Runs inside the agent process                                   |
| Durable tasks, SQLite state, audit events                          | Yes       | Unit/integration/e2e                               | Runs inside the agent process                                   |
| Per-repository lock and task-scoped Git worktrees                  | Yes       | Unit/integration/e2e                               | Used when a task is dispatched                                  |
| Coding-step rendezvous (`coding_step_*`)                           | Yes       | Unit/integration                                   | Requires an authenticated controller                            |
| Verification plans and review gates (`verification_review_*`)      | Yes       | Unit/integration/e2e                               | Live controller/WSL acceptance not claimed                      |
| Ordinary verification command isolation (`bwrap` + pinned runtime) | Yes       | TS command-isolation and native boundary tests     | Requires provisioned sandbox profile; not complete OS isolation |
| Publishing: commit, push, remote confirmation, PR/CI               | Yes       | Unit/integration/e2e with a fake GitHub server     | Live GitHub/tunnel acceptance not claimed                       |
| Owner-authorized filesystem and local developer tools              | Yes       | Unit and native security tests                     | Off by default; activation gates open                           |
| ego(lite) public shopping snapshot                                 | Yes       | Unit                                               | Off by default; not deployed                                    |
| Windows native helpers                                             | Yes       | Windows CI native tests                            | Installation/ACL admission gates open                           |
| systemd and OpenAI tunnel templates                                | Yes       | Static ops checks outside the root Vitest projects | Operator provisioning required                                  |
| Live production operation                                          | —         | —                                                  | Not claimed                                                     |

The security documents are pinned historical drafts, not current-main attestations:
[policy-invariants.md](docs/security/policy-invariants.md) audits M2 SHA `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` at
2026-10-08 and is labeled "PREPARATORY DRAFT — NOT M5 ACCEPTANCE"; [threat-model.md](docs/security/threat-model.md) has
the same scope. Current `main` additionally wires `LinuxIsolatedProcessSpawner` for ordinary verification commands,
described below. This README describes that current wiring without upgrading the historical conclusions to M5 or
production acceptance.

## Architecture

```text
MCP controller (the design targets ChatGPT through OpenAI tunnel-client)
  |
  |  authenticated MCP request: x-gram-agent-auth
  v
127.0.0.1:<port>  /mcp
  |
  v
Gram Coding Agent (one deployable Node.js process)
  |
  +-- TaskScheduler
  +-- TaskRunner
  |     +-- repository resolve
  |     +-- per-repository lock
  |     +-- task-scoped Git worktree
  |     +-- instructions / analyze / modify (coding-step rendezvous)
  |     +-- verification plan, snapshot and review gates
  |     +-- commit -> push -> remote SHA confirmation
  |     +-- pull request and CI observation
  +-- SQLite state, audit trail, recovery records
  +-- optional owner workspace / local developer / ego(lite) adapters
```

This is a modular monolith. Packages have separate responsibilities and are tested independently, but the deployment
unit is one agent process. There is no microservice or distributed worker requirement in this version.

## Execution path

1. [`apps/agent/src/main.ts`](apps/agent/src/main.ts) opens SQLite, runs migrations, builds repositories and services,
   loads the trusted internal secret, composes the MCP surface, and starts the scheduler only after MCP is ready.
2. `task_create` stores a durable `QUEUED` task. The controller receives the task UUID and human-readable sequence.
3. [`task-scheduler.ts`](apps/agent/src/task-scheduler.ts) claims runnable tasks. It has no global queue or global run
   mutex: same-repository work is serialized by the repository lock, while different repositories may proceed
   concurrently.
4. [`task-runner.ts`](packages/task-engine/src/task-runner.ts) performs the ordered phases: resolve repository, acquire
   lock, fetch, create worktree, load repository instructions, analyze, modify, verify, publish, ensure pull request,
   observe CI, and complete.
5. `coding_step_*` is the controller rendezvous. The agent exposes a pending step with exact task/step identity; the
   controller reads task-scoped content, then submits analysis or exact file replacements with expected content hashes.
   Accepted coding output is input to verification, not verification evidence.
6. `verification_review_*` binds review to one frozen workspace snapshot and verification plan. A PASS requires reading
   every candidate and acknowledging its per-review digest. The runtime checks the binding; it does not claim to prove
   reviewer judgment.
7. [`publishing-service.ts`](packages/publishing/src/publishing-service.ts) verifies sealed evidence, creates the
   commit, pushes, confirms the remote SHA, marks the commit remote-confirmed, and only then releases the repository
   lock.
8. Shutdown stops the scheduler, rejects new coding/review waits, stops the MCP listener, drains registered runs, closes
   optional runtimes, quiesces lock heartbeats, and closes SQLite. A lease whose push was not confirmed remains held for
   explicit recovery; shutdown does not release it.

See [`docs/operations/external-coding-capability.md`](docs/operations/external-coding-capability.md) for the controller
flow and its limits.

## MCP boundary

The MCP surface is split so transport and feature composition can be read separately:

- [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) owns the HTTP listener, literal loopback enforcement, Host
  validation, the shared-secret gate, `/healthz`, `/mcp`, 404/400 responses, and listener lifecycle.
- [`packages/mcp/src/auth.ts`](packages/mcp/src/auth.ts) compares the internal secret with `timingSafeEqual` after an
  equal-length check. A length mismatch returns early; this is not a constant-duration claim for every rejection.
- [`packages/mcp/src/tool-catalog.ts`](packages/mcp/src/tool-catalog.ts) maps optional ports to registration functions.
  A port that is absent contributes no tools. Both the HTTP wrapper and the direct `createMcpToolServer` factory reject
  mixing owner-workspace authority with the legacy `localFs`/`localProject` ports.
- [`apps/agent/src/main.ts`](apps/agent/src/main.ts) decides which ports exist in the real process. Interface
  declarations alone do not advertise a tool.

`/healthz` is intentionally outside the MCP shared-secret gate, after Host validation. It returns only health metadata.
Every `/mcp` request passes the authentication check before dispatch.

### Active tool surface

The exact default production catalog is 17 tools. This is asserted against a real `startAgent` process in
[`apps/agent/src/main.test.ts`](apps/agent/src/main.test.ts):

| Group                   | Tools                                                                                                           | Registered when                   | In `startAgent` today                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| Task creation and reads | `task_create`, `task_get`, `task_list`, `task_logs`, `task_result`                                              | The corresponding port is present | Yes                                                      |
| Coding rendezvous       | `coding_step_get`, `coding_step_read`, `coding_step_submit`, `coding_step_fail`                                 | `codingCapability` is present     | Yes                                                      |
| Verification review     | `verification_review_get`, `verification_review_read`, `verification_review_submit`, `verification_review_fail` | `verificationReviews` is present  | Yes                                                      |
| Approvals               | `approval_list`, `approval_approve`, `approval_deny`                                                            | `approvals` is present            | Yes                                                      |
| Health                  | `agent_health`                                                                                                  | `agentTools` is absent            | Yes; `agentTools` is not wired, so this fallback is used |

Conditional additions in the real agent:

| Group            | Tools                                                                                                                                                                                                                                                                                                                                    | Activation                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Owner filesystem | `local_fs_roots`, `local_fs_list`, `local_fs_stat`, `local_fs_read`, `local_fs_read_lines`, `local_fs_search`, `local_fs_write`, `local_fs_patch`, `local_fs_mkdir`, `local_fs_move`, `local_fs_copy`, `local_fs_trash`, `local_fs_restore`, `local_fs_read_binary`, `local_fs_write_binary`, `local_fs_reveal`, `local_fs_convert_path` | `GRAM_AGENT_OWNER_WORKSPACE_CONFIG` points to trusted local configuration |
| Local developer  | `local_repo_register`, `local_git_status`, `local_git_diff`, `local_git_log`, `local_dev_run`                                                                                                                                                                                                                                            | Same owner-workspace configuration                                        |
| ego(lite)        | `ego_public_shopping_snapshot`                                                                                                                                                                                                                                                                                                           | `GRAM_AGENT_EGO_BROWSER_MODE=windows` or `native`                         |

`@gram/mcp` also supports tool groups that the current agent does **not** wire:

- `repo_resolve`, `repo_list`, `repo_get`, `repo_inspect`, `repo_register`
- `code_search`, `file_read`, `file_write`, `file_patch`, `file_diff`
- `git_status`, `git_diff`, `git_log`, `git_blame`
- `verification_plan`, `verification_run`, `verification_status`, `verification_evidence`
- `github_pr_ensure`, `github_pr_get`, `github_pr_checks`
- `agent_status`, `agent_logs`
- `local_project_list`, `local_project_read`
- the legacy `localFs` port, whose `local_fs_*` names overlap the owner-workspace port; the server rejects enabling both
  at once

[`packages/mcp/src/server.test.ts`](packages/mcp/src/server.test.ts) uses synthetic ports to test the generic catalog.
Its advertised list is therefore not the production surface. The production assertion is the separate test in
`apps/agent/src/main.test.ts`.

## Package boundaries

| Path                                                                                                                                                                                                                                                                                                                             | Responsibility                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`packages/domain`](packages/domain)                                                                                                                                                                                                                                                                                             | Task and policy types, status constants, pure domain rules                                       |
| [`packages/persistence`](packages/persistence)                                                                                                                                                                                                                                                                                   | SQLite schema, migrations, repositories, durable state                                           |
| [`packages/policy`](packages/policy)                                                                                                                                                                                                                                                                                             | Shell parsing, risk classification, approval and operation-hash policy                           |
| [`packages/shell`](packages/shell)                                                                                                                                                                                                                                                                                               | Policy-enforced command runner, output capture, isolated Linux spawner and sandbox contract      |
| [`packages/secrets`](packages/secrets)                                                                                                                                                                                                                                                                                           | File-backed secret leases and redaction                                                          |
| [`packages/workspace`](packages/workspace)                                                                                                                                                                                                                                                                                       | Task worktree creation and WSL/Windows path mapping                                              |
| [`packages/repo-lock`](packages/repo-lock)                                                                                                                                                                                                                                                                                       | Per-repository lease, heartbeat and exclusivity                                                  |
| [`packages/repo-registry`](packages/repo-registry)                                                                                                                                                                                                                                                                               | Repository resolution, inspection and profiles                                                   |
| [`packages/git`](packages/git)                                                                                                                                                                                                                                                                                                   | Branch, commit and remote services over command ports                                            |
| [`packages/github`](packages/github)                                                                                                                                                                                                                                                                                             | GitHub client, pull-request and check services                                                   |
| [`packages/verification`](packages/verification)                                                                                                                                                                                                                                                                                 | Change classification, verification planning, evidence and execution                             |
| [`packages/publishing`](packages/publishing)                                                                                                                                                                                                                                                                                     | Sealed-evidence publication: commit, push, remote confirmation                                   |
| [`packages/task-engine`](packages/task-engine)                                                                                                                                                                                                                                                                                   | Task service, state machine, scheduler-facing runner contracts                                   |
| [`packages/observability`](packages/observability)                                                                                                                                                                                                                                                                               | Health status and structured logging                                                             |
| [`packages/filesystem`](packages/filesystem)                                                                                                                                                                                                                                                                                     | Bounded code search, file operations, diff/patch and path guard                                  |
| [`packages/mcp`](packages/mcp)                                                                                                                                                                                                                                                                                                   | HTTP/auth boundary and optional tool catalog                                                     |
| [`apps/agent`](apps/agent)                                                                                                                                                                                                                                                                                                       | Composition root, scheduler, runtime adapters, owner workspace, local developer and ego adapters |
| [`apps/execution-sandbox`](apps/execution-sandbox), [`apps/filesystem-worker`](apps/filesystem-worker), [`apps/windows-owner-consent-helper`](apps/windows-owner-consent-helper), [`apps/windows-protected-local-viewer`](apps/windows-protected-local-viewer), [`apps/windows-workspace-helper`](apps/windows-workspace-helper) | Native helpers with separate build/test contracts                                                |

Dependency direction: `apps/agent` may compose packages; packages must not import the application orchestration.
`@gram/mcp` exposes typed ports and registration functions, not the concrete agent runtime.

## Repository layout

```text
apps/agent/             composition root and agent runtime
apps/*-helper/           native Windows/worker helpers
packages/                domain, infrastructure and application services
config/                  example and deployment configuration templates
docs/operations/         acceptance, activation and deployment notes
docs/security/           threat model and policy invariant register
docs/superpowers/        historical design and implementation plans
scripts/                 bootstrap, CI and native-helper build scripts
systemd/                 service templates
tests/                   e2e, ops and security suites
```

## Build and test

Prerequisites depend on the checks you intend to run:

- **Build and unit/e2e checks:** Node.js 24.x (root `engines` is `>=24 <25`) and pnpm 10.34.5. Linux is the primary
  environment for the package, app and e2e suites; Windows is needed for the native helper jobs and a C++ toolchain.
- **Security acceptance and real task verification:** the same Node/pnpm baseline, Python 3 for the native test scripts,
  and a root-provisioned Linux sandbox profile: a root-owned `/usr/local/libexec/gram-sandbox-entry`, `/usr/bin/bwrap`,
  the pinned runtime under `/var/lib/gram-sandbox-runtime/`, and kernel Landlock ABI 7 or newer. The isolation profile
  fails closed: the agent may start, but a verification command or the security suite cannot fall back to an
  unrestricted runner when the profile is absent or unverified.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

`pnpm test:security` is a separate Linux acceptance run, not a portable unit test. Run it only where the root-owned
profile above is provisioned:

```bash
pnpm test:security
```

Notes:

- `pnpm test` runs the `packages/*` and `apps/*` Vitest projects selected by [`vitest.config.mts`](vitest.config.mts).
- `pnpm test:e2e` runs [`tests/e2e/vitest.config.ts`](tests/e2e/vitest.config.ts).
- `pnpm test:security` runs `node tests/security/run-security.mjs`. It needs the provisioned artifacts above and is
  expected to fail closed without them. [`scripts/prepare-security-ci.sh`](scripts/prepare-security-ci.sh) is
  exclusively for an ephemeral GitHub-hosted runner (it requires `GITHUB_ACTIONS=true`, a non-root account and sudo). Do
  not run it on a personal PC, do not fake `GITHUB_ACTIONS`, and do not disable isolation or fallback controls to make
  the suite pass.
- Real task verification uses the same `LinuxIsolatedProcessSpawner` profile; a normal development checkout can start
  the agent and run unit/e2e checks, but it cannot execute a real verification command without the provisioned profile.
- `.gitattributes` pins `*.sh` to LF so a Windows checkout does not break `sh`-invoked build scripts or their tests.
- `pnpm test:owner-native` and the Python/native tests need their documented environment. The Linux and Windows jobs in
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml) show the exact setup.
- `tests/ops` is not collected by the root `pnpm test` configuration. Do not treat a green package suite as an
  ops-contract result.

### Start the agent locally

```bash
export GRAM_AGENT_STATE_DIR="$HOME/.gram-agent"
export GRAM_AGENT_SECRET_DIR="$HOME/.config/gram-coding-agent/secrets"

mkdir -p "$GRAM_AGENT_STATE_DIR" "$GRAM_AGENT_SECRET_DIR"
chmod 700 "$GRAM_AGENT_STATE_DIR" "$GRAM_AGENT_SECRET_DIR"

secret="$GRAM_AGENT_SECRET_DIR/mcp-internal-secret"
if [ -e "$secret" ] || [ -L "$secret" ]; then
  if [ -L "$secret" ] || [ ! -f "$secret" ]; then
    printf 'refusing to use a non-regular secret path: %s\n' "$secret" >&2
    exit 1
  fi
  printf 'preserving existing internal MCP secret\n'
else
  umask 077
  tmp=$(mktemp "$secret.XXXXXX") || {
    printf 'failed to create a staging file\n' >&2
    exit 1
  }
  trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
  if ! openssl rand -hex 32 >"$tmp"; then
    printf 'failed to generate the internal MCP secret\n' >&2
    exit 1
  fi
  chmod 600 "$tmp"
  if ln -T -- "$tmp" "$secret" 2>/dev/null; then
    printf 'generated new internal MCP secret\n'
  elif [ -e "$secret" ] || [ -L "$secret" ]; then
    printf 'preserving existing internal MCP secret\n'
  else
    printf 'failed to create the internal MCP secret\n' >&2
    exit 1
  fi
  rm -f -- "$tmp"
  trap - EXIT HUP INT TERM
fi
if [ -L "$secret" ] || [ ! -f "$secret" ]; then
  printf 'refusing to use a non-regular secret path: %s\n' "$secret" >&2
  exit 1
fi
chmod 600 "$secret"

pnpm build
node apps/agent/dist/main.js
```

This start block preserves an existing regular secret. It rejects symlinks, including dangling links, and stages a new
secret in a private temp file before publishing it with a no-clobber hard link; a concurrent creator cannot be
overwritten. Credential rotation is a separate planned operation, not part of restart. To rotate, stop the agent and
tunnel, install a new secret through the deployment's credential process, update the tunnel's `X-Gram-Agent-Auth` file
reference, restart, and verify `/mcp`; do not rotate by rerunning the start block.

The default listener is `127.0.0.1:3847`. A controller sends `x-gram-agent-auth: <internal secret>` to `/mcp`:

```bash
curl -s http://127.0.0.1:3847/healthz
```

`/healthz` is unauthenticated after Host validation and reports only health metadata. The secret file must be a regular
file owned by the runtime user, mode `0600` or stricter, with no extra hard links; the file secret provider enforces
those properties.

For a systemd deployment, [`scripts/bootstrap-wsl.sh`](scripts/bootstrap-wsl.sh) renders the units in
[`systemd/`](systemd), creates the state/secret directories, and generates the internal secret only when the secret file
is absent; it preserves an existing file. It does not provision tunnel control-plane credentials. Those remain operator
steps, including `tunnel-client doctor` and real connector acceptance.

## Configuration

The current runtime reads environment variables. `config/agent.example.yaml` is an illustrative template and is **not**
loaded by the agent.

| Variable                            | Required | Meaning                                                                         |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `GRAM_AGENT_STATE_DIR`              | Yes      | SQLite database, lock files and recovery state                                  |
| `GRAM_AGENT_SECRET_DIR`             | Yes      | Directory containing `mcp-internal-secret` and other scoped credential files    |
| `GRAM_AGENT_OWNER_WORKSPACE_CONFIG` | No       | Canonical trusted JSON configuration for the owner filesystem/developer runtime |
| `GRAM_AGENT_EGO_BROWSER_MODE`       | No       | `disabled`, `windows`, or `native`; unset means off                             |
| `GRAM_AGENT_SMOKE_REPOSITORY_ID`    | No       | Enables the smoke/CI lock observer for a specific repository id                 |

The agent rejects the legacy `GRAM_AGENT_READONLY_PROJECT_ROOT` and `GRAM_AGENT_LOCAL_FS_ROOTS_JSON` settings; use the
native owner-workspace configuration instead.

Tunnel deployment configuration lives in [`config/tunnel-client.example.yaml`](config/tunnel-client.example.yaml). It
selects the official `tunnel-client`, loopback `/mcp`, and a file-backed internal header. The example documents a
restricted runtime key with Tunnels Read + Use; actual credential scope and connector behavior are deployment checks,
not repository facts.

## Security and policy design

### Current wiring and historical scope

`docs/security/policy-invariants.md` and `docs/security/threat-model.md` are pinned historical drafts (M2 SHA
`d886ce3b98520e4c594e8da73b14e0bed7dbac3e`, 2026-10-08), not descriptions of current `main`; both explicitly withhold M5
acceptance. Current `apps/agent/src/main.ts` composes `LinuxIsolatedProcessSpawner` for ordinary verification commands.
That spawner admits only a registered task workspace with a live, owned repository lease; rechecks authorization while
the command runs; launches `bwrap` with user/IPC/PID/network/UTS/cgroup namespaces, disabled user namespaces, dropped
capabilities, `--die-with-parent`, a clean environment, read-only system/runtime binds, a writable workspace bind,
bounded output (8 MiB) and a deadline; and validates root-owned entry executables plus a pinned runtime manifest. This
is a narrow command-execution profile, not "complete OS security": same-user processes, Windows helper admission, live
controller behavior and the full M5 acceptance remain unproven.

These controls are layered for a reason:

- **Loopback and a shared secret.** The tunnel is not the only boundary. A listener bound to a wildcard or LAN address,
  or an MCP endpoint without an application-level gate, would turn a transport/routing mistake into tool execution.
  Literal `127.0.0.1`/`::1` binding, SDK Host validation, and the `x-gram-agent-auth` check keep those failures local
  and authenticated.
- **Task-scoped worktrees and a repository lock.** The canonical checkout stays clean, each task has an isolated working
  tree, and two writers cannot mutate the same repository at once. Different repositories may run concurrently.
- **Policy before execution.** Shell composition is parsed before execution; the policy engine classifies risk, and the
  operation hash binds an approval to the effective command rather than to a display string. The parser rejects
  unmodeled composition rather than passing it through; residual wrapper/parser gaps are documented in the invariant
  register. Approvals are durable and single-use.
- **Secrets are kept out of state and output.** File-backed leases validate ownership, permissions, symlinks and hard
  links. Structured logging and command capture apply redaction. The design rule is that secrets never enter SQLite,
  logs, or MCP responses; lease and redaction controls implement that rule, with residual gaps documented in the
  invariant register.
- **Verification is snapshot-bound, not "tests passed" folklore.** A plan is derived from the changed paths and the
  repository profile; the workspace snapshot and HEAD are frozen; review candidates carry per-review digests; and
  publication checks sealed evidence for the exact content being published.
- **The lock is released only after remote confirmation.** A successful local push is not proof that the intended remote
  and branch contain the expected SHA. The publishing service confirms the remote ref before releasing the lease. An
  unconfirmed push leaves the lease held for recovery.
- **Typed owner tools instead of a generic Windows shell.** Owner filesystem operations are bounded, versioned, and
  consent-gated for sensitive changes. The configuration pins helper paths and hashes; requests cannot choose an
  executable or shell. This is an application boundary, not an OS sandbox.

The limits are part of the design:

- One authenticated controller trust domain; task IDs are correlation IDs, not tenant credentials.
- Ordinary verification commands are composed through `LinuxIsolatedProcessSpawner` only when the trusted sandbox
  profile is provisioned. That profile is not a complete OS sandbox or proof against same-user code; the historical M2
  register and threat model remain the place for unresolved boundaries and do not certify current `main`.
- MCP approval tools use the same authenticated domain as other tools; local authentication does not independently prove
  human consent.
- The `verification_review_*` tools prove input/evidence binding, not reviewer judgment.

Read the full register in [`docs/security/policy-invariants.md`](docs/security/policy-invariants.md) and
[`docs/security/threat-model.md`](docs/security/threat-model.md).

## What the tests cover, and what they do not

Repository test coverage includes:

- package unit and integration tests for policy, persistence, MCP tools, verification, publishing and task state;
- application composition tests using temporary state directories and a real loopback MCP listener;
- end-to-end flows against a fake GitHub server;
- security tests: TypeScript command-isolation and secret-boundary suites, Python boundary/build tests, and
  staged-runtime checks when the root-owned profile is provisioned;
- Linux/Windows native helper jobs in CI.

They do **not** establish:

- live ChatGPT/connector acceptance or a real OpenAI tunnel;
- effective production credential scope;
- real Windows Hello, protected-viewer admission, or installation ACLs;
- crash/recovery behavior on the target machine;
- complete OS isolation from same-user code;
- M5 acceptance.

The dated acceptance and evidence documents under [`docs/operations/`](docs/operations) describe what was and was not
exercised. They are evidence reports, not deployment certification.

## Current limitations

- Single authenticated controller domain; not multi-tenant.
- No web dashboard.
- Several MCP tool groups exist in `@gram/mcp` but are intentionally not wired into the current agent (see the
  active-surface section).
- Owner-workspace and Windows helper activation gates remain open.
- A plain development checkout can run unit/e2e checks, but not the security acceptance suite or real task verification,
  without the root-provisioned sandbox profile.
- The M2 security register and threat model are historical drafts; current `main` is not M5-accepted.
- The ego(lite) adapter is opt-in and not deployed.
- Production operation, SLAs and live environment acceptance are not claimed.

## Where to start reading

1. [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) — loopback listener, Host validation, authentication gate,
   health endpoint, lifecycle.
2. [`packages/mcp/src/tool-catalog.ts`](packages/mcp/src/tool-catalog.ts) — which port contributes which tools, and the
   `agent_health` fallback.
3. [`apps/agent/src/main.ts`](apps/agent/src/main.ts) — the real composition: database, services, trusted configuration,
   MCP ports, scheduler and shutdown.
4. [`packages/task-engine/src/task-runner.ts`](packages/task-engine/src/task-runner.ts) — the phase order and the
   dependency boundaries between orchestration and adapters.
5. [`packages/verification/src/verification-planner.ts`](packages/verification/src/verification-planner.ts) and
   [`packages/publishing/src/publishing-service.ts`](packages/publishing/src/publishing-service.ts) — how exact content
   is verified, sealed and published.
6. [`docs/security/threat-model.md`](docs/security/threat-model.md) and
   [`docs/security/policy-invariants.md`](docs/security/policy-invariants.md) — the historical M2 boundary and residual
   risks; read them together with the current-wiring note above.

Design questions this repository is meant to answer:

- How does an approval bind to the effective operation rather than a display command?
- Why must the repository lock survive an unconfirmed push?
- Why is accepted coding output not verification evidence?
- How can a controller inspect and modify a task without receiving ambient repository or credential authority?
- Which failures deliberately stop instead of falling back to a broader, unbounded capability?
