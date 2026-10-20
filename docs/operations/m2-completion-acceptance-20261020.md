# M2 completion acceptance evidence - 2026-10-20

## Disposition

**PUBLIC_FUNCTIONAL_PASS_FORMAL_GATE_BLOCKED.** The corrected candidate completed a real Windows 11 / WSL2 Public smoke as TASK-000006. The PR lists the approved changed path, all five required verification checks passed, the remote commit was confirmed before lock release, and independent SQLite/file observations recorded lock absence at every sampled PR/CI provider boundary. The original #77 Private condition remains unmet; no exception is approved. M5 #208's separate credential-file isolation failures remain unresolved. This is not `M2_RELEASE_READY` or overall security acceptance.

Runtime restoration is **RESTORED**, verified at `2026-10-20T02:23:04.310804+00:00`. The original Agent build `db44c08881ce07d5b2c05000f3d93b36999a32ae` runs as PID 2818 with tunnel PID 2962; both are active/running with zero automatic restarts. External MCP returned 13 tools and healthy/ok/ready at `2026-10-20T02:22:31.854Z`. Original effective service settings match, temporary drop-ins are absent, and operational DB/observer journal fingerprints match the completed backups. All 29 observation records survived restoration. The corrected candidate was validated temporarily; it is not the restored runtime build.

## Corrected candidate and completed live run

