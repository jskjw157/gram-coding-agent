# M0–M1 Secure Runtime Acceptance

Date: 2026-09-16
Branch: `chore/m0-repository-foundation`
Draft PR: #131

This record follows the approved M0–M1 implementation plan. M2 must not begin until the remaining M1 review/backlog gate is satisfied.

## 1. Automated repository verification — PASS

Recorded automated acceptance evidence includes GitHub Actions `34951697070`, `34951949735`, and the post-review security regression run `35090002420`.

The following completed successfully on Node 24 with the frozen pnpm lockfile:

- `pnpm install --frozen-lockfile`
- `bash -n scripts/*.sh`
- backlog manifest JSON validation
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Component-level RED→GREEN evidence is recorded on the corresponding GitHub issues for domain identity, SQLite persistence, secrets/redaction, MCP authentication, Policy Engine, observability/application composition, and tunnel/systemd bootstrap.

## 2. M1 security acceptance matrix — PASS

Acceptance test: `tests/ops/m1-security-acceptance.test.ts`.

Dedicated matrix evidence: GitHub Actions run `34951441568`.

| Invariant | Expected | Result |
| --- | --- | --- |
| raw `powershell.exe` | `NEEDS_APPROVAL` | PASS |
| raw `pwsh.exe` | `NEEDS_APPROVAL` | PASS |
| raw `cmd.exe` | `NEEDS_APPROVAL` | PASS |
| `rm -rf /` | `DENY` | PASS |
| protected-branch force push | `DENY` | PASS |
| MCP request with missing internal secret | HTTP 401 | PASS |
| MCP request with wrong internal secret | HTTP 401 | PASS |
| MCP bind to `127.0.0.1` | allowed | PASS |

The M1 review additionally found that protected destinations expressed as Git refspecs could bypass the original exact-name check. Regression tests first reproduced the bypass for `HEAD:main`, `HEAD:refs/heads/main`, leading-`+` force refspecs, multiple refspecs, delete refspecs, targetless pushes, `--all`, `--mirror`, and wildcard refspecs. The classifier now normalizes explicit destinations, treats leading `+` as force, evaluates all refspecs, denies destructive wildcard/broad pushes, and approval-gates unresolved or broad non-destructive pushes. Full regression run `35090002420` passed install, lint, typecheck, all tests, and build.

## 3. Tunnel/systemd static acceptance — PASS

TDD static contract run: GitHub Actions `34950895998`.
Product-only CI after removing the temporary TDD workflow: `34951079516`.

Verified:

- `gram-coding-agent.service` has `Restart=on-failure`.
- `openai-mcp-tunnel.service` has `Restart=on-failure`.
- tunnel service starts after and requires the agent service.
- long-lived service definitions do not contain an OpenAI Admin API key.
- tunnel config targets `http://127.0.0.1:3847/mcp`.
- `X-Gram-Agent-Auth` is loaded through a file-backed secret reference.
- WSL bootstrap shell syntax passes.
- bootstrap creates protected state/secret directories and preserves existing secrets/credentials.
- the built agent has an executable service entrypoint.

## 4. Target LG Gram WSL2 runtime acceptance — PASS

Recorded on issues #31 and #34 from the actual LG Gram / WSL2 runtime:

- `gram-coding-agent.service`: active.
- `http://127.0.0.1:3847/healthz`: healthy; database OK and MCP ready.
- `openai-mcp-tunnel.service`: active.
- running `tunnel-client` PID 4357 owns `127.0.0.1:8080`.
- `mcp_server_reachable`: PASS; HTTP 401 without the internal secret confirms reachability plus internal-secret enforcement.
- `oauth_metadata`: PASS.
- the sole `health_listener` doctor failure occurred while the active tunnel daemon already owned port 8080. Active service and healthy application measurements confirm this was a diagnostic bind collision, not a runtime outage.
- deployed tunnel ID: `tunnel_6aa9fb8e249881918b1c21f63c9cf614`.
- runtime API key scope: Restricted, Tunnels Read + Use.
- no Admin API key is present in the long-running daemon.

Hardware/runtime acceptance issues #31 and #34 are completed.

## 5. Architecture invariant review

| Invariant | M0–M1 status | Evidence |
| --- | --- | --- |
| OpenAI `tunnel-client` is the sole ChatGPT MCP tunnel | PASS | static config + target runtime |
| MCP listens on loopback only | PASS | MCP tests + hardware evidence |
| long-running tunnel runtime has no Admin credential | PASS | static config + deployed credential scope |
| canonical Task ID is UUIDv7 | PASS | `@gram/domain` tests |
| human Task sequence is allocated atomically in SQLite | PASS | interleaved 100-task persistence test |
| secrets are file-isolated and redacted | PASS | `@gram/secrets` + logger tests |
| raw PowerShell/CMD is approval-gated | PASS | M1 security matrix |
| protected-branch force/delete bypasses are denied | PASS | expanded refspec regression suite |
| same-repo lock/worktree/push-confirm/release-before-PR invariants | M2 SCOPE | approved design unchanged |
| CI observation is lock-free | M2 SCOPE | approved design unchanged |

## 6. Evidence-driven backlog synchronization — PARTIAL PASS / PROJECT BLOCKED

Issue-state synchronization is complete from recorded evidence:

- M0 implementation issues #2–#5 are completed.
- architecture records #7–#12 remain completed.
- evidence-complete M1 implementation/acceptance issues #14–#34 are completed, excluding parent/synchronization/review gates that depend on this step.
- #31/#34 include the target hardware evidence above.

`scripts/github-status-sync.sh` is checked in and contract-tested. It maps only CLOSED M0–M1 issues to Project `Done` and preserves open issues unchanged. Root CI `35088896826` passed its contract tests.

Actual GitHub Project v2 materialization/projection is blocked by credentials, not application code:

- run `35089010285`: Project `Gram Coding Agent — Engineering` did not yet exist.
- run `35089086437`: backlog bootstrap reused all approved #1–#130 issues and then failed at `createProjectV2` because `github-actions[bot]` lacks permission to create the user-owned Project.
- repository secret `GH_PROJECT_TOKEN` was not present, so the workflow fell back to `GITHUB_TOKEN`.

Tracking issues #6 and #35 therefore remain open until a GitHub credential with Projects v2 write capability is used to materialize the Project and run the checked-in sync.

## 7. M1 review gate — IN PROGRESS

High-risk code review covered Policy/approval handling, MCP loopback/authentication, secret isolation/redaction, SQLite persistence, systemd/tunnel credential isolation, bootstrap behavior, and the application composition root.

A blocking Policy Engine finding was reproduced with RED tests, fixed, expanded with regression cases, and verified GREEN in GitHub Actions run `35090002420`. No additional blocking finding has been identified in the reviewed M0–M1 high-risk paths.

The remaining gate is administrative Project v2 synchronization (#35/#6) plus final PR review-gate recording (#36). PR #131 remains Draft and M2 must not begin until those are resolved.
