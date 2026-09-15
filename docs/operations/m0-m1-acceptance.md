# M0–M1 Secure Runtime Acceptance

Date: 2026-09-15
Branch: `chore/m0-repository-foundation`
Draft PR: #131

This record follows the approved M0–M1 implementation plan. It distinguishes automated evidence already proven in GitHub Actions from target-LG-Gram WSL2 checks that require the actual machine. M2 must not start until the M1 review gate is satisfied.

## 1. Automated repository verification — PASS

Latest branch-head acceptance run: GitHub Actions `34951697070`.

The following steps completed successfully on Node 24 with the frozen pnpm lockfile:

- `pnpm install --frozen-lockfile`
- `bash -n scripts/*.sh`
- backlog manifest JSON validation
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Earlier component-level RED→GREEN evidence is recorded on the corresponding GitHub issues for domain identity, SQLite persistence, secrets/redaction, MCP authentication, Policy Engine, observability/application composition, and tunnel/systemd bootstrap.

## 2. M1 security acceptance matrix — PASS

Acceptance test: `tests/ops/m1-security-acceptance.test.ts`.

Dedicated matrix evidence: GitHub Actions run `34951441568`.
The same test remains in the suite that passed at the final branch head in `34951697070`.

| Invariant | Expected | Result |
| --- | --- | --- |
| raw `powershell.exe` | `NEEDS_APPROVAL` | PASS |
| raw `pwsh.exe` | `NEEDS_APPROVAL` | PASS |
| raw `cmd.exe` | `NEEDS_APPROVAL` | PASS |
| `rm -rf /` | `DENY` | PASS |
| `git push --force origin main` | `DENY` | PASS |
| `git push --force-with-lease origin main` | `DENY` | PASS |
| MCP request with missing internal secret | HTTP 401 | PASS |
| MCP request with wrong internal secret | HTTP 401 | PASS |
| MCP bind to `127.0.0.1` | allowed | PASS |

## 3. Tunnel/systemd static acceptance — PASS

TDD static contract run: GitHub Actions `34950895998`.
Final product-only CI after removing the temporary TDD workflow: `34951079516`.

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

## 4. Architecture invariant review

| Invariant | M0–M1 status | Evidence |
| --- | --- | --- |
| OpenAI `tunnel-client` is the sole ChatGPT MCP tunnel | PASS (static/runtime design) | tunnel config, systemd unit, operations runbook |
| MCP listens on loopback only | PASS | MCP tests + M1 security acceptance matrix |
| long-running tunnel runtime does not carry an Admin credential | PASS (static) | systemd/config/bootstrap contract tests |
| canonical Task ID is UUIDv7 | PASS | `@gram/domain` tests |
| human Task sequence is allocated atomically in SQLite | PASS | interleaved 100-task persistence test |
| secrets are file-isolated and redacted | PASS | `@gram/secrets` tests + structured logger tests |
| raw PowerShell/CMD is approval-gated | PASS | M1 security acceptance matrix |
| protected-branch force push is denied | PASS | M1 security acceptance matrix |
| same-repo lock/worktree/push-confirm/release-before-PR invariants | NOT YET IMPLEMENTED | M2 scope; must remain unchanged when M2 starts |
| CI observation is lock-free | NOT YET IMPLEMENTED | M2 scope; approved architecture invariant |

## 5. Target LG Gram WSL2 runtime acceptance — PENDING

This section cannot be completed by GitHub Actions because it must exercise the actual Windows 11 LG Gram + WSL2 systemd environment and installed OpenAI tunnel runtime credential.

Run on the target Gram after `scripts/bootstrap-wsl.sh` and runtime credentials are installed:

```bash
tunnel-client --version
tunnel-client doctor --config /etc/gram-coding-agent/tunnel-client.yaml --explain
systemctl is-active gram-coding-agent
systemctl is-active openai-mcp-tunnel
curl -fsS http://127.0.0.1:3847/healthz
```

Required results:

- `tunnel-client doctor` succeeds.
- `gram-coding-agent` is active.
- `openai-mcp-tunnel` is active.
- `/healthz` succeeds and reports a healthy database and ready MCP service.

Tracking issues: #31 and #34.

## 6. Evidence-driven GitHub Project synchronization — PENDING

Architecture/design records #7–#12 are already complete and remain Done.

Implementation Project status synchronization must not mark M0/M1 implementation work Done until the target runtime acceptance above has evidence. After #34 passes, run:

```bash
scripts/github-backlog.sh --sync-status
```

Then verify that only evidence-backed implementation issues are moved to Done. Tracking issue: #35.

## 7. M1 review gate — BLOCKED

Automated code/security verification is green. The M1 review gate remains blocked by:

1. target Gram tunnel/systemd/runtime evidence (#31, #34),
2. evidence-driven backlog/Project synchronization (#35),
3. final code review request and review-gate verification (#36).

M2 implementation must not begin before these gates are satisfied.
