# External Coding Capability Implementation Plan

> **For agentic workers:** Use executing-plans and TDD; internal review replaces repeated human gates under the user's explicit autonomous-development instruction.

**Goal:** Replace unwired coding ports with authenticated task-bound external rendezvous and safe exact patches.
**Architecture:** Persist immutable step identities and terminal states; app service owns live waits and filesystem policy; MCP validates input and exposes the service behind existing auth.
**Tech Stack:** Node 24, TypeScript, SQLite, Vitest, pnpm 10.34.5
**Spec:** ../specs/2026-09-30-external-coding-capability-design.md

## Global constraints
- No credentials, model SDK, generic shell, live accounts, or lock release before confirmed push
- Preserve package direction and #158 immutable verification
- All external mutations require current task/workspace/lease and single-use step

## Review focus
- Restart after interrupted multi-file mutation must never silently replay
- Awaited steps must not hang graceful shutdown
- Symlink/metadata/config paths must not bypass task boundary
- Wrong-task IDs and concurrent submits must not claim another pending request
- Output rejection must precede any mutation

## Task 1: Durable step repository
Create persistence migration 002 and CodingStepRepository; test fresh/upgraded DB, immutable task/workspace/run binding, pending-to-applying compare-and-set, terminal outcomes and startup interruption. RED then GREEN and focused suite.

## Task 2: Runtime rendezvous and filesystem policy
Create external-coding-capability.ts and tests. Explicit Task UUID into InstructionsPort.load (compatible optional second parameter), local AGENTS digest acknowledgment, analysis path policy, all-patch validation before single-use application. Implement task/lease/workspace validation, bounded waits, failure and shutdown. RED then GREEN with real temp SQLite/filesystem fixtures.

## Task 3: Authenticated MCP and production composition
Create coding-capability-tools.ts and schema/handler tests. Register optional port on authenticated server; wire service in main, capability ports, close cancellation. Test actual MCP auth and schema validation without live external accounts. Add docs describing controller flow and explicit recovery limits.

## Task 4: Verify and independent review
Run pnpm test, test:e2e, lint, typecheck, build, shell syntax/backlog JSON. Fresh independent security/correctness review; reproduce significant findings with RED tests and fix, rerun full checks. Hold push until parent coordinates publication.

## Execution and review record

- Tasks 1–3 implemented with focused RED/GREEN evidence: schemas, task identity forwarding, authenticated tool registration, real mutation fixtures and production composition
- Independent review found four important boundary gaps; regression tests reproduced each before the fix: hidden credential/config paths, prefix-conflicting patches, lease expiry during validation/application, and lossy UTF8 byte aliases
- Added fresh AGENTS.md snapshot acknowledgment validation and real production shutdown regression
- Ruling: all hidden path segments are excluded in this bounded source capability, rather than attempting an incomplete credential-store allowlist; this intentionally blocks ordinary hidden configuration edits too
- Ruling: interrupted/partially applied mutations are terminal and require explicit inspection/recovery; no transparent process-restart resume is claimed
- Reviewed production GitHub helper integrated without expanding credentials or supported CI requirement sources
- Independent review cleared all Critical/Important findings; remaining documented limits keep #159/#77 open
