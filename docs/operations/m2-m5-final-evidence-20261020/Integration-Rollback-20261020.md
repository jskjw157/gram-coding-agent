# Integration and Rollback - 2026-10-20

Verdict: **FORMAL_GATE_BLOCKED**. Public functionality and the scoped security
boundary passed on `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16`. TASK-000009 completed and the original runtime was
restored. The remaining formal gate is #77's Private-repository condition; no
exception has been approved. This is not permission to merge, release or deploy.

The validated runtime SHA is the source candidate above. A subsequent docs-only
PR has its own SHA; documentation CI must not be represented as a new live run.
Evidence references below name files under the diagnostic evidence bundle.

## Reviewed integration path

| Component | Exact HEAD |
|---|---|
| [#135](https://github.com/jskjw157/gram-coding-agent/pull/135) M2 | `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` |
| [#196](https://github.com/jskjw157/gram-coding-agent/pull/196) CI observation | `db44c08881ce07d5b2c05000f3d93b36999a32ae` |
| [#213](https://github.com/jskjw157/gram-coding-agent/pull/213) Changed Paths | `0a51b69149abefd696a59a4054bb7e8ff7af9659` |
| [#214](https://github.com/jskjw157/gram-coding-agent/pull/214) lock observations | `f4c747128098fcb807d9455b0fe0c99dc39d3db8` |
| [#216](https://github.com/jskjw157/gram-coding-agent/pull/216) legacy binding | `13b3ab4ef278418927e9dd34fa11cba3e94ec8f3` |
| [#221](https://github.com/jskjw157/gram-coding-agent/pull/221) command isolation | `432b443b14045f13c6e85e87e256e640c05ad028` |
| [#222](https://github.com/jskjw157/gram-coding-agent/pull/222) bounded branches | `96d12b85c845188a123b3848152a122b6f3da10f` |
| [#223](https://github.com/jskjw157/gram-coding-agent/pull/223) origin confirmation | `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16` |

After explicit approval, component order is135 ->196 ->213 ->214 ->216 ->221 ->222
->223 -> final evidence documents. #215 is validation-only and must not be merged
again alongside duplicate component commits. #206/#208/#211 material is included
through221; #211's distinct-UID proposal is not fully implemented. This final
documentation branch includes #217's original commits and eight historical
documents unchanged through a local merge; do not duplicate #217 as an additional
merge step. Exclude unrelated parallel M3/M4/M5 work.

`m5-final-integration-main-9d1a3f8-20261020.json` at09:07:40.6179909Z records unchanged
heads and MERGEABLE observations for13 PRs. Main
`ba9fc6814711e983a11e58a09ed04e8337a4effe` is an ancestor; actual merge-tree and
candidate tree both equal `780b2f3fa00a9d5804e5e106918be1ad9a9a6f9a`.
No actual main merge occurred. Recheck remote state before integration. Changed
main, rebases, squashes or source changes require new resulting-SHA verification;
these observations cannot guarantee a future merge's content.

## Completed backup and restored operating state

The approved collector created verified online backups of both SQLite databases at
`/home/jskjw/.gram-agent/recovery/M5-TASK-000009-completed-20261020-l43j_24h/`.
Private `evidence.json` SHA256:
`20ca59b22acdd6a5b160da6b7858e04f9d69eb923f20d765c93e6954ed038a8f`.
Both backup/restored-copy integrity checks returned ok and table fingerprints matched.
Eight historical Tasks and related evidence, six historical worktrees and29 prior
journal rows were preserved. Independent final evidence audit returned CLEAR;
58 journal rows comprise29 old exact rows and29 new Task9 rows.

Restoration completed with actual external native MCP proof at09:13:15Z:
13 tools, healthy/ok/ready. Original build
`db44c08881ce07d5b2c05000f3d93b36999a32ae`, agent78194/tunnel78234, boot
`c29fe391-09ec-41d9-b5a3-8c8898e9796b`, active/running, zero automatic restarts.
At09:14:42.700235Z, fresh full-table fingerprints still matched both completed
backups; original configurations matched and only owned temporary overrides were
removed. No DB rollback or Task-evidence rewrite occurred. Independent read-only restoration
audit returned CLEAR: frozen original284 source/548 dist files, full runtime identity,
external correlation, completed DB/journal fingerprints, six historical worktrees,
zero locks and exact nine terminal Tasks all matched.

Portable evidence: `m5-final-runtime-restored-20261020.json`. Private records:
`/home/jskjw/.gram-agent/recovery/M5-v3-final-isolated-candidate-20261020-Laas4o/activation.json.restored.json`
and `external-restore.json`. The candidate is **not deployed**: the always-running
service is restored old db44 and does not gain candidate9d's new protection merely
because the temporary smoke passed.

## Safe integration and rollback procedure

Before any approved deployment, refresh main/PR heads and rerun gates for changed
content. Freeze exact source/dist/runtime manifests, original configuration,
process identities and verified online backups. Preserve existing successful and
failed Task/worktree/remote evidence. No destructive cleanup is part of integration.

Temporary validation used normal service stop with short SQLite writer barriers,
fresh terminal-state/fingerprint checks, owner/child/cgroup exit proof and exact
owned overrides. Any partial or mismatched state blocked subsequent actions.
Canonical root-owned env identity was pinned before start and rechecked through
forward pre-exec stages. Ready agent identity persisted through health/tunnel/
single-capture pending checks; actual external MCP finalized activation/restoration.
Frozen guard SHA `f532bca41610b461475bfaa619f31d5de2e9d377df5d3543330ef1338c02ee5f`.

If rollback is needed, restore only verified original code/config after checking
source/dist inventory, use normal stops, and keep completed DB state. Do not reset
worktrees, rewrite failed Task states, force-push, delete locks by age or replace
SQLite with an unverified backup. Exact lock recovery requires reviewed Task/repo/
lease/PID/boot matching and archives the file. No SIGKILL or automatic retries were
used to force acceptance. Release/deployment remains separately approved work.

## Preserved historical runs and repaired failures

TASK5 and TASK6 remain COMPLETED. Preserve [#217](https://github.com/jskjw157/gram-coding-agent/pull/217)
at `786e7de141c7f82500d4b5122238fa5991fabb0b` and its historical reports. TASK6's
173a3d0 success and14requests/28samples/1binding are not reused as9d evidence.

TASK7 (`01a15839-894e-7490-bf4a-cc1563fe4d65`) FAILED during PREPARING because its
long goal produced an overlong branch component. No Task worktree/coding/push was
created. #222 added a bounded ASCII component with deterministic hash suffix,
preserving short branch behavior. Backup and failure proof remain in
`/home/jskjw/.gram-agent/recovery/M5-TASK-000007-failure-20261020-ldgv8neh/`.
Its exact lock was archived/recovered; original runtime externally restored08:07:47Z.

TASK8 (`01a15865-3738-711c-8903-a12a1779153e`) FAILED after five checks passed and
commit/push `a227b9382bef7f56148386cb839c876710a67eaa` on repo1426674379.
Command553 used `ls-remote origin refs/heads/...`; the fixed Git capability admitted
only canonical URLs. No remote-confirm record or PR was created. #223 now admits
only literal origin or existing canonical URL forms, validates actual metadata/config,
then normalizes origin to the registered URL before credential acquisition.
Its pushed branch, commit and FAILED history are retained. Exact recovery evidence:
`/home/jskjw/.gram-agent/recovery/M5-TASK-000008-failure-20261020-ie_7spfs/`;
frozen resume helper `/usr/local/libexec/gram-task8-resume-20261020`.
Original agent73761/tunnel74411 were externally finalized restored08:52:36Z, locks0.

Operational attempts stopped safely on pre-exec timing, empty inactive cgroup,
canonical env resolution and readiness-continuity mismatches; repairs were reviewed
and tested. v2 registration initially refused missing-lockfile inference and then
used an explicit fixture profile. v3 uses a genuine npm-generated lockfile and
production Inspector/Profiler inference. No failure was converted into a fake PASS.

## Accepted scope and remaining formal decision

The actual Private probe repo1426564190 returned HTTP403 for branch protection at
07:26:44.097692Z: upgrade the plan or use Public. See
`m5-private-gate-refresh-20261020.json`. No billing, protection or acceptance criteria
were changed. Public success does not silently satisfy the original #77 requirement.
The user must choose a qualifying Private environment or explicitly approve a
Public exception; neither decision is implied by this report.

The implemented **linux-node-v1 offline command boundary** repairs the demonstrated
same-UID credential-file acquisition. It is not the distinct-UID ISO-01 broker
proposed in #211, atomic ISO-06 fencing, comprehensive Windows-host containment or
blanket full-M5 acceptance. Host user/root/kernel and trusted system/runtime packages
remain trusted. Network-dependent workloads and dependency installation are outside
this offline profile. These explicit scope limits are not unreported failed tests.
See `docs/security/command-isolation-implementation-20261020.md` at the candidate.
