# M2 release readiness - 2026-10-16

## Decision

**BLOCKED_WITH_EVIDENCE.** Both targeted defects are repaired and the isolated
integration candidate passes all requested repository gates and GitHub CI. A new
authenticated live Task on that corrected candidate has **not** run: the runtime
GitHub credential receives HTTP 401. Historical Public TASK-000005 remains valid
functional evidence, but cannot prove the new observer or satisfy #77's original
Private repository condition. No release or formal acceptance is claimed.

## Reviewable changes and exact candidates

| Artifact | HEAD | Evidence |
|---|---|---|
| Existing M2 Draft #135 | `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` | Unchanged, open |
| Existing CI evidence #196 | `db44c08881ce07d5b2c05000f3d93b36999a32ae` | Unchanged, open |
| [Draft #213: Changed Paths](https://github.com/jskjw157/gram-coding-agent/pull/213) | `0a51b69149abefd696a59a4054bb7e8ff7af9659` | [CI 38832838110 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38832838110) |
| [Draft #214: independent observations](https://github.com/jskjw157/gram-coding-agent/pull/214) | `f4c747128098fcb807d9455b0fe0c99dc39d3db8` | [CI 38835990155 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38835990155) |
| [Draft #216: legacy approval repair](https://github.com/jskjw157/gram-coding-agent/pull/216) | `13b3ab4ef278418927e9dd34fa11cba3e94ec8f3` | [CI 38837666171 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837666171) |
| [Draft #215: final validation-only integration](https://github.com/jskjw157/gram-coding-agent/pull/215) | `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` | [CI 38837663393 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837663393) |

The first integration candidate `b076ae38e8313f8606afc44faa30cff02e51e69a` passed
all gates and [CI 38836228093](https://github.com/jskjw157/gram-coding-agent/actions/runs/38836228093).
Its parents are the observer candidate and current main
`ba9fc6814711e983a11e58a09ed04e8337a4effe`. Ancestry checks prove it contains all
four M2 component heads. That merge is conflict-free. Its delta from the observer
candidate contains only two HAAR decision/plan documents already on main; the
application, packages, tests and CI have no delta. The final candidate adds the
independently reviewed #216 repair through a second conflict-free local merge;
all five component heads are ancestors. No M3/M4/M5 Draft source was
integrated. Remote main and #135/#196 heads were rechecked unchanged.

PR #215 is a validation artifact, not permission to merge a duplicate M2 stack.
After acceptance and explicit user integration approval, the intended order is
#135, #196, #213, #214, #216, then these evidence documents. Preserve ancestry and
reconcile stacked PR bases after each approved integration. If rebase, squash or
new main changes alter the resulting SHA, rerun gates and live acceptance on the
actual resulting candidate. Do not infer that a future merge equals this SHA.

## Verification actually executed

| Gate | Observer `f4c7471` | Final integration `173a3d0` |
|---|---|---|
| `pnpm lint` | PASS | PASS |
| `pnpm typecheck` | PASS | PASS |
| `pnpm test` | 788 PASS / 76 files | 799 PASS / 76 files |
| `pnpm test:e2e` | 28 PASS / 6 files | 28 PASS / 6 files |
| `pnpm build` | PASS | PASS |
| GitHub `verify` | SUCCESS | SUCCESS |

These unchanged commands ran on Node v24.21.0 in a fresh native WSL checkout with
frozen pnpm installation. No test was skipped or softened. The first `/mnt/c`
attempt's root test failure is preserved separately: worker startup and existing
5-second tests timed out under mounted-filesystem I/O. It was not called GREEN;
the same commands and limits subsequently passed on the native filesystem and CI.

New persistence and agent tests are collected by root CI. The new metadata E2E
and both normal/observer vertical slices are collected by `pnpm test:e2e` in CI.
Focused ESLint also covers the three changed E2E files, which recursive package
lint does not collect. TDD receipts retain behavioral, unsafe legacy-path,
concurrent-snapshot, boundary, error-classification and scope REDs before GREEN.

The bounded cleanup expanded one nested endpoint classifier without changing
behavior; targeted 42 tests, lint, typecheck and build passed afterward. Final
independent code review inspected all 18 changed files and returned APPROVE with
zero findings, then independently approved the four-file repair delta. The final
architecture re-review is CLEAR after both WATCH items were repaired. Architectural
invariants are audited in the acceptance report; live evidence is a separate gate
from code approval.

## Remaining gates and permitted next steps

1. Restore an already-authorized runtime GitHub credential through a secure local
   operational path. Do not paste credentials into this report or silently copy
   the Windows controller's credential into the runtime. The exact rejection
   cause and prior runtime token scope are unknown; issuance or privilege changes
   require separate authority.
2. Revalidate the exact candidate build, agent/tunnel, integrity, zero outstanding
   locks and absence of active Tasks. The prepared unused Public fixture is
   repository `1421490705`, main `ef3cecd6234867a30411819071d68066fcf52cb0`.
3. Execute one real Task through required CI and COMPLETED with the observer
   enabled for that repository. Preserve its complete IDs, timestamps, immutable
   samples and online journal backup. No new Task currently exists.
4. Meet the original Private repository requirement or obtain an explicit
   acceptance exception. Free/Public functionality does not waive that condition.
5. Resolve or explicitly adjudicate the separate credential-file boundary risk
   evidenced by [M5 Draft #208](https://github.com/jskjw157/gram-coding-agent/pull/208).
   Its dedicated suite is 3 PASS / 3 FAIL, exit 1; ordinary allowed processes can
   read same-user credential canaries. Root CI does not collect those cases.
   Neither this M2 change nor root CI success establishes overall security PASS.

Only after these gates can release readiness be reconsidered. Main integration,
release tagging, deployment, #77 closure, protection relaxation and other milestone
integration were not performed.

The final candidate also passed isolated startup from an online backup: MCP13,
healthy/ok/ready, Node v24.21.0/npm11.19.0, zero observer samples and graceful
shutdown. Production Agent186 and tunnel491 were unchanged with zero restarts.
This was an ephemeral local MCP endpoint, not deployment through the tunnel and
not an authenticated coding Task. Fresh provider probes at
`2026-10-16T01:55:53.535Z` returned HTTP401 for `/user` and the new repository.

## Evidence locations

- [Portable sanitized receipt](evidence/2026-10-16-m2-completion.json)
- [Acceptance report](m2-completion-acceptance-20261016.md)
- [Real-device and historical smoke evidence](m2-completion-smoke-evidence-20261016.md)
- [Observer operation and interpretation](m2-live-smoke.md#opt-in-independent-boundary-evidence)
- Local receipts: `C:\source\gram-agent-diagnostics\m2-native-gates-20261016.json`,
  `m2-integration-gates-20261016.json`, `m2-integration-proof-20261016.json`,
  component/integration CI JSON and logs, TDD logs, and
  `m2-runtime-github-auth-blocker-20261016.json`.
- Final repaired candidate receipts use `m2-final-integration-*` and
  `m2-final-isolated-candidate-preflight-20261016.json`; earlier candidate receipts
  remain preserved. `m2-ci-preview-trees-20261016.json` proves the earlier PR
  synthetic merge-preview trees equal their published candidate trees.
- Preservation snapshot: `/home/jskjw/.gram-agent/recovery/M2-completion-20261016-rm1r5bq_`;
  registration backup: `/home/jskjw/.gram-agent/recovery/M2-repository-registration-20261016-VjqLyE`.

The Ultragoal plan and ledger live locally under `.omx/ultragoal/`. Supported
ledger annotations record progress, but checkpoints fail closed because the
existing native goal objective differs from the CLI's generated aggregate
objective. No objective, checkpoint or goal completion was fabricated. This
workflow limitation does not replace any technical acceptance evidence.
