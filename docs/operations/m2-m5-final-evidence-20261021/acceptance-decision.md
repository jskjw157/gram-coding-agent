# M2 acceptance decision after the scoped Public exception

Decision date: 2026-10-21. This is a new decision record; it does not rewrite the
[2026-10-20 acceptance](../m2-m5-final-evidence-20261020/M2-M5-Acceptance-20261020.md)
or its historically correct `FORMAL_GATE_BLOCKED` verdict.

## Owner decision and exact scope

Project owner `jskjw157` approved Option A in [issue77 comment6304834289](https://github.com/jskjw157/gram-coding-agent/issues/77#issuecomment-6304834289),
created **2026-10-21T00:21:34Z**, with GitHub author association OWNER. The comment
was read directly before drafting this record. It accepts one specified Public
Windows11/WSL2 disposable-repository run as an explicit exception to the original
Private-fixture requirement of M2#77.

A Private live test was **not** performed. The actual Private probe returned403
for required protection; that limitation and the original requirement remain in
history. The exception does not waive tests, security checks, required CI, evidence
integrity or deployment readiness. It does not certify full M5/ISO-01 or authorize
main merges, issue closure, tags, deployment, migrations or credential changes.

## Evidence admitted by the exception

| Artifact | Exact identity |
|---|---|
| Tested source/runtime | `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16` |
| TASK-000009 | `01a1588d-56a7-7665-815c-223a7383aead`, COMPLETED |
| Public repository | `jskjw157/gram-m2-smoke-20261020-remote-confirm`, ID1426717645 |
| Published smoke commit | `637a4884b90f24af9aa74e58bf03799d82ae23d3` |
| Smoke PR | [PR1](https://github.com/jskjw157/gram-m2-smoke-20261020-remote-confirm/pull/1) |
| Required smoke CI | [39398155785 SUCCESS](https://github.com/jskjw157/gram-m2-smoke-20261020-remote-confirm/actions/runs/39398155785) |
| Candidate CI | [39393910054 SUCCESS](https://github.com/jskjw157/gram-coding-agent/actions/runs/39393910054) |
| Prior final document candidate | `ab80b7cd5f549f73e463483467773a191ce1dd83`, [PR225](https://github.com/jskjw157/gram-coding-agent/pull/225) |
| Prior document CI | [39399993798](https://github.com/jskjw157/gram-coding-agent/actions/runs/39399993798), linked by owner decision |

The [portable Task9 receipt](../m2-m5-final-evidence-20261020/m5-task9-final-acceptance-20261020.json)
binds all three coding phases, five required PASS checks, accepted review/snapshot
bindings, one passing test and the exact one-line `src/counter.ts` diff. Generated
PR Changed Paths matches the actual file. The recorded order is:

`09:05:37.298Z remote_confirm <= 09:05:37.299Z lock_release < 09:05:38Z GitHub PR create <= 09:05:39.156Z first CI observe`.

The observer recorded14 HTTP requests,28 paired BEFORE/AFTER measurements and1 PR
binding. It independently read a separate read-only SQLite connection and used
direct lstat, inside the same candidate process, at provider-call boundary instants.
All measured DB/file locks were absent. This is not an external observer process,
continuous lock surveillance or proof of unmeasured times. Attribution binds the
Task/repository/HEAD/PR; another Task's legitimate later lock is not prohibited.

## Technical conditions retained

The tested9d candidate recorded884 unit,28 E2E,24 security,13 native,3 native-build,
10 installer tests, lint/typecheck/build and actual Windows/WSL verification PASS.
These remain historical exact-SHA results, not automatically fresh results for a
new documentation or rehearsal HEAD. Root CI still requires frozen install,
mandatory Linux security setup, shell/JSON checks, lint, typecheck, unit, E2E,
security and build. Actual Windows/WSL verification and independent review remain
additional gates. No skipped/removed test or relaxed assertion is authorized.

The project-required `verify` workflow is an acceptance gate. The project
repository's main is currently unprotected (Classic protection GET404; no
rulesets), so it must not be described as a GitHub-enforced required check on
that branch. GitHub-enforced strict `verify`/Actions app15368 was independently
proven on the disposable smoke repository. See [main policy snapshot](main-policy-snapshot.json).
No branch protection has been added, removed or relaxed by this work.

The implemented linux-node-v1 offline command boundary closes the demonstrated
same-UID credential-file acquisition routes. It is not a distinct-UID ISO-01 broker,
atomic ISO-06 fencing, blanket full-M5 acceptance or comprehensive Windows-host
containment. Network-dependent workload setup is outside this offline profile;
host root/kernel and verified runtime/system components remain trusted. The
[implementation contract](../../security/command-isolation-implementation-20261020.md)
continues to govern these limits.

## Final-approval decision and exact-HEAD gate

**Decision: `READY_FOR_FINAL_APPROVAL`, effective only for the final #225 HEAD whose
fresh validation and independent integration review are recorded as passing in
that PR's publication record.** A pending, failed or subsequently changed HEAD is
not covered. The owner exception resolves only the specified Private/Public gate;
this document does not itself assert an unexecuted test result.

The decision also binds the rehearsed remote main
`ba9fc6814711e983a11e58a09ed04e8337a4effe`. A changed remote main invalidates this
integration-readiness decision until the new main is fetched, rehearsed and
validated again. Re-read both main and #225 HEAD at the actual approval boundary.

The execution owner must attach the final commit/PR HEAD, current-main rehearsal
SHA/tree, complete command results, required CI and review findings. Reuse of
Task9's live evidence is permitted only when an explicit diff proves **zero
production/runtime/dependency/build/security-policy changes** relative to9d. A
source or relevant artifact change requires new appropriate live validation;
documentation CI cannot relabel an old live run as a new runtime SHA.

Integration route:135 ->196 ->213 ->214 ->216 ->221 ->222 ->223 ->225.
Do not merge215's preview a second time. Original217 evidence is preserved inside225;
do not separately duplicate217 when using225. Audit206/208/211 inclusion through221
and exclude unrelated parallel M3/M4/M5 changes. Actual main is unchanged by this
record or the non-main rehearsal.

The always-running service was restored to old `db44c08881ce07d5b2c05000f3d93b36999a32ae`;
it is not the protected9d candidate. A readiness verdict means the artifacts are
ready for a user decision, not that a deployment, migration, release or #77 closure
has occurred. Those actions remain separately approved; see
[deployment and rollback](deployment-rollback.md).

## Later operating history retained

A2026-10-21 read-only operating check found original agent78194/tunnel78234 active
with zero restarts and zero DB/file locks; Task9 remained COMPLETED. There is a later
TASK-000010 `01a15b05-2d90-7149-95dc-fb7000bffe15`, created2026-10-20T20:33:48.440Z
and FAILED20:33:49.130Z, repo_idNULL. Audit40 records UnknownRepositorySelectorError
for `jskjw157/sazu` at WAITING_REPO_LOCK. No command/check/worktree/code/push/PR/lock
was created. This is an unregistered-selector failure on the restored older runtime,
not a new9d smoke result. Preserve it; registry repair or Task retry is outside this
document/integration goal. The current DB must not be claimed identical to the
October20 completed backup after this legitimate additional history.
