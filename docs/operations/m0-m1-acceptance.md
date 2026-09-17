# M0–M1 Secure Runtime Acceptance

Date: 2026-09-17
Branch: `chore/m0-repository-foundation`
PR: #131 — Ready for review

This record follows the approved M0–M1 implementation plan. All M0–M1 implementation, runtime, backlog synchronization, and review gates are complete. M2 remains a separate next phase and no merge is recorded here.

## 1. Automated repository verification — PASS

Recorded automated acceptance evidence includes GitHub Actions `34951697070`, `34951949735`, the post-review security regression run `35090002420`, and pre-final-documentation current-head run `35175255497`.

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

## 5. Architecture invariant review — PASS

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

## 6. Evidence-driven backlog and Project synchronization — PASS

The real user-owned GitHub Project v2 `Gram Coding Agent — Engineering` (project #4, Private) is materialized and the bootstrap/status-sync tooling was executed from the authenticated WSL environment.

Observed completion evidence:

- `scripts/github-backlog.sh --bootstrap` synchronized all 130 manifest-backed issues without duplication.
- existing issues and M0–M5 repository milestones were reused idempotently.
- labels, Project fields/items, sub-issues, dependencies, and architecture design Done state were synchronized.
- full Project item listing is loaded once per run and reused from in-memory state; newly added items reuse the returned item ID, with lightweight single-issue resolution only when needed.
- GraphQL rate-limit exhaustion is detected; the script waits until the reported GraphQL reset time and resumes the failed operation instead of terminating.
- `scripts/github-status-sync.sh` projected evidence-backed closed M0–M1 issues to Project `Done` and preserved then-open gate issues unchanged during the verification run.

The earlier `createProjectV2` credential blocker documented in runs `35089010285` and `35089086437` is resolved by the successful authenticated local run.

Tracking issues #6 and #35 are completed. After their completion, #32 and #36 were also closed from recorded evidence, and parent epics #1 and #13 were completed. A final status-sync rerun may be used only to refresh the Project display for those gate/parent issues closed after the verification run.

## 7. M1 review gate — PASS

High-risk code review covered Policy/approval handling, MCP loopback/authentication, secret isolation/redaction, SQLite persistence, systemd/tunnel credential isolation, bootstrap behavior, and the application composition root.

A blocking Policy Engine finding was reproduced with RED tests, fixed, expanded with regression cases, and verified GREEN in GitHub Actions run `35090002420`. No additional blocking finding was identified in the reviewed M0–M1 high-risk paths.

PR #131 contains a recorded COMMENT review for the M1 high-risk paths. No external reviewer identity/team was configured, so none was fabricated. Final gate #36 is completed, PR #131 has left Draft state, and no merge has been performed as part of this acceptance record.
