# Read-only database MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authorized read-only SELECT queries available from ChatGPT through Gram without changing existing file/Git/Task behavior.

**Architecture:** Optional typed MCP port, Agent composition, one selected-engine adapter and trusted named connection configuration. Internal SQLite persistence and command isolation remain unchanged.

**Tech Stack:** Existing TypeScript/Node24, MCPv2, Zod, SecretProvider, Vitest. Selected engines: MySQL/MariaDB; pinned official mariadb connector and node-sql-parser.

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

### Task 2: MySQL/MariaDB adapter and Agent composition

Files to select after DB engine answer: apps/agent/src/database-runtime.ts and tests, narrow trusted-config loader, main.ts composition/cleanup, required driver manifest/lock only if necessary.
- [x] Resolve engine with user; document official driver and actual readonly semantics before code.
- [x] RED -> GREEN selected-engine guard/secret/bounds/cancel tests and real DB fixture.
- [x] Wire lazy runtime/optional config and clean close paths without changing other capabilities.

### Task 3: Review and acceptance

- [x] Independent code/security review, repair and fresh targeted/full checks.
- [ ] Commit/push/Draft PR on exact candidate; final GitHub CI.
- [ ] Report implemented behavior, real DB/MCP evidence and unavailable live target/account evidence; no manufactured completion.

## Transport checkpoint (2026-11-04)

Clean base: 1,223 unit tests PASS. Optional transport: all 63 MCP tests PASS across 17 files; focused 26 PASS; MCP lint/typecheck/build PASS. Real authenticated MCP registration and cancellation RED/GREEN evidence is retained in local diagnostics `readonly-db/20261104-mcp/`. Independent review APPROVE with no remaining transport findings; cancellation uses installed SDK `context.mcpReq.signal`.

DB engine answer remains pending. No driver, business DB connection, SQL read-only guarantee, Agent composition, operational config/service change or deployment is claimed by this checkpoint. No additional provider was guessed or installed.

## Selected-engine validation (2026-11-04)

The user selected MySQL/MariaDB after the transport checkpoint. The optional Agent composition, protected named configuration, server-prepared streaming SELECT subset and read-only account/transaction checks are implemented. Real TLS-enabled MySQL8.4 and MariaDB10.11 fixtures pass40/40, including cancellation with independent server-process checks, precision, bounded output, grants, TLS failures and credential text/binary screening. Policy82, configuration26, cleanup-boundary9 and composition/main29 targeted tests pass.

Independent review identified binary screening and cleanup/shutdown defects; regression RED evidence preceded the repairs. Full checks, exact-candidate CI and final review are tracked separately below. No business DB credentials/endpoints or production activation are inferred from disposable fixture success. Existing MCP SDK/Zod dependency-audit advisories require separate scope approval before common-layer changes.

Full local verification and independent scoped approval: see `docs/operations/readonly-database-evidence-2026-11-04.md`. Exact commit CI and actual business endpoint acceptance remain separately tracked.
