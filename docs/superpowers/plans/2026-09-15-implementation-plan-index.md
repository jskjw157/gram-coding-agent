# Gram Coding Agent Implementation Plan Index

> **For agentic workers:** Execute one plan at a time. Each plan is independently reviewable and produces a testable milestone. Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` when implementation begins.

**Spec:** `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`

## Execution order

1. `2026-09-15-m0-m1-foundation-secure-runtime.md`
2. `2026-09-15-m2-first-vertical-slice.md`
3. `2026-09-15-m3-reliability-recovery.md`
4. `2026-09-15-m4-windows-integration-ux.md`
5. `2026-09-15-m5-hardening-production-readiness.md`

Do not start M3/M4/M5 work to compensate for an incomplete M2 critical path. The first product milestone is the verified `task_create -> PR -> lock-free CI observe` vertical slice.

## Backlog mapping

| GitHub Milestone | Backlog issue range | Plan | Release gate |
|---|---:|---|---|
| M0 — Architecture & Repository Foundation | #1–#12 | M0–M1 plan | repo/CI/spec baseline |
| M1 — Secure Agent Runtime | #13–#36 | M0–M1 plan | authenticated loopback MCP + tunnel-client + policy |
| M2 — First End-to-End Coding Task | #37–#77 | M2 plan | `v0.1.0` |
| M3 — Reliability & Recovery | #78–#97 | M3 plan | `v0.2.0` |
| M4 — Windows Integration & Developer UX | #98–#112 | M4 plan | Windows/system UX acceptance |
| M5 — Hardening & Production Readiness | #113–#130 | M5 plan | `v1.0.0` |

### M0 design issues already complete

The GitHub backlog bootstrap must create/synchronize these issues and immediately mark them Done/closed with a comment pointing to the approved spec:

```text
#7  Write complete architecture specification
#8  Define SQLite schema and migrations
#9  Define MCP tool contracts
#10 Define Policy Engine rule specification
#11 Define task state machine
#12 Define vertical-slice acceptance criteria
```

They are documentation/design completion records, not new implementation work.

## Implementation technology decisions used by the plans

- Node.js 24 LTS is the pinned runtime line for v1 implementation.
- pnpm workspaces manage the monorepo.
- TypeScript 6+ is used because the stable MCP TypeScript SDK v2 requires TypeScript 6-era typing behavior.
- MCP server uses the stable v2 packages (`@modelcontextprotocol/server` plus the Node adapter), not the deprecated v1 monolithic package.
- SQLite adapter uses `better-sqlite3`; the approved schema and WAL/foreign-key requirements remain independent of the driver.
- UUID generation uses RFC9562 UUIDv7 from the `uuid` package.
- OpenAI `tunnel-client` is the sole ChatGPT-to-local MCP tunnel implementation.

## Critical invariants carried through every plan

```text
MCP listens on loopback only.
OpenAI tunnel-client only; no Cloudflare/Tailscale MCP alternative.
Runtime tunnel credential is Restricted Read + Use, never Admin.
Canonical Task identity is UUIDv7.
Same-repo mutation is serialized.
Normal edits happen in task worktrees, not canonical checkout.
Remote push is confirmed before Repo Lock release.
Repo Lock is released before PR creation and CI observation.
CI observation is lock-free.
CI repair reacquires Repo Lock before mutation.
Raw powershell.exe/pwsh.exe/cmd.exe stays approval-gated.
Typed Windows operations never expose arbitrary exec.
Protected-branch force push/delete is denied.
Dirty/unpushed/recovery worktrees cannot be auto-deleted.
Required verification must have evidence before VERIFIED/COMPLETED.
Secrets are not readable through a generic MCP secret tool.
```

## Review gates

At the end of each plan:

1. Run every plan-specific automated check.
2. Run root `lint`, `typecheck`, `test`, and `build`.
3. Verify the milestone's architecture invariants explicitly.
4. Record acceptance evidence in `docs/operations/`.
5. Update GitHub Project/Milestone issues only after evidence exists.
6. Request code review before merging the milestone branch/PR.

## Deferred future backlog

The following are intentionally not part of these v1 plans:

- web dashboard,
- distributed/multi-agent orchestrator,
- browser automation as a universal prerequisite,
- remote PostgreSQL state,
- arbitrary Windows command execution,
- alternative MCP tunnel providers.
