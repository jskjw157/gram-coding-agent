# MAC-02 Service Lifecycle — Service Session and Entry Composition Checkpoint

**Updated:** 2026-09-29 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Internal entry/session/store composition is tested; not an installed or deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Parallel ownership:** #139 v2; ChatGPT A #143; installer repairs #146–149; packaging #141; public CLI #142.  
**Verified code/test checkpoint:** `1ed96987eaef17fc622764a65034ff7b4772ef66`.  
**Product implementation checkpoint:** `55b7567342f49d1407e49f93a65243c65b68f95b`; the next commit adds tests only.  
**Continuation baseline:** `7dcf782f60cd183580303715d3accb2e59e3e226`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.

## 1. Actual progress and unchanged boundaries

This increment adds three product modules and four test files (39 cases). Two existing A-owned adapters receive additive changes: `logsPolicy` on the directory witness and an extended runtime return type. No installer repair, public CLI, packaging, native C helper, shared configuration/release/preview schema, dependency, lockfile or workflow was changed.

| Area | Implemented in this increment |
|---|---|
| Runtime stores | Existing circuit/status/event engines now consume the verified run/log directory witness, with checks before and after operations |
| Service session | One invocation of the existing supervisor, bound configuration/methods, native clock and UUID defaults, no second state machine |
| Internal entry | Fixed launchd argument grammar, cancellation hooks before bootstrap, bounded bootstrap and awaited session termination |
| Composed tests | Actual temporary records plus controlled child lifecycle, real clock/UUID, delayed child completion, no credential reads on pre-cancellation |
| Not delivered | Independently provisioned bootstrap, runnable `supervisor-cli.js`, verified native tunnel, installed acceptance or business operations |

**The generated plists are still NOT DEPLOYABLE.** `supervisor-entry.ts` is a library entry function, not a replacement executable or a permissive bootstrap. The production `supervisor-cli.js` is deliberately still absent rather than adding a fake success entry just to satisfy packaging.

Previous runtime/discovery implementation and historical verification remain available at:
https://github.com/jskjw157/gram-coding-agent/blob/7dcf782f60cd183580303715d3accb2e59e3e226/docs/operations/macos-service-lifecycle.md

## 2. Runtime store binding

`adapters/runtime-stores.ts` exports `createRuntimeStores(directories): RuntimeStores`. It reuses `LifecycleStore`, `TelemetryStore`, `createCircuitFilesAt` and `createTelemetryFilesAt`. No alternate file formats, migrations, filename choices or recovery algorithm are introduced.

`RuntimeDirectories` now exposes `logsPolicy` alongside `runPolicy`. All record operations call the existing directory witness before and after IO. Replacing the pinned run/log directory or changing private permissions invalidates the binding. Existing private-record CAS, descriptor/ACL checks, file/directory sync, transaction locks and safe errors are preserved.

`ReviewedCoreRuntime` remains unchanged for existing consumers. The bind functions return an additive `ReviewedServiceRuntime` subtype containing `configuration: Readonly<ServiceConfig>` and `stores`, in addition to authority, execution, registration and the Core status reader. The normalized configuration and nested tunnel settings are frozen.

Construction does not initialize missing circuit history, clear execution reservations, repair directories or read secrets. Tests explicitly call the existing absent-only initializer to provision their temporary fixtures; the runtime/session path never does that. Existing HELD records and uncertain previous attempts remain blockers until independently verified stopped recovery exists.

## 3. Single-use service session and internal entry

`service-session.ts` exports `createServiceSession(role, config, deps)` and `createReviewedServiceSession(role, runtime, credentials, tunnel?)`.

The first factory fixes configuration and port method bindings before its first asynchronous work and delegates to the existing `runSupervisor`. A session may run only once, including after a pre-cancelled invocation. The default clock uses actual time and abortable Node timers; default generations are UUIDs. Disabled tunnel sessions are no-ops. Enabled tunnel sessions cannot be constructed without a supplied local transport capability. These typed capabilities are trusted composition dependencies, not serialized authorization or proof that a provider is verified.

The reviewed factory reuses `createReviewedCorePorts` for native Core custody, registration and independent discovery and supplies the verified stores. This does not provision bootstrap trust, secrets, old-process recovery or tunnel compatibility.

`supervisor-entry.ts` accepts exactly `--role core|tunnel --config /Library/Application Support/HAAR/GramAgent/config/service.json`, with either flag pair first. Duplicate/missing/unknown flags, arbitrary paths, extra positional arguments, array accessors and malformed input are refused before preparation or signal registration. This is NOT the external lane D management CLI.

`runSupervisorEntry(argv, bootstrap?, signals?)` installs SIGINT/SIGTERM hooks before preparation. `bootstrap.prepare` has a 10-second deadline and must be side-effect-free: no child launch, mutations or retained resources. Cancellation/timeout does not run a late returned session. Once a session is running, the entry awaits its completion rather than racing cancellation to a false success. Only its own listeners are removed, including after partial listener-registration failure. It never calls `process.exit`, loads arbitrary modules, prints raw provider errors or accepts credentials in arguments.

