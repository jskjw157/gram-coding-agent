# macOS integration checkpoint — 2026-09-20

**Purpose:** Resume Mac operations design without disturbing the Windows/WSL implementation.  
**Scope:** Repository/PR/CI inspection and documentation only. Not a full code security audit or target-machine test.  
**Design:** `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md`  
**Branch:** `docs/macos-operations-agent-design`

## 1. Verified GitHub snapshot

| Item | Observed state |
|---|---|
| main | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` |
| M0/M1 PR #131 | Closed/merged; merge SHA is the main SHA above |
| Windows M2 branch | `feat/m2-vertical-slice` at `c7fc805511bd777059d93c6a8360596a934919dc` |
| M2 PR #135 | Open, draft, not merged; progress record covers Tasks 1–7 |
| M2 next issue | #58, change-aware Verification Engine, open |
| Recorded M2 CI | Run `35329853818`, completed/success, exact head `c7fc8055…` |
| Mac branch before this revision | `f0de2f5337a59da79fd3e5d0b96328101cd14cf1` |
| Mac/main comparison before revision | Ahead 1, behind 0; one added design file, no product-code changes |
| M2/main comparison | Ahead 97, behind 0; 83 changed files |
| Open PRs before Mac design PR | #135 only |

The prose in #131 still contains a pre-merge sentence saying “not merged”; the actual `merged=true`, `merged_at` and merge SHA are the authoritative lifecycle fields. Do not resume old M1 blockers from that stale prose.

Sources:
- https://github.com/jskjw157/gram-coding-agent/pull/131
- https://github.com/jskjw157/gram-coding-agent/pull/135
- https://github.com/jskjw157/gram-coding-agent/issues/58
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35329853818
- https://github.com/jskjw157/gram-coding-agent/compare/fdf5dda2211e011e473f1c89095b78d7cb565c2f...f0de2f5337a59da79fd3e5d0b96328101cd14cf1
- https://github.com/jskjw157/gram-coding-agent/compare/fdf5dda2211e011e473f1c89095b78d7cb565c2f...c7fc805511bd777059d93c6a8360596a934919dc

## 2. Actual integration seams

### Task creation is coding-specific

At the inspected M2 commit, `TaskService.create()` requires a nonempty `repo`, defaults publishing to `PULL_REQUEST`, and writes `taskType: 'CODING'` into persistence/audit. A product-review or advertising-report task cannot simply reuse that input unchanged.

Direction: preserve the existing coding contract and add an explicit operations resource model through a reviewed additive migration. No fake Git repository for shopping-mall tasks; no second unrelated Task Engine.

Source: https://github.com/jskjw157/gram-coding-agent/blob/c7fc805511bd777059d93c6a8360596a934919dc/packages/task-engine/src/task-service.ts

### Workspace creation is WSL-specific

`PathMapper` invokes the injected WSL conversion runner. `WorktreeService.create()` unconditionally calls `toWindows()` and persists/returns `linuxPath` and `windowsPath`.

Direction: platform-native paths and optional external display paths, with compatibility tests for existing WSL consumers. Do not rename fields or rewrite the current migration while PR #135 is in progress.

Sources:
- https://github.com/jskjw157/gram-coding-agent/blob/c7fc805511bd777059d93c6a8360596a934919dc/packages/workspace/src/path-mapper.ts
- https://github.com/jskjw157/gram-coding-agent/blob/c7fc805511bd777059d93c6a8360596a934919dc/packages/workspace/src/worktree-service.ts

### Current platform files must stay stable

Keep existing WSL installation/service entry paths and the `AGENTS.md` invariants intact. A Mac adapter does not grant permission to disable policy, expose secrets, publish directly to main or hold Repo Lock through PR/CI observation.

Sources:
- https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/AGENTS.md
- https://github.com/jskjw157/gram-coding-agent/blob/fdf5dda2211e011e473f1c89095b78d7cb565c2f/docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md

## 3. Documentation changes in this checkpoint

The working design now records:

- separate branch versus permanent platform-folder responsibilities;
- the M2 merge/dependency boundary and concrete coding/WSL coupling;
- FileVault-preserving staged core, GUI, vault and browser recovery;
- daemon-compatible versus user-context secret use;
- Aside native credential autofill versus our own Keychain broker;
- provider fallback without assuming cookie/session portability;
- durable task checkpoints, remote-effect reconciliation and bounded retries;
- human challenges, account identity checks and live-operation approvals;
- the difference between ChatGPT connectors and local unattended API capability;
- the need to isolate code execution from operational secrets;
- explicit pending hardware, IPC, permission and credential validation gates.

No Mac product code, installer, credential, browser profile or account permission is created by these documents. The working spec remains DRAFT. The proposed increment order is not an executable implementation plan.

## 4. Non-conflicting next work

1. Complete review of the written Mac spec and resolve the security/provider gates applicable to the first increment.
2. Derive the concrete implementation plan; identify files, compatibility tests and target-Mac checks before code changes.
3. Start a short-lived Mac feature branch from the then-current reviewed main. Leave the Windows M2 branch and issues alone.
4. Add platform contracts/readiness and Mac lifecycle incrementally. Shared M2 contract changes wait for its integration or a separately agreed dependency extraction.
5. Validate a non-publishing HAAR product/assets/draft workflow before enabling live writes.

Do not create or renumber Mac issues inside the existing manifest-backed #1–#130 backlog without a reviewed mapping. Do not close #58, mark #135 ready, or merge either branch as a side effect of this checkpoint.

## 5. Verification meaning

This review directly read GitHub branch refs, PR metadata, comparisons, the Mac draft, AGENTS.md, the approved Windows architecture, selected M2 source files, issue #58 and the exact Actions run above. Official Apple, Aside and Playwright sources were checked for the corrected platform assumptions and are listed in the design.

Documentation validation for this change consists of checking required sections/invariants, balanced fenced blocks, conflict-marker absence and secret-placeholder hygiene, then reading back the remote change and confirming that the diff is documentation-only.

The recorded M2 success is historical CI evidence freshly queried, not a new test execution. Product lint/typecheck/test/build and real Mac/WSL acceptance are not rerun by this documentation audit. Any CI run triggered by the design PR must be reported separately at its observed state.

## 6. Handoff rule

Refresh branch heads, open PRs and this design before continuing. If another session changed a file/ref, use its latest contents and do not overwrite it. Keep written-spec approval, implementation-plan approval and implementation verification as separate milestones. Report remote commit/PR identifiers only after their writes and read-back checks succeed.
