# MAC-02 Service Lifecycle — Durable Core Reservation Checkpoint

**Updated:** 2026-09-29 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. This increment implements cooperative execution reservations; it is not a deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Code/test checkpoint:** `4401a6648cc6784ec594efc20998eed09918049f`.  
**Continuation baseline:** `796e102bf1efadc715a57775e5377bf38d1e5923`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.

## 1. Actual progress, not a completion percentage

| Scope | Actual state / remaining work |
|---|---|
| MAC-01 | Implemented on its separate unmerged branch; not included in this branch's test totals |
| MAC-02 Tasks 1–4 | Existing configuration, preflight, persistence, telemetry and owned-health components retained; real fixed-root/helper provenance, production directory binding and safe abandoned-lock recovery remain gates |
| MAC-02 Task 5 | Supervisor/native Core retained; durable reservation now fences starts across cooperating factories using the same trusted storage. Production CoreAuthority, fixed-root binding, cross-daemon currentCore and native tunnel composition remain incomplete |
| MAC-02 Task 6 | Authorized installation, rollback, uninstall, explicit new-install provisioning and stopped recovery/reset not implemented |
| MAC-02 Task 7 | Runnable supervisor CLI and sealed packaging not implemented |
| MAC-02 Task 8 | Installed launchd/reboot/user-device acceptance and independent review not completed |
| MAC-03 | Detailed design/plan only: 9 tasks for non-coding operations, approval, effects, scheduling and artifacts |
| MAC-04 | Detailed design/plan only: 11 tasks for browser/API routing, credential use and GUI boundaries |
| MAC-05 | Detailed design/plan only: 8 tasks for a single-product local draft/review bundle, not live publication |

There is still no `supervisor-cli.js`. Generated plists are **NOT DEPLOYABLE**. The remaining MAC-02 work is Task 5 integration plus Tasks 6–8 and unresolved Tasks 2–3 acceptance gates, not simply three small changes. The 28 later-phase tasks are not estimates of equal effort. Test counts are not product completion percentages or evidence of live shopping-mall operations.

The MAC-03–05 index remains on documentation branch commit `31e66aa21b705b1793f11122c1b12d5ebf41715c`. Its first business outcome is a local product draft, with no storefront write. Orders, refunds, advertising and outbound CS are not completed by that fixture outcome.

Earlier native Core implementation and verification remain available at the immutable baseline:
https://github.com/jskjw157/gram-coding-agent/blob/796e102bf1efadc715a57775e5377bf38d1e5923/docs/operations/macos-service-lifecycle.md

## 2. Implemented reservation and launch boundary

New product modules:
- `execution-lease.ts`: canonical bounded execution records, explicit absent-only initialization, atomic reservation and original-object release capabilities.
- `exclusive-core.ts`: reserve-before-native-start and release-after-confirmed-exit composition.
- `adapters/execution-files.ts`: fixed private execution record family using the existing file CAS mechanics.

`adapters/private-record-files.ts` adds the fixed `execution` family and its validator. Existing circuit/status/event filenames, limits and mechanics remain unchanged. `adapters/native-core.ts` now requires a valid ExecutionLeaseStore before using the default native launcher. Invalid or missing providers are rejected before launch authority/credential use. The explicit in-process fixture launcher remains an isolated testing dependency, not a CLI/MCP/configuration command feature.

An ExecutionRecord contains exactly schemaVersion, role, revision, state, token, generation, configDigest and releaseDigest. The initial FREE revision0 has null identity fields. Later acquisitions/releases monotonically advance the revision; HELD uses odd revisions and FREE uses even revisions. The UUID token identifies a reservation and is not a service credential or authorization token. Free records retain the previous generation as a tombstone instead of deleting the file. The immediately previous generation cannot be reused; callers still supply unique generation IDs.

Missing/corrupt state never becomes permission to launch. There is no TTL, elapsed-time reset, PID inspection for stealing, or automatic removal of an abandoned HELD reservation or transaction lock. Concurrent stores compete with digest compare-and-swap; only the winner can proceed. Release accepts the original in-memory capability only, is idempotent after success, and never retries an uncertain operation against a newer record.

The Core wrapper acquires the shared reservation before the inner native port (including authority acquisition). A definite no-child rejection releases under the existing strict native-port contract. An unresolved launch remains reserved; an invalid fulfilled child identity is ambiguous and is not freed or signalled by PID guessing.

Actual inner-child exit initiates reservation release. The wrapper's outward exit promise completes only after release completes, so the supervisor cannot treat mere signal delivery as successful cleanup. A rejected exit or uncertain release disables health forwarding and does not manufacture permission to start another child. Stop observes the original registered handle and one <=20000ms budget; copied handles are refused.

This is **cooperative exclusion over the same independently trusted run directory**, not a sandbox against root or hostile same-UID code. It does not provide production CoreAuthority, attest a helper, authenticate a process, prove no orphan exists, or establish cross-daemon health by itself. The file reservation is occupancy evidence, not process liveness.

## 3. Verification scope and review record

Five new test files add 43 cases: execution-lease15, exclusive-core14, execution-files6, execution-boundary7, execution-process1. Test support uses actual canonical stores and digest CAS. Filesystem cases use temporary private directories and a synthetic ACL predicate. The process contention case starts a separate temporary Node child that owns the fixed transaction lock; a competing acquisition returns BUSY without deleting or changing that lock. This is not an installed two-daemon or production-authority test.

