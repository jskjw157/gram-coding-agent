# Release Readiness - 2026-10-20

Verdict: **FORMAL_GATE_BLOCKED**. Public functionality and the scoped security
boundary passed on `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16`. TASK-000009 completed and the original runtime was
restored. The remaining formal gate is #77's Private-repository condition; no
exception has been approved. This is not permission to merge, release or deploy.

The validated runtime SHA is the source candidate above. A subsequent docs-only
PR has its own SHA; documentation CI must not be represented as a new live run.
Evidence references below name files under the diagnostic evidence bundle.

## Exact candidate validation

| Gate on9d1a3f8 | Result |
|---|---|
| Frozen install / lint / typecheck / build | All PASS, exit0 |
| Unit | 884 PASS |
| E2E | 28 PASS |
| Security TypeScript | 24 PASS, including all six original #208 assertions |
| Native boundary / native build probes | 13 PASS / 3 PASS |
| Verified artifact installer | 10 PASS |
| Actual WSL boundary | 1 PASS plus independent Windows observation |
| Required GitHub verify | SUCCESS, run39393910054 / job118531796824 |
| Actual live Task | TASK-000009 COMPLETED |
| Original runtime restoration | RESTORED with external MCP proof |

`m5-final-integration-gates-9d1a3f8-20261020.json` and per-gate logs bind each command
to the exact SHA. [Candidate CI](https://github.com/jskjw157/gram-coding-agent/actions/runs/39393910054)
ran verify08:30:39Z-08:32:34Z. Root CI collects security/native/installer checks.
Windows device verification is separate. Counts are distinct suites, not an
invented aggregate. Prior96's872 and prior173a's799 results remain historical.

## RED -> GREEN evidence index

All names are retained diagnostic logs. Targeted name-filter runs leave unrelated
cases unselected; this is not disabling final checks. Final exact-SHA suites above
ran all required cases without weakening assertions.

| Repair | RED evidence | GREEN evidence |
|---|---|---|
| Original credential boundary | `m5-baseline-red-20261020.log`:3FAIL/3PASS | `m5-final-9d1a3f8-security-20261020.log`:24PASS including all6original |
| Launch authorization generation | `m5-generation-authorization-red-20261020.log`:8FAIL/1PASS | corresponding `green`:9PASS |
| Admission before launch | `m5-launch-order-red-20261020.log`:1FAIL/21PASS | corresponding `green`:22PASS |
| Runtime admission | `m5-runtime-admission-red-20261020.log`:2FAIL/19PASS; `m5-runtime-validator-red-20261020.log` | `m5-verified-runtime-green-20261020.log` and final installer/security gates |
| Mandatory spawner routing | `m5-spawner-routing-red-20261020.log`:2FAIL | `m5-profile-repairs-green-20261020.log` and final root tests |
| Guarded strict review | `m5-trusted-review-red-20261020.log`:2FAIL/20unselected | corresponding `green`:22PASS |
| pnpm shell stub | `m5-pnpm-shell-stub-red-20261020.log`:1FAIL/23unselected | corresponding `green`:1PASS/23unselected; final fullsecurity24PASS |
| Long branch component | `m2-bounded-branches-red-20261020.log`:3FAIL/11PASS | corresponding `green`:14PASS including realGit |
| RemoteService origin contract | `m5-origin-confirmation-red-20261020.log`:1FAIL/34PASS | targeted35PASS; `m5-origin-confirmation-green-20261020.log`:39composedPASS |

Additional retained pairs cover npm CLI, pnpm runtime, quarantine diagnostics and
WSL driver mounts: `m5-npm-cli-*`, `m5-pnpm-runtime-*`,
`m5-quarantine-diagnostic-*`, `m5-wsl-driver-mount-*`. Original M2 path/boundary
TDD logs and #217 reports remain preserved. Independent review repairs included
credential descendant lifetime, immutable official runtime provenance, package
snapshot aliases, strict UTF-8/output bounds, diagnostic Git filter/redirection
rejection, collector attribution and controller readiness continuity. Final
controller guard passed57 temporary fixtures; these are not counted as production
unit tests or substituted for actual external health proof.

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

## Decisions still requiring the user

1. Meet #77 Private acceptance in a qualifying environment, or approve an explicit
   Public exception. No plan upgrade or criterion waiver was performed.
2. After formal disposition, approve the exact reviewed merge sequence and resulting
   candidate. A docs-only evidence PR does not authorize integration.
3. Separately approve release/tag and deployment. The running service is old db44;
   candidate protection is not currently deployed. Full M5/ISO-01 expansion is a
   separate scoped acceptance decision, not silently included here.

No main merge, release, tag, production deployment, force push, repository deletion,
protection relaxation or unrelated parallel-PR integration was performed.