| Identity | Value |
|---|---|
| Tested Agent candidate | `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` |
| Task | TASK-000006 / `01a1570e-d5f5-756b-b1df-dc83e5f20682` |
| Public repository | `jskjw157/gram-m2-smoke-20261016-evidence`, ID `1421490705` |
| Base main | `ef3cecd6234867a30411819071d68066fcf52cb0` |
| Published commit | `41902d0b63a4d96c6ed40a84e8d3335b70071e56` |
| Actual PR | [PR #1](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/pull/1), internal row 2 |
| Actual required CI | [Actions 39357215155](https://github.com/jskjw157/gram-m2-smoke-20261016-evidence/actions/runs/39357215155), `verify` completed/success |
| Task terminal evidence | `status=COMPLETED`, `updated_at=2026-10-20T02:07:49.214Z` |

The run used Microsoft Windows 11 Home build 26200 and Ubuntu under WSL2, WSL version 3.0.3.0, kernel `6.18.54.1-microsoft-standard-WSL2`. The exact candidate's source/dist manifests matched the previously tested build. Node `v24.21.0`, npm `11.19.0`, repo-local Git identity, registered verification commands, authenticated MCP's 13 tools, healthy/ok/ready, and the real tunnel were checked before Task creation. Candidate Agent PID 2158 and tunnel PID 2197 served the run.

The fixture was unused before this Task. Its initial correct implementation passed real CI; the single intentional bug was seeded before Classic Branch Protection. A fresh preflight discovered exactly one assertion failure (`1 !== 2`), while lint/build passed. Classic main protection requires strict `verify` from GitHub Actions app 15368, enforces administrators, and disables force pushes and deletion. No protection bypass, fabricated check or manual Task commit/push was used.

## Required verification and Changed Paths repair

Verification Plan 4 persisted these required results:

| Check | Check row | Evidence | Result |
|---|---:|---|---|
| lint | 16 | command 319 | PASS / exit 0 |
| test | 17 | command 330; 1 test, 1 pass, 0 fail, 0 skipped | PASS / exit 0 |
| build | 18 | command 341 | PASS / exit 0 |
| secret-scan | 19 | accepted review `4d4782bb-b2ba-43f7-a326-525fee7c250b` | PASS |
| diff-review | 20 | accepted review `be2eaf2b-16c4-4fcf-b864-4086f0e64c04` | PASS |

INSTRUCTIONS, ANALYZE and MODIFY persisted SUCCEEDED. The diff review approved only `src/counter.ts`, bound to this Task, workspace 5, Plan 4, Check 20, reviewed baseline HEAD and sealed snapshot. The sealed source OID equals the published file OID. The PR's generated Changed Paths section contains `src/counter.ts`; the actual GitHub diff is that file alone, +1/-1, changing `return value` to `return value + 1`. The PR body was not manually repaired.

[Draft #213](https://github.com/jskjw157/gram-coding-agent/pull/213) fixes approved external-review projection and preserves valid legacy evidence. [Draft #216](https://github.com/jskjw157/gram-coding-agent/pull/216) requires required PASS legacy diff-review evidence and prevents metadata from authorizing paths. Regression coverage includes wrong Task/Plan/HEAD/review bindings, unapproved metadata, unsafe paths, credential-shaped strings and concurrent SQLite snapshot changes. The [Oct16 acceptance report](m2-completion-acceptance-20261016.md) preserves the RED-to-GREEN receipts and independent review results.

## Independent Repo Lock evidence

[Draft #214](https://github.com/jskjw157/gram-coding-agent/pull/214) adds a trusted, repository-scoped smoke observer. During this actual run it recorded **14 HTTP requests, 28 BEFORE/AFTER samples and one PR_BINDING**. Every pair is complete; every sampled SQLite lock row and canonical file lock is absent. Samples cover PR_FIND, PR_CREATE, RULES, STATUSES, PROTECTION and CHECK_RUNS. All records bind to the exact Task/repository/remote-confirmed SHA; PR lookup/create records are subsequently linked to internal PR row 2, which every CI sample carries.

The observer uses a separate read-only SQLite connection and direct file inspection within the candidate process. Its private append-only journal records distinct DB/file observation timestamps. These measurements independently check lock state rather than inferring it from release audit ordering; they prove boundary instants, not continuous absence during requests, atomic DB/file inspection, process isolation or same-user tamper resistance. Normal CI remains allowed when another Task legitimately holds the repository lock. The portable receipt contains all 29 records, not just a summary.

The recorded inequality is satisfied:

`2026-10-20T02:07:33.060Z <= 02:07:33.063Z < 02:07:34Z <= 02:07:34.975Z`

These are remote confirmation, lock release, provider PR creation and first CI observation respectively. The [smoke report](m2-completion-smoke-evidence-20261020.md) gives all row/audit IDs, provider times and interpretation limits.

## Quality, preservation and remaining gates

The exact final candidate passed `pnpm lint`, `pnpm typecheck`, `pnpm test` (**799 tests / 76 files**), `pnpm test:e2e` (**28 tests / 6 files**) and `pnpm build` on October 16. [Exact-candidate GitHub CI 38837663393](https://github.com/jskjw157/gram-coding-agent/actions/runs/38837663393) succeeded. These are retained exact-SHA results, not claims of an October 20 full-suite rerun. Fresh October 20 manifests and the actual live smoke validate the same candidate. Independent code review approved the whole change and final repair; architecture re-review was CLEAR.

Task 1-5 rows, eight original Task5 evidence files, Task3's unstaged edit and Task4's staged edit remain unchanged. Historical TASK-000005 stays COMPLETED at commit `9c786a29167c1cf58a51f66952e6640bfb2d2f54`, with its original [PR](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/pull/1) and [CI](https://github.com/jskjw157/gram-m2-smoke-20261014-identity/actions/runs/38509721619). Its missing historical boundary measurements were not backfilled. Original Oct16 reports remain intact.

Task6 evidence was archived using online backups of both operational SQLite and the observer journal at `/home/jskjw/.gram-agent/recovery/M2-live-completed-20261020-yakn_jdh`. Backup fingerprints match the collected state. The collected operational DB has integrity `ok`, zero repo locks and zero file locks; Task6's worktree is clean with no index lock.

Formal acceptance still requires the original Private environment or an explicitly approved exception. Separately, [M5 #208](https://github.com/jskjw157/gram-coding-agent/pull/208) records a dedicated security result of 3 PASS / 3 FAIL: same-user Node/descendant/npm processes can read credential canaries. Root CI does not collect those cases. This M2 smoke neither fixes nor waives that risk. Main merge, release, #77 closure and M3/M4/M5 integration were not performed.

See the [release readiness report](m2-release-readiness-20261020.md) and [portable sanitized evidence](evidence/2026-10-20-m2-completion.json).
