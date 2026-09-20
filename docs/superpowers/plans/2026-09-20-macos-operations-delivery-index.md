# macOS Operations Agent — Delivery and Dependency Index

**Repository:** `jskjw157/gram-coding-agent`  
**Documentation PR:** #136, `docs/macos-operations-agent-design`  
**Date:** 2026-09-20 (Asia/Seoul)  
**State:** Planning checkpoint. MAC-01 has a concrete written plan ready for review; product implementation has not started.

## 1. Intended Outcome

The dedicated Apple Silicon Mac will operate HAAR: product/assets, storefronts, reports, orders/CS, advertising, files/Drive, browser/native-app workflows, and site/code maintenance. It is not limited to coding. Keep the single repository and shared core while preserving the existing Windows/WSL work.

The user agreed to continue after the written design checkpoint and repository audit. This authorizes preparing the next implementation plan, not silently enabling live account access, approving an unwritten plan, or merging a PR.

Parent design: `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md`.
Pinned handoff: `docs/operations/2026-09-20-macos-integration-checkpoint.md`.

## 2. Refreshed Baseline

At this planning pass:

- main remains `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.
- Windows PR #135 remains Draft/open/unmerged at `c7fc805511bd777059d93c6a8360596a934919dc`.
- Mac PR #136 was Draft/open/unmerged at `9fdc212ad9dc6c3c8204a5c65d1dbff47ddea219` before these plan files.
- No platform implementation package exists at the inspected Mac design head.
- Existing workspace discovery already includes `packages/*`, and root Vitest discovers `packages/*/vitest.config.ts`.
- Existing root CI runs on Ubuntu. It must remain intact; a focused native-Mac job is additive.

Read live refs again before execution. This index is not a continuously updated status feed.

## 3. Delivery Boundaries

| Increment | Working deliverable | Dependency / entry gate | Completion evidence |
|---|---|---|---|
| **MAC-01 Platform readiness** | Runnable secret-free diagnostic and pure, context-bound readiness evaluation | Reviewed parent direction and the written MAC-01 plan; independent of unmerged M2 code | RED/GREEN, root test collection, focused native-arm64 job, unchanged Windows/M2 diff |
| **MAC-02 Mac lifecycle** | Non-admin core/tunnel service packaging, staged startup/readiness and deterministic recovery checks | MAC-01; a separate reviewed lifecycle/installer design; actual Mac OS/runtime paths and credential context verified | Launchd install/uninstall/rollback tests, reboot/login/network outage evidence with test credentials; no security settings disabled |
| **MAC-03 Operations tasks** | Non-repository task resources, operational leases/checkpoints and side-effect reconciliation | Shared M2/M3 interfaces integrated, or explicitly reviewed dependency extraction; separate reviewed domain/migration plan | Existing CODING API preserved; migrations; crash/retry and duplicate-effect tests; no fake repo or second competing Task Engine |
| **MAC-04 Browser and credentials** | Aside/Playwright adapter selection, local credential-use broker and narrowly scoped GUI helper | MAC-01/02; reviewed authenticated IPC, signed helper identity, executor isolation, TCC and provider contracts | Isolation tests with fake secrets, account/domain checks, provider-switch revalidation, locked-vault and human-challenge tests before real credentials |
| **MAC-05 HAAR first workflow** | Inspect one product, assemble approved assets, prepare a local draft and evidence, stop before publication | MAC-03/04 plus an explicitly selected service/account and scoped operational grant | End-to-end product draft; retry does not duplicate writes; reviewable artifacts; no automatic payment, ad-budget change, refund or CS send |

Only MAC-01 is an executable implementation plan in this change. The other rows are ordered workstreams and acceptance boundaries, not partially specified implementation plans. Each needs its own written design/plan at the relevant entry gate; the unfinished broad product must not be disguised as a completed capability.

### Dependencies

```text
Reviewed main + MAC-01 plan
          |
          v
       MAC-01 --------> MAC-02
          |               |
          +---------------+----> MAC-04

Reviewed shared M2/M3 contracts --> MAC-03

