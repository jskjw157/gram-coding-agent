# M2 completion acceptance evidence — 2026-10-16

## Disposition

**BLOCKED_WITH_EVIDENCE.** TASK-000005 establishes historical Public end-to-end functional success. The repaired code and integration candidate have full repository and CI evidence, but the corrected candidate has not completed a new authenticated live smoke. Runtime GitHub authentication returns HTTP 401. The original #77 Private repository requirement also remains unmet and has no approved exception.

This report does not close #77, authorize a merge or release, or convert deterministic test results into live acceptance. The code and integration results below are verified; the new authenticated live run and formal gates remain open.

## Historical evidence preserved

Task `01a13895-d4f0-7659-98d5-c53c06fed32c` (TASK-000005), repository `1418288277`, completed on 2026-10-14 at `04:07:04.305Z`. Its commit is `9c786a29167c1cf58a51f66952e6640bfb2d2f54`.

- [Original smoke PR #1](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/pull/1)
- [Actual successful Actions run 38509721619](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/actions/runs/38509721619)
- Original collection: `C:\source\gram-agent-diagnostics\TASK-000005-acceptance.md` and its `-db.json`, `-github-pr.json`, `-github-files.json`, `-github-checks.json`, `-github-run.json`, `-github-protection.json`, and `-pr-body-projection.json` companions.

Verification Plan 3 has five required PASS rows: lint 11 / command 193; test 12 / command 204; build 13 / command 215; secret-scan 14 / accepted external review; diff-review 15 / accepted external review approving only `src/counter.ts`. Commands exited zero; the target test had one pass and no skips. The committed file OID matched the sealed verification snapshot. The old report and raw evidence remain historical records, not documents to revise with newly inferred observations.

The required check was GitHub check `115675197253`, app `15368` (`github-actions`). The final CI row is 2. Its `provider_run_id` is the check suite ID `104347685892`; the actual Actions run ID is `38509721619`. These identifiers must not be conflated.

## Remaining defect: approved changed paths

TASK-000005's original body rendered `Changed Paths: None recorded` because the persistence projection recognized only `diff-review:` references, while its accepted check used `external-review:`. The original PR body was not manually repaired.

[Draft PR #213](https://github.com/jskjw157/gram-coding-agent/pull/213) has HEAD `0a51b69149abefd696a59a4054bb7e8ff7af9659`. [CI run 38832838110](https://github.com/jskjw157/gram-coding-agent/actions/runs/38832838110) is **completed/success** on that exact HEAD, confirmed by a direct GitHub run query. This is component-PR evidence, not validation of an untested combined candidate.

The correction reuses the sealed verification-plan validator. It binds approved paths to the Task, latest Plan, reviewed baseline HEAD, Check, accepted PASS Review, sealed snapshot and workspace. The reviewed baseline is deliberately distinct from the later published commit. External evidence cannot be overridden by unapproved metadata or downgraded to legacy fallback. Valid legacy evidence remains supported; public output rejects unsafe paths and recognizable credential strings. An outer SQLite read transaction prevents concurrent plan changes from mixing checks and paths.

Observed development evidence:

| Gate | Observed result | Diagnostic artifact |
|---|---|---|
| Initial behavioral RED | 6 failures | `m2-paths-red.log` |
| Legacy path safety RED | 7 failures | `m2-paths-legacy-red.log` |
| Separate-connection WAL RED | Old checks/new paths reproduced | `m2-paths-snapshot-red.log` |
| Persistence tests | 106 PASS, including 43 new regressions | `m2-paths-snapshot-green.log` |
| Persistence lint/typecheck | PASS | `m2-paths-lint.log`, `m2-paths-typecheck.log` |
| External review to actual metadata/PR service | PASS | `m2-paths-e2e-green.log` |

The dedicated path-fix PR records an independent review approval after the WAL consistency issue was repaired. Final whole-code independent review returned APPROVE with zero findings across 18 changed files; see the final review and invariant audit below.

## Remaining gap: independent lock observations

Historical Task 5 has release audit evidence and correct event ordering, but no contemporaneous independent DB/file lock measurements. No historical samples have been generated retroactively.

The new opt-in smoke observer reads operational SQLite through a separate read-only connection, checks the canonical lock file, and commits observations to a separate append-only SQLite journal. Provider calls receive BEFORE and AFTER measurements, with repository, Task, confirmed HEAD, correlation/request IDs, endpoint, timestamps and presence fields. PR lookup/create occurs before an internal PR row exists; a validated post-persistence PR_BINDING record connects those samples to the internal row. CI samples carry the internal PR row ID.

Presence is observational evidence, not a new global no-lock policy: a different Task may legitimately acquire the repository lock while CI is being observed. Boundary samples prove the sampled instants; they do not prove continuous absence throughout a network request. Neither DB and file checks nor different samples are claimed to occur at one atomic instant.

The full deterministic vertical slice retains its original assertions and adds a production-composition observer variant. On the observed fixture it performs real local Git commit/push/remote confirmation and reaches COMPLETED. A third read-only SQLite connection verifies **10 actual HTTP fixture requests, 20 committed boundary samples and one PR_BINDING**, all tied to the exact Task/repository/confirmed SHA. All sampled DB/file locks are absent. PR find/create, rules, statuses, protection and check-runs endpoints are covered. `pnpm test:e2e`: **28 PASS in 6 files**; scoped E2E lint passes. Artifact: `m2-observer-e2e.log`.

[Draft PR #214](https://github.com/jskjw157/gram-coding-agent/pull/214), HEAD `f4c747128098fcb807d9455b0fe0c99dc39d3db8`, passed [CI 38835990155](https://github.com/jskjw157/gram-coding-agent/actions/runs/38835990155). These deterministic results are not a fresh credentialed live smoke.

## Full gates and integration

The initial root gate receipt `m2-root-gates-20261016.json` records lint exit 0, typecheck exit 0 and root test exit 1. It is not an all-green receipt, and it predates final integrated changes. The unchanged commands subsequently passed on native WSL for both observer `f4c7471` and integration `b076ae3`: lint, typecheck, 788 unit tests / 76 files, 28 E2E / 6 files and build. Exact receipts are `m2-native-gates-20261016.json` and `m2-integration-gates-20261016.json`. Both exact heads also passed GitHub CI. No timeout, skip or expectation was changed.

The requested integration bases are #135 at `d886ce3b98520e4c594e8da73b14e0bed7dbac3e` and #196 at `db44c08881ce07d5b2c05000f3d93b36999a32ae`. PR #213 is stacked on #196. [Validation-only Draft #215](https://github.com/jskjw157/gram-coding-agent/pull/215) preserves the earlier combined SHA `b076ae38e8313f8606afc44faa30cff02e51e69a`, the conflict-free local merge of #214 and current main `ba9fc6814711e983a11e58a09ed04e8337a4effe`. Ancestry proves #135/#196/#213/#214 inclusion. [CI 38836228093](https://github.com/jskjw157/gram-coding-agent/actions/runs/38836228093) is SUCCESS. Only two already-landed HAAR documents differ from #214. Remote main and #135/#196 remain unchanged. The [release report](m2-release-readiness-20261016.md) specifies the ordered integration and revalidation gates; no remote main merge occurred.

[M5 PR #208, Actual result](https://github.com/jskjw157/gram-coding-agent/pull/208), directly read at HEAD `70aeb057ac5a2c37a206e2d8152c7124b7d5b48d`, reports the dedicated security suite **3 PASS / 3 FAIL, exit 1**. Environment filtering passes; direct Node, descendant Node and genuine npm test can each read agent-owned credential canary files, violating the unchanged no-read expectations. Root CI does not collect these six dedicated cases, so its success is not security acceptance. The PR also limits its evidence to its Linux fixture rather than a native non-root Windows/WSL acceptance run. This task has not rerun or integrated that M5 suite. Its unresolved filesystem/credential boundary risk remains a separate security blocker, not an M2 security pass. M3/M4/M5 Draft PRs are outside this integration scope; their changes and security conditions must not be silently absorbed or waived.

## Final repair and invariant audit

The final architecture pass found two non-blocking issues, then both were repaired:
legacy path projection now requires a required PASS diff-review reference and
cannot prefer task metadata; the documented journal schema now matches actual
camelCase fields and endpoint phase discrimination. [Draft #216](https://github.com/jskjw157/gram-coding-agent/pull/216)
has HEAD `13b3ab4ef278418927e9dd34fa11cba3e94ec8f3`. Eleven new RED cases became
GREEN; persistence is now 117 PASS. The existing GitHub projection fixture was
strengthened with unauthorized metadata and an actual required PASS legacy review,
preserving its expected approved paths (RED to GREEN).

The final integration candidate is `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9`,
which adds that repair to the earlier `b076ae3` validation candidate through a
normal local merge. PR #215 now points to this final SHA. All five unchanged native
WSL gates pass (799 unit tests / 76 files; 28 E2E / 6 files); the old candidate receipts remain preserved separately. The final
architecture re-review is **CLEAR**, and bounded cleanup found no further changes.

| Invariant | Implementation / executable evidence | Acceptance limit |
|---|---|---|
| Remote confirm precedes release | PublishingService; normal and observed vertical E2E ordering | Historical Task5 also proves ordering; new live pending |
| PR/CI outside mutation lock | TaskRunner composition; every fixture provider call and 20 independent samples | No retrospective Task5 samples |
| External paths are approved and exact-bound | getBoundPlan; Task/plan/HEAD/check/review/snapshot/workspace regressions | Published SHA is distinct from reviewed baseline |
| Legacy compatibility preserves approval | Required PASS valid diff-review reference; 11 new regressions | Metadata-only changedPaths intentionally ceases to authorize paths |
| Independent evidence attribution | Separate read-only SQLite, exact-file lstat, validated PR binding | Boundary instants only; DB/file reads not atomic together |
| Every actual provider HTTP is sampled | BEFORE/AFTER wrapper; pagination and full E2E | Process death can leave an incomplete pair; never treat it as PASS |
| Persistence survives restart | Separate private insert-only journal; restart and UPDATE/DELETE denial tests | Not same-user tamper-proof storage |
| Normal CI accepts other Task locks | Trusted opt-in scope and legitimate-other-Task lock tests | Presence recorded honestly, never a global no-lock policy |
| Measurement failures preserve effects | Scoped error marker; BEFORE/AFTER/transport regressions | AFTER failure requires remote reconciliation before retry |
| Secrets and path safety | No observer headers/body/lease reads; unsafe-path filtering and environment regressions | M5#208 credential-file isolation remains unresolved |
| Existing evidence is preserved | Task rows and eight Task5 evidence hashes unchanged; old dirty/staged worktrees retained | New repository registration is the only operational preparation row |
| Real corrected-candidate acceptance | Isolated build/MCP preflight plus prepared fixture | New authenticated live Task NOT_RUN; Private gate unmet |

Final repair CI [38837666171](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837666171) and final integration CI [38837663393](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837663393) are SUCCESS. Both synthetic merge-preview trees equal the published HEAD trees. Independent code review returned APPROVE for the whole 18-file candidate and the four-file repair; architecture re-review returned CLEAR. These verdicts approve the code scope only.
The [release readiness report](m2-release-readiness-20261016.md) records final CI,
candidate identities, integration order and external gates.

## Unresolved live and formal gates

The [companion smoke report](m2-completion-smoke-evidence-20261016.md) records the prepared new disposable repository and the runtime authentication blocker. Runtime credential probes returned 401 for `/user`, the previous smoke repository and the new repository. Windows `gh` access is a different credential surface and does not establish runtime authorization. No credential was issued, replaced or granted broader privileges; no new coding Task was created.

The current candidate's fresh live smoke is **NOT_RUN**. Required independent live lock samples and its new event timeline therefore do not exist. The new fixture's intentional assertion failure is valid setup evidence, not failed Agent execution and not candidate acceptance.

Both smoke repositories are Public on the user's Free plan. Public functional results do not satisfy #77's original Private condition. Any criteria exception, plan change or credential change is a separate user decision; none is assumed here.

To reach `M2_RELEASE_READY`, retain the verified code/integration evidence, restore an authorized runtime GitHub credential through an approved path, execute one fresh nonduplicated live Task with independent samples, and satisfy the Private gate or obtain an explicit approved exception. Until then, the record must retain the applicable technical/security/formal blockers. Main merge, release tagging/deployment and #77 closure remain unperformed approval boundaries.

Portable final receipts: [sanitized evidence JSON](evidence/2026-10-16-m2-completion.json). Final preservation independently rechecked the five original Task rows, eight historical evidence hashes, Task3 unstaged modification, Task4 staged modification and Task5 clean published HEAD. All remain intact; DB integrity is ok and Repo Locks are zero.
