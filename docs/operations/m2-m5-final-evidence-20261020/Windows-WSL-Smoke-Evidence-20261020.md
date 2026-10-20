# Windows/WSL Smoke Evidence - 2026-10-20

Verdict: **FORMAL_GATE_BLOCKED**. Public functionality and the scoped security
boundary passed on `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16`. TASK-000009 completed and the original runtime was
restored. The remaining formal gate is #77's Private-repository condition; no
exception has been approved. This is not permission to merge, release or deploy.

The validated runtime SHA is the source candidate above. A subsequent docs-only
PR has its own SHA; documentation CI must not be represented as a new live run.
Evidence references below name files under the diagnostic evidence bundle.

## Preflight and real device evidence

New fixture's correct initial SHA `7e8289c31bae5820713ea913567fbbf5d6fd533b`
passed CI39393338420; bug seed CI39393449711 failed only the intended assertion.
Production npm profile inference and registration passed; backup
`/home/jskjw/.gram-agent/recovery/m5-v3-registration-20261020-BPOEpA`.
Copied-DB preflight at09:00:30.087Z preserved production state and closed port33393.
Source manifest `b96dfcbc04b877df0b7f8e40133edd23f64434984aca66dd0d49b235ec1936d3`;
dist manifest `511e97bbad99ed87ac0630862b16cb2ab66a2d0329f27034db21cfd4c0ea7ca9`.

The isolated lab at08:54:27.225Z exercised real FileSecretProvider, typed Git and
actual RemoteService.confirmRemoteSha(origin,main,seed), then isolated npm lint/test/
build and local commit `af1df1a57984c7d092ca0075f2ecc06733b4bff2` in
`/home/jskjw/.gram-agent/recovery/m5-v3-git-sandbox-preflight-3DEj3d/`.
It performed no remote writes or Task/DB/service mutations. This was preflight,
not a substitute for the subsequently completed Task.

`m5-final-9d1a3f8-windows-observer-20261020.json` records an outside Windows
PowerShell observation at08:33:51.1229097Z: real outside Windows execution positive,
inside-worker Windows file absent. Linux receipt SHA256
`0276023547130400a37e8d7f7c071a191f189b47032f288834e8eb1e7c903f9f`.
This proves the targeted Windows/WSL route, not comprehensive Windows containment.

## Actual live Task and publishing chain

TASK-000009 UUID `01a1588d-56a7-7665-815c-223a7383aead`, repo1426717645
`jskjw157/gram-m2-smoke-20261020-remote-confirm` (Public), base
`c40760deeabeda6a8869c773b44f5cccec6e12c7`. Candidate9d activation was externally
finalized09:03:04Z; actual agent76149/tunnel76194 ran the Task.

Instructions, analyze and modify all SUCCEEDED. Plan6/workspace7 required checks:
lint26(command574), test27(command585), build28(command596), secret-scan29 and
diff-review30 all PASS. Both accepted review bindings and actual snapshot blob
`58c39fee8f03faa47c9ad78fba967a9a244befae` were verified; actual test count1 PASS.

Commit/remote SHA `637a4884b90f24af9aa74e58bf03799d82ae23d3` (git row4) is confirmed.
[Smoke PR1](https://github.com/jskjw157/gram-m2-smoke-20261020-remote-confirm/pull/1)
is open/unmerged. Only `src/counter.ts` changed, one addition/one deletion,
`return value` -> `return value + 1`. Generated Changed Paths matches this exact path.

| Event | UTC / identity |
|---|---|
| Remote confirmation | 09:05:37.298Z, audit34 |
| Repo lock release | 09:05:37.299Z, audit35 |
| GitHub PR creation | 09:05:38Z |
| Internal PR row creation | 09:05:39.148Z, row3 |
| First CI observation | 09:05:39.156Z, audit36; later37/38 |
| Required verify | 09:05:42Z-09:05:48Z, check118545924597 SUCCESS |
| Task COMPLETED | 09:05:53.432Z |

`remote_confirm <= lock_release < pr_create <= ci_observe` holds with actual DB,
audit and provider timestamps. GitHub PR creation is distinct from internal-row
creation. [Actual smoke CI39398155785](https://github.com/jskjw157/gram-m2-smoke-20261020-remote-confirm/actions/runs/39398155785)
is bound to the same commit. Classic main protection remains strict required verify,
GitHub Actions app15368, admins enforced, no force/deletion, rulesets0.

## Independent lock measurements

Observation session `5fecdd48-e6b4-44d0-9bde-1377211ac5b4` contains14 HTTP requests,
28 complete paired boundary samples and1 PR binding. Every measured boundary found
SQLite and file locks absent. Endpoint classes: PR_CREATE, PR_FIND, CHECK_RUNS,
PROTECTION, RULES and STATUSES. Attribution binds the exact Task/repo/HEAD/PR.

Independence means a separate read-only SQLite connection and direct lstat inside
the candidate process, sampled at provider-call boundaries. It is not continuous
monitoring or an external observer process. Samples were collected during this
live run, never reconstructed retrospectively. Legitimate later ownership by another
Task is not forbidden by normal CI policy. Collection found zero DB/file locks.
Portable receipt: `m5-task9-final-acceptance-20261020.json`.

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