MAC-03 + MAC-04 + live-operation grant --> MAC-05
```

MAC-01 does not wait for completion of all Windows milestones. Changes to the existing M2 TaskService, WorktreeService, persistence, policy or MCP contracts do wait for their reviewed integration. Keep the two rules separate.

## 4. Concrete MAC-01 Plan

`docs/superpowers/plans/2026-09-20-macos-platform-readiness.md`

It contains four independently testable tasks:

1. Add a workspace-discovered `@gram/platform` package with explicit host selection and Node24 checks.
2. Evaluate readiness using fresh, context-matching observations and provider-specific account state.
3. Ship a local `--json` diagnostic that reports unknown live capabilities honestly and never exports secret values.
4. Add test-collection/dependency guards, a separate standard Mac/Linux CI workflow and a target-machine evidence runbook.

The plan specifies exact paths, contracts, test cases, implementation code, RED/GREEN commands, commits, diff budget and acceptance. Code in the plan is proposed implementation material, not already committed product code or executed tests.

The proposal uses a 30-second readiness-evidence lifetime. This is not a new persistent scheduler or a change to existing repository lease/heartbeat timing.

## 5. Branch and Merge Rules

Planning continues in PR #136 on the existing documentation branch. Do not create duplicate design PRs or modify Windows PR #135.

After MAC-01 plan review, start the proposed short-lived `feat/macos-platform-readiness` branch in a separate worktree from the then-current reviewed main. Reference the exact reviewed spec/plan commit even if documentation PR #136 is still unmerged. No implicit documentation-PR merge is needed for an additive package.

The implementation PR may add only the new platform package, focused workflow, new operations document and the new lockfile importer. It must not restructure current WSL folders or edit M2 contracts. Inspect the main-to-branch diff before every publication. No main push, force push, branch deletion or merge is authorized by this planning checkpoint.

Use MAC-prefixed planning labels for discussion. Do not insert or renumber entries in the existing manifest-backed #1–#130 backlog without a separately reviewed issue mapping.

## 6. Security and Session Conditions Preserved

FileVault remains on; pre-unlock service availability is not assumed. GUI session, screen lock, user vault, browser process and website login are separate readiness conditions. Unknown state cannot be green merely to improve uptime statistics.

API/connectors are preferred; browser DOM is a fallback, and native UI automation is narrower still. A ChatGPT connector is not automatically a callable local-daemon API. A disconnected conversation does not provide continuing model decisions; only already-authorized deterministic work can continue without it.

No generic secret-read endpoint, browser-cookie copying by default, permission-bypass helper, silent credential-vault weakening or broad passwordless sudo. A dedicated user account is not sufficient isolation between untrusted repository code and operational credentials.

Readiness evaluation is not operation approval. Grants must still constrain account, operation, resource, material parameters and expiry. Live money, pricing, publication, ads, refunds, customer messages and destructive operations keep their explicit gates.

## 7. Verification Meaning

Planning verification checks document structure, required constraints, test/contract consistency, JSON/YAML blocks, secret/conflict-marker hygiene and the remote documentation-only diff. It does not execute the embedded TypeScript or provision a Mac.

CI started by a documentation-only update runs the existing repository workflow; even success does not validate the proposed future Mac workflow or execute tests that only appear in Markdown. Record its exact head and outcome separately.

Implementation evidence must distinguish:
- actual RED/GREEN task runs;
- unchanged root regression suite;
- focused GitHub-hosted Mac package checks;
- real user's Mac account/service/Keychain/GUI acceptance.

The last category remains NOT_RUN until observed on that machine. Do not equate hosted-runner privileges with the planned non-admin deployment.

## 8. Execution Handoff

Recommended method: native sequential implementation in a separate worktree, starting with Task 1 tests. No available independent reviewer is presumed. Keep any unreviewed implementation PR Draft and disclose the actual review coverage.

Review the MAC-01 written plan before execution. It intentionally enables safe Mac foundation work while Windows M2 continues, without prematurely onboarding real shopping-mall credentials.

## 9. Sources and Proposed Choices

Repository sources inspected for this pass:
- PR #135: https://github.com/jskjw157/gram-coding-agent/pull/135
- PR #136: https://github.com/jskjw157/gram-coding-agent/pull/136
- main package/workspace/Vitest/TypeScript/CI files at `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.
- parent Mac working design at `9fdc212ad9dc6c3c8204a5c65d1dbff47ddea219`.

Externally checked constraints used by MAC-01:
- https://nodejs.org/docs/latest-v24.x/api/process.html#processarch
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners

Increment boundaries, the proposed branch name, readiness contracts and the 30-second evidence lifetime are design choices, not facts claimed to be present in the repository.
