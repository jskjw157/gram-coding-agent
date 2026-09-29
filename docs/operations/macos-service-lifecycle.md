# MAC-02 Service Lifecycle — Independent Core Discovery Checkpoint

**Updated:** 2026-09-29 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Core registration, independent observation and composition are tested components; not an installed/deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Parallel ownership:** #139 coordination; #143 ChatGPT A; #140 installer B; #141 packaging C; #142 diagnostic/CLI D.  
**Verified code/test checkpoint:** `c393e7056493dac3d5a3793df84669ba5b737a82`.  
**Continuation baseline:** `6d76d6fc1ec3cc9dae32880676c1cac724c28150`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.

## 1. Actual progress and parallel boundary

This increment adds five runtime modules, seven test files (54 cases) and one test fixture. Two existing A-owned adapters receive additive changes: the private record family and reviewed-runtime observation ports. No B/C/D file, shared configuration/release/preview/installation schema, dependency, lockfile, workflow or original Windows product module changed.

| Area | Actual state |
|---|---|
| Task 5 producer | Managed Core identity is published against its actual HELD reservation before the start is returned |
| Task 5 observer | Independent currentCore checks reservation, fresh status, reviewed native identity, exact accepted socket and the existing authenticated MCP protocol |
| Task 5 composition | Reviewed runtime exposes registration/status readers; createReviewedCorePorts composes existing native Core, registration wrapper and independent reader |
| Still open | Independently provisioned bootstrap trust, actual runnable entries, provider-verified restricted native tunnel, full-sized installed timing and orphan/stopped recovery |
| External installer | Draft PR #144 was observed at `e3c65890d276d471ea083cf30fa50e74ade91a29`; submitted, not reviewed/merged/included in these results |
| External packaging/CLI | Remain separate lane ownership; no completion claim or takeover |
| Overall | Task 5 and MAC-02 are not complete; no installed launchd/logout/reboot acceptance or business operations |

`supervisor-cli.js` is still absent on this branch. Generated plists remain **NOT DEPLOYABLE**. Independent review is deferred until combined integration per the user's instruction; this is not an independent approval.

Prior authority/directory implementation and installer contract history:
https://github.com/jskjw157/gram-coding-agent/blob/6d76d6fc1ec3cc9dae32880676c1cac724c28150/docs/operations/macos-service-lifecycle.md

## 2. Private process registration and producer

New `core-registration.ts` exports `CoreRegistrationStore.read/publish`, canonical encode/decode, native start-identity parsing and reservation matching. A registration has exactly `schemaVersion:1`, `role:'core'`, `configDigest`, `executionRevision`, `executionToken` and the existing six-field `OwnedChild`. The execution UUID is occupancy metadata, not a credential.

`adapters/core-process-files.ts` reuses private-record CAS with the fixed `process` family. Only `core.process.json` and `core.process.lock` under the already trusted private run directory are selected. Files require the existing owner/mode/descriptor/ACL checks; tunnel role, malformed records, links, writable files and preexisting transaction locks are refused. Existing circuit/status/event/execution mechanics and filenames are retained.

Publication reads the real HELD token/revision and matching normalized configuration/release/generation; callers do not choose those occupancy fields. Identical publication is a no-op. A different child in the same or older reservation is refused; a later actual HELD revision can replace an older hint. The execution record is checked around CAS. This is not a multi-file atomic transaction: a changed lease makes the hint unusable and reports failure rather than repairing history.

New `registered-core.ts` wraps only the existing managed native Core port. It publishes the original validated child before exposing startup. Failed/cancelled publication requests bounded cleanup and requires confirmed termination before a no-child rejection. If cleanup is uncertain, the start stays pending and another start is blocked. Stop uses the original managed object, not a copied PID. Discovery metadata is retained after exit; reservation release and native/freshness checks invalidate it.

No missing/corrupt execution record is initialized, no HELD slot is freed by age, no lock is stolen, and no process is killed by a port/PID guess.

## 3. Independent observer and runtime wiring

New `current-core.ts` exports `createCurrentCoreReader(config, deps)`. It returns `CoreEvidence | null`, not secrets or a process-control endpoint. Its dependencies are trusted local ports, not serialized tool responses.

Observation requires all of the following:

1. Canonical registration for the expected normalized configuration/release.
2. Matching current HELD execution token/revision/generation.
3. Existing status record with matching generation/release, `LOCAL_CORE_HEALTHY`, code `OK`, and age strictly below 30000ms; future/stale/malformed/stopping evidence is refused.
4. Independently trusted CoreAuthority grant with the recorded UID and reviewed executable identity.
5. Native proof using the recorded libproc start identity, not a new capture or a fabricated ChildProcess. The exact connected 127.0.0.1 client/server tuple must belong to the expected Core on port3847.
6. Existing checked-socket health/MCP flow: health, initialize, initialized, tools/list, agent_health. The tool surface and response parser are reused, not filtered or reimplemented.

Record/lease/status and process identity are rechecked around native proof, before credential access, inside the credential-use callback, and after the final result. A normal heartbeat refresh is allowed; a different process/generation/lease is not. Observation has a10000ms total deadline; existing wire requests retain their2000ms/64KiB limits. These conservative repeated checks still need full-sized installed timing validation.

An explicit `AUTH_BLOCKED` result suppresses subsequent sequential credential attempts for that execution token in the same reader. A distinct validated HELD acquisition may be checked anew. This latch is in-memory, not durable across reader/daemon reconstruction, not a credential-rotation policy, and not a global concurrency/rate-limit guarantee. No claim of autonomous login recovery is made.