Internal exit codes: 0 normal termination, 1 supervisor failure, 64 invalid usage, 70 fixed internal error, 78 bootstrap unavailable. Exit0 is not readiness or completion of shopping-mall work. A misbehaving running session that never resolves is not converted to success; correct owned shutdown is still the session/native port's contract.

## 4. Verification actually executed

Clean RED `d3f73245bb2c30776a97913fdb6d3fcf121fe5a5`, workflow36573621999 / native Mac109423497259: **36 new failures /738 prior passes**, no skips or unhandled rejections. The earlier scaffold run1ca59ce also exposed test-harness early-rejection handling; this was corrected before implementation without weakening assertions.

First implementation1139983 passed behavioral tests but root lint found four issues: two unused test bindings, an invalid void payload and an unused initial assignment. Corrections55b7567 preserved all lint rules and supplied an explicit tunnel port type. The invalid-argv parameterized matrix was also corrected to pass complete vectors instead of spreading rows. Test-only1ed9698 added three composition/default-clock/listener-cleanup checks; these validate existing behavior and are not claimed as three newly failing implementation cases.

Exact final code/test `1ed96987eaef17fc622764a65034ff7b4772ef66`, focused workflow **36574845587**, completed/success:

- Native Mac job **109427695752**, complete job log read: macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5.
- **Mac lifecycle:57 files /777 passed**, zero failed/skipped.
- **Mac root:65 files /825 passed**, zero failed/skipped. Root825 includes lifecycle777 plus pinned main48; do not add these counts together.
- Ubuntu job **109427695253**: all applicable steps completed successfully. Apple-only tests and native plutil are not counted as Linux-native passes; no separate final Linux test count is claimed here.
- Root lint/typecheck/test/build/diff passed on both jobs. Production build excludes tests and test support.
- Compiled plist validation accepted two roles and rejected12 altered structures; native plutil accepted both files.
- Existing root workflow **36574845600**, completed/success; a synthetic PR merge preview, not an actual merge.

https://github.com/jskjw157/gram-coding-agent/actions/runs/36574845587
https://github.com/jskjw157/gram-coding-agent/actions/runs/36574845600

New tests use real temporary record files, controlled account/bootstrap ACL/child ports and in-process signal emitters. One composition test uses real Node clock/UUID defaults and checks STOPPING until the controlled child is permitted to complete; it does not launch a real daemon. The reviewed native-port factory is tested only for construction/pre-cancellation here. Existing native helper/socket/ACL suites rerun separately. This is not installed launchd, combined real Core/libproc/health, real tunnel, credential or reboot acceptance. The earlier security-blocked combined fixture was not retried.

Independent whole-branch review remains deferred/not performed for this increment. Local direct Git access failed DNS and the authoring environment lacks pnpm/Node24; full verification used unchanged read-only Actions exact-head isolated worktrees. Separate MAC-01, Windows M2 and external installer/repair/packaging/CLI code are not in these counts. Later documentation-head runs are separate from the counted code/test logs.

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

Existing run records remain `core.execution.json`, `tunnel.execution.json` with fixed transaction locks `core.execution.lock`, `tunnel.execution.lock`. Verified new installation alone may initialize absent records. Existing HELD state, generation and revision must survive upgrade/rollback. Runtime binding never calls initializeNew or resets locks. The Core process hint needs no installer initialization: absence remains unavailable until a validated Core publishes it. Preserve the run directory and last hint; no new external schema or path option is required.

## 6. Parallel handoff and next exact work

A #143 continues with independently provisioned bootstrap review/ACL/credential capabilities and the real fixed `supervisor-cli.ts` launcher, then the separately verified restricted native tunnel. Reuse `createReviewedServiceSession` and `runSupervisorEntry` instead of another lifecycle engine. Native bootstrap must obey the no-retained-resources preparation contract and supply validated configuration and use-only credentials without argv/env-based arbitrary module loading.

B1–B4 (#146–149), packagingC #141 and public CLI D #142 remain independently owned. The installer branch advanced externally to463ca943331846013c78b7fa80aacc11ab433b4d while this increment was running. That update was preserved, not reviewed, reverted or merged here; no claim that prior PR144 review findings are now fixed. PR145 remains separate review evidence. Latest external heads require their own review/combined tests before integration.

Actual fixed-root trust provisioning, full-size timing, supervisor-death/orphan recovery, installed launchd/logout/reboot, final integration and deferred review remain open. No administrator installation, service/account/credential/Keychain/TCC/FileVault/SSH/tunnel/browser/store change, merge, force push, rebase, branch deletion or Windows issue closure was performed. Preserve other agents' concurrent updates.
