# M2 real-device smoke evidence - 2026-10-20

## Result and scope

**TASK-000006 COMPLETED; Public functional PASS.** The actual corrected Agent candidate `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` performed coding, verification, commit, push, remote confirmation, lock release, PR creation and required CI observation on Windows 11 / WSL2. Independent provider-boundary observations are present. #77's original Private condition remains unmet and M5 #208's separate security failures remain unresolved.

Runtime restoration is **RESTORED**, verified at `2026-10-20T02:23:04.310804+00:00`. Original build `db44c08881ce07d5b2c05000f3d93b36999a32ae` runs as Agent PID 2818 and tunnel PID 2962, both active/running with zero automatic restarts. Actual external MCP returned 13 tools and healthy/ok/ready at `2026-10-20T02:22:31.854Z`. Original effective settings match and temporary drop-ins are absent. The validated candidate is not left as the running production build.

## Environment and preflight

| Item | Actual observation |
|---|---|
| Host | Microsoft Windows 11 Home, version 10.0.26200, build 26200 |
| WSL | 3.0.3.0; Ubuntu running as WSL2 |
| Kernel | `6.18.54.1-microsoft-standard-WSL2` |
| Node / npm | `v24.21.0` / `11.19.0` |
| Node bin directory | `/home/jskjw/.nvm/versions/node/v24.21.0/bin` |
| Source manifest SHA256 | `c90a27c050cf5c44357283ee507e6ad01a11fe3ad7b6dbb274af8ac4f4794e86` |
| Dist manifest SHA256 | `c338b13ee9042b9786240b0e36c04e069aed7f745b4e40bf47c39a7cf406b323` |
| Candidate Agent / tunnel PID | 2158 / 2197 |
| External MCP pre-Task proof | 13 tools; healthy/ok/ready at `2026-10-20T02:05:37.136Z` |
| Git identity | Repo-local `Gram Coding Agent <gram-agent@localhost.invalid>` |
| Repository | `jskjw157/gram-m2-smoke-20261016-evidence`, Public, ID 1421490705 |
| Main/base | `ef3cecd6234867a30411819071d68066fcf52cb0` |
| Main protection | Classic; strict `verify`, app 15368; administrators enforced; force pushes/deletions disabled |

The actual source fixture had one intended assertion failure before the Task, with lint/build passing. `node --test` found exactly one test; there was no npm discovery error. The initial correct fixture had already passed real [CI 38833413585](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/actions/runs/38833413585) before the intentional bug was seeded and protection enabled. The repo-local identity was verified in a linked worktree; global Git configuration was not changed.

## Task, verification and publish identities

