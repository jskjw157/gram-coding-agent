# M2 release readiness - 2026-10-20

## Decision

**PUBLIC_FUNCTIONAL_PASS_FORMAL_GATE_BLOCKED.** Both M2 defects are repaired, the exact integration candidate passed the full repository gates and GitHub CI, and TASK-000006 completed the corrected-candidate Public Windows 11 / WSL2 live flow with independent PR/CI lock measurements. #77's original Private requirement has no approved exception. M5 #208's separate credential-file isolation failures remain unresolved. This is not `M2_RELEASE_READY` or permission to merge, release or close #77.

Runtime restoration is **RESTORED** at `2026-10-20T02:23:04.310804+00:00`: original build `db44c08881ce07d5b2c05000f3d93b36999a32ae`, Agent PID 2818 / tunnel PID 2962, active/running with zero automatic restarts. Actual external MCP confirmed 13 tools and healthy/ok/ready. Original effective configuration matches, temporary drop-ins are absent, DB/journal fingerprints match completed backups, and all 29 observation rows remain. The candidate was temporarily validated and is not left deployed.

## Reviewable stack and tested integration

| Artifact | Exact HEAD | CI evidence |
|---|---|---|
| [Existing M2 #135](https://github.com/jskjw157/gram-coding-agent/pull/135) | `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` | Included in tested candidate |
| [Existing CI evidence #196](https://github.com/jskjw157/gram-coding-agent/pull/196) | `db44c08881ce07d5b2c05000f3d93b36999a32ae` | Included in tested candidate |
| [Draft #213: approved Changed Paths](https://github.com/jskjw157/gram-coding-agent/pull/213) | `0a51b69149abefd696a59a4054bb7e8ff7af9659` | [38832838110 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38832838110) |
| [Draft #214: lock observations](https://github.com/jskjw157/gram-coding-agent/pull/214) | `f4c747128098fcb807d9455b0fe0c99dc39d3db8` | [38835990155 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38835990155) |
| [Draft #216: legacy approval guard](https://github.com/jskjw157/gram-coding-agent/pull/216) | `13b3ab4ef278418927e9dd34fa11cba3e94ec8f3` | [38837666171 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837666171) |
| [Draft #215: validation-only integration](https://github.com/jskjw157/gram-coding-agent/pull/215) | `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` | [38837663393 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837663393) |
| [Draft #217: evidence documents](https://github.com/jskjw157/gram-coding-agent/pull/217) | This Oct20 report revision; its published HEAD and verify run are recorded in the PR description/publication receipt after commit | Historical Oct16 report revision `7b76184b44a3c66788faace4de76127486621028` passed CI 38838260993 |

The integration candidate contains #135, #196, #213, #214 and #216, plus main `ba9fc6814711e983a11e58a09ed04e8337a4effe`. Its local merges were conflict-free and its synthetic merge-preview tree matched the published candidate tree. No M3/M4/M5 Draft source was integrated. PR #215 is validation evidence, not an alternative duplicate stack to merge alongside the component PRs.

After formal gates and explicit integration approval, the intended order is **#135 -> #196 -> #213 -> #214 -> #216 -> evidence documents**. Preserve ancestry and reconcile each stacked base after approved integration. A rebase, squash or changed main creates a different candidate; rerun the required gates and live validation on that resulting SHA. This report does not claim a future merge will equal the tested SHA.

## Executed verification

| Gate | Exact candidate `173a3d0` result |
|---|---|
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | 799 PASS / 76 files |
| `pnpm test:e2e` | 28 PASS / 6 files |
| `pnpm build` | PASS |
| Candidate GitHub CI | SUCCESS, run 38837663393 |
| Corrected-candidate real-device smoke | TASK-000006 COMPLETED |
| Actual required smoke CI | SUCCESS, run 39357215155 |
| Generated PR Changed Paths | Exactly `src/counter.ts`, matching actual diff |
| Independent live boundary measurements | 14 requests, 28 complete samples, one PR binding; DB/file locks absent |

The full repository command results were collected on October 16 in native WSL on Node 24; fresh October 20 source/dist manifest checks prove the same tested candidate was activated. They are not represented as a new full-suite execution. New tests are collected by root CI and the E2E command. The original mounted-filesystem timeout attempt remains preserved; commands, limits and assertions were not weakened.

TDD evidence covers exact external-review approval binding, legacy reference/path security, concurrent SQLite reads, provider boundaries, attribution, append-only persistence, error paths and legitimate other-Task lock presence. Independent whole-change review and final repair review returned APPROVE; final architecture re-review was CLEAR. The collector's attribution validator rejects 18 deliberately invalid fixtures and accepts the valid fixture. The separate acceptance validator and independent factual audit check the actual provider, DB and journal evidence; those checks are distinct from the collector's fixture tests.

Actual smoke used commit `41902d0b63a4d96c6ed40a84e8d3335b70071e56` in the disposable Public repository. It preserved `remote_confirm <= lock_release < pr_create <= ci_observe`, all five required PASS checks, required GitHub Actions verify success and COMPLETED. The [smoke report](m2-completion-smoke-evidence-20261020.md) and [portable receipt](evidence/2026-10-20-m2-completion.json) contain exact identities, timestamps and every boundary measurement.

## Unmet formal and security conditions

1. **Private repository acceptance:** Free/Public execution does not satisfy the original #77 Private condition. A qualifying Private run or an explicit criteria exception remains a user decision. No waiver or billing change was made.
2. **Separate credential-file isolation risk:** [M5 #208](https://github.com/jskjw157/gram-coding-agent/pull/208), reviewed at `70aeb057ac5a2c37a206e2d8152c7124b7d5b48d`, records 3 PASS / 3 FAIL in its dedicated security suite. Direct Node, descendant Node and npm test can read same-user credential canaries. Root CI does not collect those cases. M2 success is not overall security PASS; the risk needs resolution or explicit adjudication before release readiness.
The operational restoration gate is satisfied. One transient external timeout and the verified same-PID tunnel exec transition remain recorded in the smoke report; neither was erased or treated as a failed smoke. Final restoration used actual external proof and a reviewed guard, not local health alone.

Main merge, release tagging/deployment, #77 closure, protection relaxation and M3/M4/M5 integration remain unperformed. Historical Task1-5 evidence and failed worktrees are preserved. The new live result supersedes the old authentication blocker for this run without rewriting the [Oct16 historical report](m2-release-readiness-20261016.md).