| Checkpoint | Observed evidence |
|---|---|
| RED `15a1278` | Lifecycle36491201850, Mac109159959165: 35 new failures /603 prior passes |
| First implementation `922fe5a` | Lifecycle36491599226 and root36491599255 completed/success |
| Review RED `df317cf` | Lifecycle36491809753, Mac109161946823: 3 failures /642 passes. Null/false provider accepted; ambiguous exit still forwarded healthy evidence |
| Additional fixture `975b3f4` | Adds separate-process transaction-lock contention test; not a production bootstrap test |
| Corrections `1f52efc` + `4401a66` | Normalize provider type before authority use; disable health after rejected exit without releasing the HELD slot |

### Final exact-head checks

Code/test commit `4401a6648cc6784ec594efc20998eed09918049f`:

| Check | Evidence |
|---|---|
| Focused lifecycle run | `36492204440`; Mac and Ubuntu jobs completed/success |
| Native Mac | Job `109163214001`, full log read; macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5 |
| Mac lifecycle suite | **44 files /646 tests passed**, zero failed or skipped |
| Mac root suite | **52 files /694 tests passed**, zero failed or skipped |
| Ubuntu | Job `109163214246`; applicable steps completed/success; Apple-only cases remain explicitly skipped |
| Quality checks | Root lint/typecheck/test/build/diff checks passed; test support excluded from compiled production output |
| Plist validation | Two generated roles passed structure checks,12 altered structures rejected; native plutil accepted both files |
| Existing root CI | `36492204438`, completed/success; synthetic PR merge preview, not an actual merge |

https://github.com/jskjw157/gram-coding-agent/actions/runs/36492204440
https://github.com/jskjw157/gram-coding-agent/actions/runs/36492204438

A later documentation-head workflow is separate from the counted code/test log. Upstream runner deprecation notices are not claimed to have been removed.

The root suite includes this branch's lifecycle tests and main's48 tests. Separate MAC-01 and Windows M2 branches are excluded. Apple-only tests skipped on Linux are not native passes. No assertion, security gate, lint rule, deadline or workflow was relaxed. No dependency or lockfile update was made.

**Independent review NOT_PERFORMED.** Review in this increment is author self-review. The earlier security-blocked combined Core/libproc/health fixture was not retried and remains NOT_ADDED/NOT_RUN; this reservation work does not substitute for it.

Local authoring has no full repository checkout/pnpm/Node24; direct GitHub DNS was attempted and unavailable. Full validation uses the unchanged read-only GitHub Actions exact-head worktrees. The existing empty-workspace-importer normalization remains a packaging gate. No local full-suite claim is made.

## 4. Rulings, costs and provisioning contract

Ruling: implement occupancy persistence before production authority integration, reusing the existing private-file CAS. Reason: the previous one-factory guard cannot serialize independent launches. Cost: bootstrap must still bind every default factory to one trustworthy location; this component alone is not host-wide deployment proof.

Ruling: a held record never expires and an unresolved launch never frees it. Reason: a crashed supervisor may leave a live child. Cost: unavailable or abandoned state requires separately authorized stopped-owner recovery; this increment does not implement that recovery.

Ruling: reserve before the authority call. Reason: validate and spawn only after exclusive access is acquired. Cost: even a pre-spawn crash can leave HELD, intentionally blocking unsafe retries.

Ruling: no automatic reinitialization/migration/reset of execution state. Task6 must explicitly provision absent records only for a verified new installation. Existing installs must be stopped and reconciled before adding this family. A rollback must preserve reservation generations/revisions and must not remove a HELD file to run an older version. Unknown durability requires reconciliation, not a blind rewrite.

Required fixed record names under the eventual trusted private run directory:
- `core.execution.json`, `tunnel.execution.json`;
- transaction locks `core.execution.lock`, `tunnel.execution.lock`.

The runtime adapter does not create that directory or select an arbitrary public destination. Files require restrictive ownership/modes and independent ACL verification, just like existing private records. Production fixed-root directory setup is still pending.

## 5. Existing installer read contract retained

| Record | Fixed path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind exact bytes; absent tunnel hash is null. The presently supported installed state is disabled/unregistered for both roles.

A remaining journal has exactly `schemaVersion:1`, `stage:'COMMITTED'`, and `installationDigest` matching the exact manifest SHA-256. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused, not automatically deleted or replayed. Metadata is bounded to262144 bytes. The actual plist must match the fixed renderer, not merely a manifest-supplied hash. Writer changes require versioned review.


## 6. Exact next work and isolation

Continue Task5 integration with independently trusted CoreAuthority: reviewed release digest, account and executable identity, helper provenance, fixed state/secret/run directories and no live orphan. Reuse the existing reservation, Core custody, supervisor, owned-health and file inspection components instead of rebuilding them. Bind cross-daemon currentCore and the separately verified restricted native tunnel port, then provide the runnable CLI. Finish Task2/3 trust/abandoned-lock gates alongside Task6 provisioning and stopped recovery. Do not enable the native default by injecting test grants or a synthetic ACL predicate.

Task6 administrative transactions, Task7 sealed packaging and Task8 independent/user-device launchd and reboot acceptance remain open. No real credential, service, account, Keychain/TCC/FileVault/SSH, tunnel, browser or HAAR operation was provisioned. No installer or live store write was executed.

Only `feat/macos-service-lifecycle` was written. Baseline separate refs: main=fdf5dda, Windows M2=f6daebed, MAC-01=a98c8ff, documentation=31e66aa. Preserve later concurrent work. No main/WSL/shared product code, workflow, lockfile, migration, MAC-03–05 implementation or GPT-Bridge integration changed. No merge, force push, rebase, branch deletion, or Windows issue closure.