- Task: TASK-000006 / `01a1570e-d5f5-756b-b1df-dc83e5f20682`.
- Workspace: row 5, `/home/jskjw/.gram-agent/worktrees/1421490705/01a1570e-d5f5-756b-b1df-dc83e5f20682`.
- Branch: `fix/task-000006-fix-increment-so-the-existing-test-passes-change-only-the-minimum-required-source-file`.
- Commit: `41902d0b63a4d96c6ed40a84e8d3335b70071e56`, git_commits row 2, remote-confirmed 1.
- [PR #1](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/pull/1): internal row 2; GitHub numeric ID 4929977061; provider node ID `PR_kwDOVLo6Ec8AAAABJdl65Q`.
- [Actions run 39357215155](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/actions/runs/39357215155): required `verify` completed/success, GitHub Actions app 15368, check 118414656837, check suite 106651758299, final ci_runs row 4.

Plan 4 persisted five required PASS checks: lint 16 / command 319, test 17 / command 330, build 18 / command 341, secret-scan 19 / accepted external review `4d4782bb-b2ba-43f7-a326-525fee7c250b`, and diff-review 20 / accepted external review `be2eaf2b-16c4-4fcf-b864-4086f0e64c04`. Commands exited zero; the test summary is 1 pass, 0 failures, 0 skipped. INSTRUCTIONS, ANALYZE and MODIFY all persisted SUCCEEDED.

Both reviews bind the baseline `ef3cecd...`, workspace 5 and sealed snapshot `acfd187612d266a02c8f1fd48d5fd6b83990de3c7176be9d954db836de30a6e5`. The diff review approves only `src/counter.ts`. The generated PR body lists that same path; the actual diff changes only `return value` to `return value + 1`, +1/-1. Published file OID `58c39fee8f03faa47c9ad78fba967a9a244befae` matches the sealed verification source.

Task `finished_at` and `working_branch` remain null in the existing schema. Completion is proven by persisted `status=COMPLETED` and `updated_at`, not an invented finish timestamp. The branch comes from workspaces/git_commits. Queued placeholder CI row 3 remains historical; row 4 is the real successful provider check. Its `provider_run_id` is the check suite ID, not the Actions run ID.

## UTC event ordering

All timestamps below are on 2026-10-20.

| Event | Durable identity | UTC time |
|---|---|---|
| Task created | tasks seq 6 | `02:05:52.502Z` |
| Instructions succeeded | step `e3b3d765-1a20-4401-9ceb-42abd5e98bd7` | `02:06:08.298Z` |
| Analysis succeeded | step `663ab109-8aa2-419a-a525-79f5fd9fcf91` | `02:06:35.153Z` |
| Modification succeeded | step `b4ef9162-f233-4a70-9473-77824a48ed73` | `02:06:51.732Z` |
| Remote SHA confirmed | git_commits 2; audit 20 | `02:07:33.060Z` |
| Repo Lock released | audit 21 | `02:07:33.063Z` |
| GitHub PR created | PR #1 | `02:07:34Z` |
| Internal PR persisted | pull_requests 2 | `02:07:34.965Z` |
| First CI observation started | audit 22, same Task/PR/HEAD | `02:07:34.975Z` |
| Required verify started | check 118414656837 | `02:07:39Z` |
| Required verify completed successfully | same check | `02:07:44Z` |
| Final CI persisted / Task COMPLETED updated_at | ci_runs 4 / tasks seq 6 | `02:07:49.214Z` |

`remote_confirm <= lock_release < pr_create <= ci_observe` holds using either the provider PR timestamp or the internal PR timestamp. Local CI observation starts before the provider job starts; these are distinct events.

## Independent lock measurements

Observer session `83ef45ff-a54f-4500-a59f-ba48e3b7203c` persisted 29 journal records: 28 boundary samples for 14 actual HTTP calls, plus one PR_BINDING. All BEFORE/AFTER pairs are complete. All samples have `dbPresent=false` and `filePresent=false`, exact Task/repo/confirmed HEAD attribution and measured timestamps.

| Provider endpoint | Actual HTTP calls | Boundary samples |
|---|---:|---:|
| PR_FIND | 1 | 2 |
| PR_CREATE | 1 | 2 |
| RULES | 3 | 6 |
| STATUSES | 3 | 6 |
| PROTECTION | 3 | 6 |
| CHECK_RUNS | 3 | 6 |

The first PR_FIND BEFORE measurement is `02:07:33.068Z`; PR_CREATE BEFORE is `02:07:33.440Z`. The last CHECK_RUNS AFTER measurement is `02:07:49.206Z`. Pre-persistence PR samples have null internal PR ID, followed by one validated binding to row 2. Every CI sample carries row 2. The [portable receipt](evidence/2026-10-20-m2-completion.json) includes every sample and binding with request IDs, endpoint, phase, DB/file measurement times and session attribution.

Independence means a separate read-only operational SQLite connection and direct canonical-file inspection within the candidate process, persisted in a separate private append-only journal. It is not an independent OS process or same-user tamper-proof store. Samples prove their boundary instants, not continuous absence during HTTP calls; the DB/file reads are not atomic together. Another Task's legitimate lock is recorded rather than prohibited. Restart/replay append-only behavior and other-Task presence remain regression-tested; this live run did not simulate an active-Task crash.

## Runtime restoration and retained operational observations

One external health call initially timed out after restoration. Subsequent actual read-only native health succeeded without another service restart. A pending snapshot captured tunnel PID 2962 as `systemd-executor` before exec into `/home/jskjw/.local/bin/tunnel-client`, launched by the original `/usr/bin/env tunnel-client` unit. The guarded finalization independently verified the same PID, start ticks `158397`, boot ID and all other runtime fields, and appended the transition evidence at `2026-10-20T02:22:35.090945+00:00`. The original pending evidence was preserved. These are operational observations, not a failed coding smoke.

The final receipt confirms original `Restart=on-failure` and `SendSIGKILL=yes` settings, with only the original permanent Agent PATH and tunnel drop-ins remaining. Temporary validation overrides prevented forced termination during the controlled transitions; no force kill or extra diagnosis restart was used. The guard passed 25 tests and independent review returned CLEAR. The original DB retains Tasks 1-4 FAILED and Tasks 5-6 COMPLETED, zero DB/file locks, and logical fingerprints matching the completed backups. All 29 journal rows persist after the restart. This restart evidence demonstrates preservation; it does not claim an active-Task crash/replay test.

Primary restoration receipt: `C:\source\gram-agent-diagnostics\m2-live-runtime-restoration-20261020.json`, included in the portable JSON with its SHA256. The diagnostic precursor `m2-restore-exec-diagnosis-20261020.json` remains a historical snapshot; its guarded-pending status is superseded by the final RESTORED receipt.
At `2026-10-20T02:26:29.5843238Z`, the existing hidden Windows `wsl.exe` process PID 31540 was confirmed live with `--distribution Ubuntu --exec /bin/sleep infinity`. It kept the Ubuntu instance alive through validation and restored Agent/Tunnel operation. No startup configuration was changed; this helper does not survive Windows reboot. Reboot/autostart behavior was not tested in this smoke.

## Preservation and evidence archive

Both operational DB and observer journal received consistent online backups at `/home/jskjw/.gram-agent/recovery/M2-live-completed-20261020-yakn_jdh`. Fingerprints match the captured source data. The private `agent.sqlite` backup is 417792 bytes, SHA256 `09d9f6b3af913149bc5f806d66f5ca91807406c26dfcc452403f89995e707b24`; `smoke-lock-evidence.sqlite` is 36864 bytes, SHA256 `73f4078b455fe6531a18e568dc981b9d5b54c0dc4b9f8d683fa820e225534704`. Both are mode 0600, UID 1000. The manifest was measured at `2026-10-20T02:19:41.228901+00:00`; private databases are not published. Verification stdout/stderr logs are archived there with SHA256 hashes. At collection the DB integrity is `ok`, DB/file lock counts are zero, the Task6 worktree is clean and index.lock is absent.

Historical Task1-5 rows, eight original Task5 evidence hashes and existing dirty/staged worktrees remain unchanged. Task5's October 14 success and its missing contemporaneous independent measurements remain historical facts; no backfill was performed.

Local primary receipts under `C:\source\gram-agent-diagnostics`:

- `TASK-000006-live-evidence-20261020.json` and `TASK-000006-acceptance-validation-20261020.json`.
- `TASK-000006-github-pr.json`, `-github-files.json`, `-github-checks.json`, `-github-protection.json`, `-github-run.json`.
- `m2-platform-20261020.json`, `m2-live-runtime-activation-20261020.json` and fresh isolated/fixture preflight receipts.

The [release readiness report](m2-release-readiness-20261020.md) records remaining formal/security gates and the intended integration path. No smoke PR or M2 PR was merged; no release or #77 closure occurred.
