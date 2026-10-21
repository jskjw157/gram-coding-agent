# Deployment artifact mapping and rollback approval boundary

This plan accompanies the [2026-10-21 acceptance decision](acceptance-decision.md).
It authorizes no operational action. The owner Public exception applies only to
one M2 live-smoke fixture condition; deployment, main merge, #77 closure, release
or tag publication and database migrations still require separate approval.

## Artifact mapping

| Layer | Validated baseline / required deployment binding |
|---|---|
| Source | Task9 source `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16`; bind any final integration HEAD with a complete zero-production-diff audit or new validation |
| Prior documents | `ab80b7cd5f549f73e463483467773a191ce1dd83`; a newer docs-only commit is not itself a live runtime |
| Controller build | `apps/agent/dist/main.js` plus all package dist files built from the exact approved source; Task9 source manifest `b96dfcbc04b877df0b7f8e40133edd23f64434984aca66dd0d49b235ec1936d3`, dist manifest `511e97bbad99ed87ac0630862b16cb2ab66a2d0329f27034db21cfd4c0ea7ca9` |
| Native entry | `apps/execution-sandbox` reviewed source/build -> `/usr/local/libexec/gram-sandbox-entry`; actual installed SHA256 `7b577272194b3333ff8f87ba4959c0e19312308720592966412b1bcc28f547d2`, root UID0/mode0755/nlink1, re-read October21. Retain compiler/build and installation receipts; never substitute a user-writable binary |
| Namespace launcher | Actual root-trusted `/usr/bin/bwrap` and kernel/user namespace/Landlock ABI7 prerequisites must be measured on the target |
| Runtime | `/var/lib/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified`; Node24.21.0/pnpm10.34.5 official pinned artifacts,3705-entry tree `2e89512825a43334ef6e73a62bd71b777b029042eecbca361d9c7a62df6ebc61` |
| Node executable | Verified SHA256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`; installer/validator contract must agree |
| Units/configuration | Exact agent/tunnel ExecStart, working directory, PATH, root-owned drop-ins and localhost MCP binding recorded separately from code; no permission expansion |
| State | Existing agent SQLite and append-only observation database; preserve schema/version inventories, successful/failed Task evidence and worktrees |

Read-only migration audit for this document found applied main-DB migration versions
`[1,2,3,4]` and `PRAGMA user_version=0`; no migration was executed. A source diff
between db44 and9d for `packages/persistence/src/migrator.ts` and its SQL migrations
was empty. Version0 is the separate SQLite pragma, not a claim of an unmigrated DB.
This bounds the schema observation; it does not prove every persisted data format
or future downgrade safe. The older-reader compatibility audit below is still required
for any future operational rollback. Journal format compatibility must also be
checked against the exact proposed reader rather than inferred from main migrations.

The [native artifact snapshot](native-artifact-snapshot.json) binds the measured
installed helper and its retained installation receipt. The source build and
native helper must be produced from the approved checkout,
not copied from an arbitrary worktree or inferred from package versions. Record
hash inventories for source, all dist files, native helper, runtime receipt/tree,
unit files and effective configuration. A self-generated runtime receipt or copying
NVM contents into a root directory does not establish official artifact provenance.
Do not overwrite an existing verified runtime in place.

## Current operating state versus proposed deployment

The [restoration receipt](../m2-m5-final-evidence-20261020/m5-final-runtime-restored-20261020.json)
proves original db44 restoration after Task9: external native13 tools and
healthy/ok/ready at2026-10-20T09:13:15Z, agent78194/tunnel78234 at that observation,
zero restarts and matching original configuration. A2026-10-21 read-only owner check reconfirmed those PIDs active with zero restarts
and locks, but they must still be re-read before any future operation. At the
October 20 restoration, both completed-database fingerprints matched and temporary
owned overrides were absent. Candidate deployment was false.

Later TASK10 failed repository resolution without commands/checks/worktree/push/PR
or lock; the full current DB therefore legitimately differs from the October20
completion backup. Preserve that history too and take a fresh checkpoint. Do not
restore the older DB snapshot to manufacture fingerprint equality.

Future activation must freshly read the actual service identities, active Tasks,
lease/lock files, DB integrity and source/dist/configuration before touching them.
An active Task or unexplained lock blocks deployment. This document does not
restart services or authorize recovering a lock. Ordinary Task controls must remain
isolated and no generic Windows execution route, public MCP listener or broader
secret/token permission may be added.

## Feasible rollback, with an explicit compatibility gate

Task9 demonstrated a verified return from9d to the frozen db44 source/dist/config,
without restoring stale database contents: completed Task/history and all observation
rows were preserved. This is evidence for that specific schema/artifact pair,
not a general guarantee that every older build can read a future database. In
particular, db44 lacks the new candidate's credential-isolation protection; returning
to that build is not a security-equivalent production rollback. Deployment approval
must explicitly authorize this security-degrading emergency fallback and any
required operational restrictions; ordinary verification work must not silently
resume under a build lacking the credential boundary.

Before approving a future rollback, compare old/new migration sources and schema
versions, persisted enum/data formats and journal behavior. On isolated online
backup copies, verify the proposed older reader/startup path does not mutate,
misinterpret or lose newly written Task, review, commit or observation records.
Record the exact old/new SHA and schema compatibility result. If incompatible,
rollback is blocked until a separately approved, reviewed recovery path exists;
do not improvise database downgrades or apply migrations under this document.

Required safe sequence after separate operational approval:

1. Freeze exact target artifact/configuration identities and prove no active work.
   Take online main/journal backups, verify integrity and restore-copy fingerprints;
   preserve historical worktree/index/diff and remote-push evidence.
2. Normal-stop tunnel then agent using reviewed idle/write-barrier/process-generation
   safeguards. Prove owner and descendants exited and heartbeat stopped. Never
   force-kill, delete locks by TTL or relabel FAILED Tasks to resume them.
3. Apply only exact approved code/configuration changes. Start agent then tunnel;
   bind PID/start ticks/boot/cgroup and canonical executable identity throughout
   readiness. Validate node/npm, typed Git and isolated worker prerequisites.
4. Require actual external native MCP catalog/health correlation, exact DB/journal
   preservation and reviewed evidence before declaring the operation complete.
5. If rollback is needed, use only the previously audited compatible original
   source/dist/configuration. Preserve the current completed database state and
   append-only evidence; do not reset worktrees or replay failed Tasks. Any partial
   failure stops further steps and requires an evidence-bound recovery decision.

Never replace the current DB with an older backup merely to make startup succeed.
No Task deletion, branch force-push, historical worktree cleanup, secret issuance,
protection/billing change or unrelated parallel-PR integration is part of rollback.

## Final readiness inputs still to be attached

The execution owner will bind fresh final-HEAD tests, required CI, independent
review and a current-main merge rehearsal to the approved artifacts. In particular,
recheck215/217 duplication and206/208/211 ancestry, unexpected file changes and
production equivalence to9d. This plan records no unexecuted fresh result as PASS.
Even after `READY_FOR_FINAL_APPROVAL`, the user retains separate decisions for
main merge, #77 closure, release/tag, deployment and any necessary migration.
