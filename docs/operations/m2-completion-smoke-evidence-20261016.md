# M2 live smoke evidence — 2026-10-16

## Evidence classification

| Run | Result | Scope |
|---|---|---|
| TASK-000005, 2026-10-14 | Historical Public functional PASS / COMPLETED | Real GitHub PR and required CI; independent historical lock samples missing |
| New corrected candidate, 2026-10-16 | **NOT_RUN — runtime GitHub HTTP 401** | Fixture prepared; no new coding Task |
| Observer deterministic E2E | 28 tests PASS | Real local Git plus loopback GitHub fixture; not live GitHub acceptance |

This report preserves the distinction between previously observed success, fixture preparation, deterministic regressions and an unexecuted new live run. It does not create missing Task-5 observations or imply that the original Private acceptance condition was satisfied.

## Historical Task 5 identity and timeline

- Task: `01a13895-d4f0-7659-98d5-c53c06fed32c` / TASK-000005
- Repository: `jskjw157/gram-m2-smoke-20261014-identity`, ID `1418288277`
- Base: `9ad241b86e72c43a40a065a85098d69ebeb2d790`
- Published commit: `9c786a29167c1cf58a51f66952e6640bfb2d2f54`
- [PR #1](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/pull/1), internal row 1, provider ID `4852799905`
- [Actions run 38509721619](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/actions/runs/38509721619), required check `115675197253`, app `15368`

All following timestamps are UTC on 2026-10-14.

| Event | Durable identity | Timestamp |
|---|---|---|
| Remote SHA confirmed | git_commits 1; audit 12 | `04:06:48.527Z` |
| Repo Lock released | audit 13 | `04:06:48.529Z` |
| GitHub PR created | PR #1 | `04:06:49Z` |
| Internal PR persisted | pull_requests 1 | `04:06:50.533Z` |
| First CI observation | audit 14, same Task/PR/HEAD | `04:06:50.535Z` |
| Required verify started | GitHub check `115675197253` | `04:06:54Z` |
| Required verify completed successfully | Same check | `04:07:00Z` |
| Final CI persisted / Task completed | ci_runs 2 / tasks.updated_at | `04:07:04.305Z` |

`remote_confirm <= lock_release < pr_create <= ci_observe` holds with either provider PR time or internal-row creation time. Local polling started before the provider job started; these are different events.

The original collection found all five required checks PASS, coding steps SUCCEEDED, no Task-specific failed command or TASK_RUN_FAILED, and only `src/counter.ts` changed (+1/-1). Command IDs 292/297/298 established commit/push/remote SHA confirmation. The original worktree was clean at the published HEAD when collected. The historical collector independently observed no current DB/file lock, but that later observation does **not** prove absence at the historical provider boundaries.

Primary historical files remain under `C:\source\gram-agent-diagnostics\TASK-000005-*`. In particular, use `TASK-000005-acceptance.md`, `TASK-000005-acceptance-db.json` and the direct GitHub JSON receipts. Their original timestamps and contents must not be overwritten with new candidate conclusions.

## New disposable fixture preparation

Repository: [jskjw157/gram-m2-smoke-20261016-evidence](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence), Public, ID **1421490705**.

| Item | Observed evidence |
|---|---|
| Correct initial implementation SHA | `25943505aa4004d488510e50a491bab3a5a25b36` |
| Initial actual CI | [38833413585](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/actions/runs/38833413585), verify SUCCESS |
| Final intentionally buggy main SHA | `ef3cecd6234867a30411819071d68066fcf52cb0` |
| Bug seed CI | [38833553711](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/actions/runs/38833553711), intentional target assertion failure |
| Test command | `node --test`; one discovered test, `increment(1) === 2` |
| Correct control | test/lint/build exit 0 |
| Buggy control | test exit 1, exactly one assertion failure (`1 !== 2`); lint/build exit 0 |
| Node/npm | `v24.21.0` / `11.19.0` |
| Classic main protection | strict required `verify`, GitHub Actions app `15368`, enforce administrators enabled; force pushes/deletions disabled |
| Registered base | `/home/jskjw/workspace/github/jskjw157/gram-m2-smoke-20261016-evidence` |
| Base Git state | HEAD matches final main above; clean |
| Local Git identity | `Gram Coding Agent <gram-agent@localhost.invalid>`, base `.git/config`; linked worktree inherits it |
| Repository commands | `npm run lint`, `npm run test`, `npm run build` |

Primary receipts: `m2-new-fixture-20261016.json`, `m2-fixture-api-proof-20261016.json`, `m2-smoke-base-20261016.json`, `m2-repository-registration-20261016.json`, all under `C:\source\gram-agent-diagnostics`.

Registration at `2026-10-16T01:21:21.509Z` used the existing repository API. Its receipt reports only one repository row changed, prior Task rows unchanged, zero Repo Locks and no Task created. Backup directory: `/home/jskjw/.gram-agent/recovery/M2-repository-registration-20261016-VjqLyE`. The local Git identity receipt states that global Git configuration was not changed. The actual base/linked-worktree identity is verified; this is not a claim that a new Agent Task committed successfully.

## Runtime authentication stop condition

`m2-runtime-github-auth-blocker-20261016.json` records probes at `2026-10-16T01:16:24.096Z`, Agent PID 186:

| Runtime credential probe | HTTP result |
|---|---:|
| `/user` | 401 |
| `/repos/jskjw157/gram-m2-smoke-20261014-identity` | 401 |
| `/repos/jskjw157/gram-m2-smoke-20261016-evidence` | 401 |

The operational credential cannot currently support the new GitHub flow. Successful Windows `gh` fixture setup uses a separate authenticated context and is not a valid substitute. The receipt explicitly records `credentialChanged=false`, `tokenIssued=false`, `permissionsExpanded=false`, `taskCreated=false`.

Consequently, no new live Task UUID, commit, PR, successful required check, runtime event timeline or live independent lock journal can be supplied. All are **NOT_RUN**, rather than PASS or reconstructed data. Candidate deployment/build identity and final live preflight must be revalidated after an authorized authentication remedy and before creating a Task. Check for active Tasks and outstanding locks again immediately before execution.

## Deterministic independent-observer evidence

`tests/e2e/vertical-slice.test.ts` runs the existing flow twice: legacy composition and actual production GitHub composition with `SmokeLockObserver`. The latter rewrites the transport destination to an authenticated loopback fake server only in the test. Local Git, SQLite persistence, publication/remote confirmation and completion orchestration are real; instructions/analysis/modification and GitHub responses are deterministic fixtures.

A third read-only journal connection verifies:

1. Ten actual HTTP requests each have committed BEFORE and AFTER samples (20 boundary records).
2. Every sample binds to the real fixture Task, repository and remotely confirmed commit SHA.
3. Both SQLite lock row and canonical file lock are absent at each sampled instant.
4. PR lookup/create samples have null internal PR ID, followed by one validated PR_BINDING after persistence.
5. Every CI sample carries the persisted PR row ID. Endpoints include PR_FIND, PR_CREATE, RULES, STATUSES, PROTECTION and CHECK_RUNS.
6. Remote confirmation, lock release, PR creation and CI observation preserve the original ordering assertions, and the Task reaches COMPLETED.

`pnpm test:e2e` on Node 24: **28 PASS / 6 files**, including both vertical variants and the existing fake-server authorization/unknown-route tests. Log: `m2-observer-e2e.log`; scoped lint log: `m2-observer-e2e-lint.log`. These are post-feature E2E coverage results, not the production feature's RED record and not authenticated live evidence.

## Acceptance limits and next evidence

The current technical stop is runtime authentication. The original Private gate remains a separate formal blocker even if a future Public run succeeds. No fees, credential issue/privilege increase, criteria exemption, main merge, release or #77 closure is inferred to be approved.

After an authorized remedy, the coordinator must pin the fully verified integration/build SHA and repeat the real run on the prepared disposable fixture, preserving all existing Task/worktree/SQLite evidence. Capture the complete new Task/plan/check/review/commit/PR/CI identities, the required event inequality and the actual independent journal. Boundary evidence may report another Task's legitimate lock without changing normal CI policy. Report any such presence honestly; do not mark it absent or fabricate a historical observation.

Observer [Draft #214](https://github.com/jskjw157/gram-coding-agent/pull/214), HEAD `f4c747128098fcb807d9455b0fe0c99dc39d3db8`, and the earlier validation-only [Draft #215](https://github.com/jskjw157/gram-coding-agent/pull/215), HEAD `b076ae38e8313f8606afc44faa30cff02e51e69a`, passed all five native WSL gates (788 unit / 28 E2E) and actual GitHub CI runs [38835990155](https://github.com/jskjw157/gram-coding-agent/actions/runs/38835990155) and [38836228093](https://github.com/jskjw157/gram-coding-agent/actions/runs/38836228093). See the [release readiness report](m2-release-readiness-20261016.md): **BLOCKED_WITH_EVIDENCE**, because new live execution, runtime authentication and formal/security gates remain unresolved.

## Final repaired candidate preflight

Final integration SHA `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` includes the
legacy approval repair, passes all five native WSL gates (799 unit tests / 28 E2E),
and passed [CI38837663393](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837663393).
An isolated exact-build startup on a new online DB backup confirmed authenticated
MCP13 and healthy/ok/ready, Node v24.21.0/npm11.19.0 and graceful shutdown. Its
observer journal contains zero samples because no provider operation or Task ran.
The production DB fingerprints and Agent186/tunnel491 stayed unchanged. The
backup/manifests are retained at
`/home/jskjw/.gram-agent/recovery/M2-final-isolated-candidate-20261016-qIfkES`.

Fresh actual runtime credential probes at `2026-10-16T01:55:53.535Z` again returned
HTTP401 for `/user` and the new repository. No retry, credential replacement,
service restart or Task creation occurred. This is a provider authentication
blocker, not the earlier transient Windows DNS failure (which recovered before
normal Draft pushes). Final preflight/auth receipts are linked through the
[portable sanitized evidence](evidence/2026-10-16-m2-completion.json).
