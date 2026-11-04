# Read-only database MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authorized read-only SELECT queries available from ChatGPT through Gram without changing existing file/Git/Task behavior.

**Architecture:** Optional typed MCP port, Agent composition, one selected-engine adapter and trusted named connection configuration. Internal SQLite persistence and command isolation remain unchanged.

**Tech Stack:** Existing TypeScript/Node24, MCPv2, Zod, SecretProvider, Vitest. DB engine/required driver awaits user answer.

**Spec:** ../specs/2026-11-04-readonly-database-mcp.md

## Global Constraints

No generic Windows execution, permission expansion, raw credentials in MCP/logs/SQLite, business DB writes, main merge, production service/config replacement or unrelated refactoring. Preserve all existing API behavior and Task/Lock/worktree evidence.

## Review Focus

Authentication before secret acquisition; unknown named connections/extra fields; mutation hidden in a SELECT/CTE; secret-bearing errors/results; cancellation, bounded streaming and cleanup without background work.

### Task 1: Optional MCP transport (bounded parallel executor)

Files: packages/mcp/src/tools/database-tools.ts and tests; packages/mcp/src/server.ts, server.test.ts, index.ts.
- [x] Add a failing real-MCP optional-catalog/query test, then implement the exact spec contract.
- [x] Validate strict payload/bind values and generic sanitized error behavior; no SQL execution in MCP package.
- [x] Confirm existing catalog without the optional port and existing suites remain unchanged.

### Task 2: Selected engine adapter and Agent composition (pending engine)

Files to select after DB engine answer: apps/agent/src/database-runtime.ts and tests, narrow trusted-config loader, main.ts composition/cleanup, required driver manifest/lock only if necessary.
- [ ] Resolve engine with user; document official driver and actual readonly semantics before code.
- [ ] RED -> GREEN selected-engine guard/secret/bounds/cancel tests and real DB fixture.
- [ ] Wire lazy runtime/optional config and clean close paths without changing other capabilities.

### Task 3: Review and acceptance

- [ ] Independent code/security review, repair and fresh targeted/full checks.
- [ ] Commit/push/Draft PR on exact candidate; final GitHub CI.
- [ ] Report implemented behavior, real DB/MCP evidence and unavailable live target/account evidence; no manufactured completion.

## Transport checkpoint (2026-11-04)

Clean base: 1,223 unit tests PASS. Optional transport: all 63 MCP tests PASS across 17 files; focused 26 PASS; MCP lint/typecheck/build PASS. Real authenticated MCP registration and cancellation RED/GREEN evidence is retained in local diagnostics `readonly-db/20261104-mcp/`. Independent review APPROVE with no remaining transport findings; cancellation uses installed SDK `context.mcpReq.signal`.

DB engine answer remains pending. No driver, business DB connection, SQL read-only guarantee, Agent composition, operational config/service change or deployment is claimed by this checkpoint. No additional provider was guessed or installed.
