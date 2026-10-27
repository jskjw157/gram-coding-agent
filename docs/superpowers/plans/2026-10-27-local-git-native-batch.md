# Local Git native batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real Windows/WSL local Git status/diff/log finish through external MCP without weakening containment.

**Architecture:** Batch only identical-policy read requests through the fixed native helper; retain existing per-item containment and transport admission. Capture only metadata for Git commands that do not consume the worktree.

**Tech Stack:** Existing TypeScript/Node24, C++ Win32 helper, Python native tests, Vitest. No dependency additions.

**Spec:** ../specs/2026-10-27-local-git-native-batch.md

## Global Constraints

No generic Windows execution or MCP exposure changes. Keep Agent credentials protected, M5 isolation, original native/client bounds and watchdogs. Preserve all existing business files, Tasks, locks, DBs and historical evidence. No main merge, security bypass or manufactured acceptance.

## Review Focus

Untrusted child overrides/nesting; mixed policy roots; oversized response aggregation; queued promise/failure draining; metadata-only capture accidentally authorizing clean-worktree commands.

### Task 1: Native readonly batch (executor ownership)

Files: apps/windows-workspace-helper/main.cpp; tests/security/windows-workspace-native.test.py.
- [x] Add actual Windows RED tests for strict batch schemas, all-or-nothing policy denial, item order and original protections.
- [x] Implement bounded same-operation native dispatch through original perform().
- [x] Build real helper, run GREEN native tests, record exact binary digest/application-policy result.

### Task 2: Controller and metadata capture (root ownership)

Files: apps/agent/src/windows-workspace-transport.ts and tests; local-git-read-snapshot.ts and tests; trusted-git-spawner.ts and tests.
- [x] RED tests for reduced process launches, exact-policy grouping, queue/response bounds, single-route mutation behavior, failures and metadata-only reads.
- [x] Implement bounded coalescing without caching integrity or altering mutation semantics.
- [x] Wire request-specific snapshot capture; keep status/diff worktree coverage and command cleanliness guards.
- [ ] GREEN targeted tests, full lint/typecheck/unit/E2E/security/native/build, exact-head GitHub CI.

Native evidence: `guard-receipt.json` in the local diagnostics native-batch-e2bdbc9 directory records actual Windows RED/GREEN (28/28), /W4 /WX build and helper SHA `0a7547e7f981215251ffaf54ccca19db3e463da034de95a4b2043a3257000feb`.

- [x] Reproduce >1-MiB diff overflow, raise only private read-only diff capture to 8 MiB, prove application Git retains 1 MiB and >8-MiB diffs fail.
- [x] Real Git regression proves a synthetic credential beyond 1 MiB masks the entire preview before pagination and preserves source bytes.

### Task 3: Review and safe live validation (root ownership)

- [x] Independent source/security review: 0 findings, final transport10/10 and focused Git/redaction78/78 independently pass.
- [ ] Verify real helper admission/install plan and immutable candidate/config pins, existing Tasks/locks/processes and all-three-DB restored backups.
- [ ] Run exact candidate Git status/diff/log on mc-web read-only; preserve every historical failure.
- [ ] Guarded normal service transition only after mandatory gates; verify actual external MCP Git calls and DB/Task/lock preservation.
- [ ] Update PR240 and evidence report with exact final SHA, CI, live measurements and any explicit blocker.