`ReviewedCoreRuntime` now additionally returns `registration` and `readCoreStatus()`. Both use the same pinned run-directory witness before/after file access. Construction/read of absent observation files is read-only and returns unavailable; a replaced directory is refused. Existing authority/execution operations remain available.

New `core-runtime.ts` exports `createReviewedCorePorts(config, runtime, credentials) -> {core,currentCore}`. It composes the actual native Core factory with registration and the independent observer. Construction does not spawn, acquire a slot, create files or read credentials. It does not supply the missing trusted bootstrap inputs, launchd entry, service state writer wiring or tunnel provider.

## 4. Verification actually executed

Seven new test files add54 cases: registration14, observer20, producer4, process files8, runtime observation3, auth refusal4 and composition1. Real temporary files exercise persistence and pinned directory identity; identity/account/ACL/wire responses in the new composed cases are controlled fixtures. Existing native helper, socket, ACL and Core custody suites rerun separately.

| Checkpoint | Observed result |
|---|---|
| RED1 `ff5bdfa` | Focused36565210619, Ubuntu109395352103:38 expected new failures /662 prior passes /22 native skips |
| First implementation `74e8526` | Focused36565577016: both Mac and Ubuntu jobs passed all applicable steps |
| RED2 `4e6e2bb` | Focused36565945822, Mac109397746865:13 failures /725 passes; missing file/wiring behavior and repeated authentication attempt (expected1, actual2) |
| Final code `c393e70` | Focused36566552733 and root36566552798 completed successfully |

The producer fixture's initial placeholder digest was corrected to the actual `configDigest(config)` required by its contract; identity assertions were retained. New file fixtures use a real anchor/run layout, not an empty relative path, preserving the existing path validator.

Exact code/test `c393e7056493dac3d5a3793df84669ba5b737a82`:

- Native Mac job **109399780364**, full log read: macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5.
- **Mac lifecycle:53 files /738 passed**, zero failed/skipped.
- **Mac root:61 files /786 passed**, zero failed/skipped. Root786 includes lifecycle738 plus pinned main48.
- Ubuntu job **109399780078**, full log read: Node24.21.0, pnpm10.34.5; lifecycle716 passed/22 native skips; root764 passed/22 native skips.
- Root lint/typecheck/test/build/diff checks passed on both focused jobs. Test support and test JavaScript are excluded from production output.
- Compiled plist checks passed two roles and rejected12 altered structures; native plutil accepted both.
- Existing root CI **36566552798** passed its synthetic PR merge preview; no actual merge occurred.

https://github.com/jskjw157/gram-coding-agent/actions/runs/36566552733
https://github.com/jskjw157/gram-coding-agent/actions/runs/36566552798

A log request while the Mac job was still running returned BlobNotFound; the completed full log was subsequently fetched. No test was bypassed or treated as passed from that failed log request.

The new observer tests use synthetic native verdicts and wire responses through the real parser and orchestration. File/runtime tests use actual temporary files but controlled account/bootstrap trust. This is **not an installed two-daemon, real credential, native end-to-end tunnel or reboot acceptance result**. Existing native tests are not substitute evidence for that missing integration. The earlier security-blocked combined fixture was not retried.

Local direct Git access failed DNS and Node22 is not the target toolchain. Full verification used unchanged read-only Actions exact-head isolated worktrees. Separate MAC-01, Windows M2 and external PR#144 code are not included. Later documentation-head runs are separate from the counted code/test log. Upstream deprecation warnings and existing empty-importer normalization were not changed.

## 5. Existing installation and execution contracts retained

| Record | Fixed path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind actual bytes; absent tunnel hash is null. The current static installation reader supports stopped/disabled, unregistered roles, not live-owned acceptance.

Final journal exact fields: `schemaVersion:1`, `stage:'COMMITTED'`, `installationDigest` matching exact manifest bytes. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused by the existing reader, not silently removed/replayed. Metadata limit262144 bytes. Plist bytes must match the fixed renderer, not merely a manifest-supplied hash. B owns the transaction writer; A owns later live acceptance integration.

Existing run records remain `core.execution.json`, `tunnel.execution.json` with fixed transaction locks `core.execution.lock`, `tunnel.execution.lock`. Verified new installation alone may initialize absent records. Existing HELD state, generation and revision must survive upgrade/rollback. Runtime binding never calls initializeNew or resets locks. The new Core process hint needs no installer initialization: absence remains unavailable until a validated Core publishes it. Preserve the run directory and last hint; no new B/C/D schema or path option is required.

## 6. Exact next work

Continue A #143 with independently provisioned bootstrap trust and runnable supervisor composition, including actual status/history/event writers, then the separately verified restricted native tunnel. Reuse the new `createReviewedCorePorts` and existing runtime binding, custody, reservations and supervisor; do not rebuild B/C/D features.

Refresh #139 and external PRs before integration. Installer PR#144 has been submitted but is not part of this branch. Its reported tests have not been adopted as combined acceptance. Integrate external results only under the agreed authority and keep tests/review/device approval distinct. Independent review remains deferred/not performed.

Actual `/Library` trust setup, full-sized timing, supervisor-death/orphan recovery, installed launchd/logout/reboot and real restricted transport remain open. No service/account/credential/Keychain/TCC/FileVault/SSH/tunnel/browser/store operation, administrator installation, merge, force push, rebase, branch deletion or Windows issue closure was performed. Preserve concurrent external branch updates rather than resetting them.
