# MAC-02 Service Lifecycle — Native Core Custody Checkpoint

**Updated:** 2026-09-29 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Native Core port component tested; not an installed/deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Verified exact-head code/test checkpoint:** `1da1c744445981f379882ad3033e3b76dca45b3e`.  
**Product code checkpoint:** `d4a040519186cdf65217deee467576953711e012`.  
**Continuation baseline:** `6e9da00853ac807b536824020d018260fc7f4085`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Actual progress and next boundary

| Task | Actual state |
|---|---|
| Task 1 | Strict LAB_ONLY configuration and fixed plist renderer retained |
| Task 2 | Native/static preflight exists; independently trusted helper provisioning, fixed-root acceptance and installed ownership remain gates |
| Task 3 | Restart history, private persistence, telemetry and discard-only output retained; production directories and abandoned-lock recovery remain gates |
| Task 4 | Existing native process/accepted-peer and authenticated-health components retained |
| Task 5 | State machines retained; new fixed Core launch recipe, direct-child custody, scoped health binding and confirmed-stop port implemented and component-tested |
| Task 5 remaining | Independent production launch authority, runtime-wide exclusivity, complete native composition, cross-daemon currentCore proof, compatible native tunnel port and runnable CLI |
| Tasks 6–7 | Administrative install/rollback/uninstall/reset and sealed packaging remain unimplemented |
| Task 8 | Component CI exists; full installed lifecycle/reboot, independent review and user-device acceptance remain incomplete |

There is still no `supervisor-cli.js`. Generated plists are **NOT DEPLOYABLE**. No service/account/credential, Keychain/TCC/FileVault/SSH setting, real tunnel or HAAR operation was changed. MAC-03–05 documents remain separate at `31e66aa21b705b1793f11122c1b12d5ebf41715c`.

This is the current handoff. Earlier state-machine implementation and verification are preserved at:
https://github.com/jskjw157/gram-coding-agent/blob/6e9da00853ac807b536824020d018260fc7f4085/docs/operations/macos-service-lifecycle.md

## 2. New Core process component

`packages/macos-lifecycle/src/adapters/native-core.ts` adds `coreLaunchPlan(config)` and `createNativeCorePort(options)`. These are internal composition modules. The public package index, MCP surface and approved configuration schema are unchanged.

The immutable launch recipe derives one executable, one argument and one working directory from validated LAB_ONLY configuration:

- executable: `/Library/Application Support/HAAR/GramAgent/releases/<releaseId>/bin/node`;
- sole argument: the same release's `apps/agent/dist/main.js`;
- working directory: the same release root;
- environment: only `PATH=/usr/bin:/bin`, `LANG=C`, `LC_ALL=C`, `HOME=/Users/gram-agent`, fixed `GRAM_AGENT_STATE_DIR` and fixed `GRAM_AGENT_SECRET_DIR`.

The recipe does not inherit process.env, loader injection options, proxy settings or parent tokens. It contains directory references, not secret values. The default launcher refuses non-macOS/non-arm64/root execution, sets shell=false and detached=false, ignores stdin and gives the output owner only the direct child's two pipes. It neither changes uid nor signals a process group.

The factory requires a local launch authority and a credential-use port. There is deliberately no default authority or secret provider. The authority must independently validate the sealed release, account, runtime paths, exclusive ownership and native helper provenance before issuing its in-process grant. Matching digest fields or a callback type alone does not establish that trust. The component validates config binding, explicit non-admin identity, current process UID/GID and executable device/inode shape. Command paths and environment cannot be overridden by the grant.

**Production authority and fixed-root launch have not been implemented or accepted.** The internal launcher substitution is used by isolated tests and is not exposed in CLI/MCP/configuration.

## 3. Child custody, termination and uncertainty

One factory accepts one start attempt and retains the actual ChildProcess object privately. A frozen ManagedChild is registered by object identity; a copied/foreign object cannot request stop. The exit promise resolves only on the direct child's actual exit event. Post-launch error events and a successful signal dispatch do not resolve it.

After the spawn event and explicit PID validation, the original live object is passed to the existing process-sealing component. It is not replaced by a spread/snapshot of exit properties. A short independent seal window supports cleanup when the caller cancels just after the OS creates a child.

If start is canceled after a valid seal, cleanup must confirm exit before rejecting. If the live child cannot be proven and safely stopped, its start promise remains pending until actual exit; custody and the single-start restriction remain. The supervisor's existing timeout path then preserves the durable attempt rather than interpreting a rejected start as proof of absence. This is a conservative quarantine, not autonomous orphan recovery.

Stop validates the registered object and a caller budget of 1–20000 ms. It checks current native identity before SIGTERM, reserves part of the same total budget, and checks again before SIGKILL if needed. The grace period is at most 15000 ms or 75% of a shorter budget, less time already spent on proof. Successful return requires actual termination and completion of the output handling, not merely kill() returning true.

The post-TERM check uses the existing native proof.current over the sealed identity instead of LiveProcessHandle.killed. A child may have received a signal while still running; that flag is not termination evidence. FOREIGN/UNKNOWN proof prevents signalling/escalation. Concurrent stop requests share one termination operation. Timeout, cancellation or uncertainty yields CORE_STOP_UNKNOWN and must not clear the durable active marker.

The existing discard-only output module is attached immediately. No child stdout/stderr contents, raw spawn error path or provider error string are included in public handles or errors. A matching current child can be passed to the existing owned-connection health probe; foreign/expired/canceled requests return UNKNOWN without credential acquisition.

This port manages the direct child only. It is not atomic protection against root/compromised same-UID code and is not proof of process-tree or supervisor-death cleanup. Cross-instance exclusivity, helper provenance and recovery remain explicit integration gates.

## 4. Tests and observed corrections

`adapters/native-core.test.ts` adds **27 cases**. Its process operations create real temporary Node child processes on the CI host; launch authority and native identity proof are synthetic in these new tests. The factory's fixed /Library launch recipe is inspected, while the internal fixture launcher substitutes a harmless Node script. No installed service, real agent database or secret directory is opened.

Coverage includes fixed arguments/environment, poisoned inherited variables, missing/invalid authority, single-start registration, actual exit ordering, copied/foreign handles, unknown identity, TERM-resistant children and revalidated KILL, loss of proof before escalation, cancellation before/after spawn, quarantine of an unprovable child, safe ENOENT errors and invalid stop budgets.

TDD/review record:

| Checkpoint | Actual result |
|---|---|
| RED `1f49ec2` | Mac run36479916085/job109122734089: 27 new NOT_IMPLEMENTED failures and one existing acceptance-timing failure; 28 failed/575 passed |
| First implementation `3e2f8ba` | Both focused platform behavioral steps succeeded; root typecheck found ChildProcess.pid incompatibility under exactOptionalPropertyTypes |
| Type correction `d4a0405` | Validate the actual spawned PID, then narrow the original live object; do not relax compiler flags or snapshot live fields |
| Fixture correction `1da1c74` | Existing no-reconnect test now awaits the server connection event instead of one setImmediate; exact one-connection and zero-byte assertions retained |

The initial old-test failure was `adapters/loopback-http.test.ts:69`, expected accepted=1 but observed0. The actual source used one event-loop tick as a proxy for server acceptance. The correction changes only that fixture synchronization; the production transport and its security assertions are unchanged.

A proposed **additional** combined native Core-port/libproc/health fixture upload was blocked by the tool's security check. It produced no blob/file and was stopped, not retried through another tool. That extra fixture is **NOT ADDED / NOT RUN**. Existing native process/socket/ACL tests still run separately; they must not be described as validation of this unadded combined scenario.

Review is **author self-review** of launch/cancel/error/exit ordering, scope restrictions and custody. **Independent review NOT_PERFORMED.** No production security certification is claimed.

## 5. Fresh exact-head verification

Full focused workflow `36481264156`, exact checkout `1da1c744445981f379882ad3033e3b76dca45b3e`, completed/success:

| Verification | Observed result |
|---|---|
| Mac job | `109127203625`; full log read; macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5 |
| Mac lifecycle suite | **39 files /603 passed**, no failures or skips |
| Mac root suite | **47 files /651 passed**, no failures or skips |
| Ubuntu job | `109127203066`; applicable workflow steps checked separately; Apple-only tests are not native passes |
| Root quality gates | lint, typecheck, root tests, build and diff checks passed in the focused workflow |
| Compiled plist | two valid roles and12 negative structures checked; native plutil passed both generated files |
| Existing root workflow | `36481264067`, completed/success; PR synthetic merge preview, not an actual merge |

- https://github.com/jskjw157/gram-coding-agent/actions/runs/36481264156
- https://github.com/jskjw157/gram-coding-agent/actions/runs/36481264067

The root total includes603 lifecycle cases and pinned main's48; separate unmerged Windows M2 and MAC-01 tests are not included. A later documentation commit's checks are separate from these counted code/test logs. Test runner tooling emits upstream deprecation notices; no zero-warning claim is made.

Local authoring has Node22/global TypeScript, no pnpm/full checkout. GitHub DNS was attempted and unavailable locally. Full repository tests used the unchanged read-only GitHub Actions exact-head detached worktrees. No local Node24/full-worktree run is claimed. Existing empty-workspace-importer normalization remains a packaging gate; dependency resolutions and workflows were not changed.

## 6. Existing behavior and installation contract retained

The state machines still require durable begin-before-spawn and explicit independent stopped-owner proof before recovering old attempts. Five unexpected exits within300000 ms produce a sticky block; missing/corrupt history does not initialize itself. STOPPING intent is separate from clearing the marker. A native port's rejection must not falsely assert that a child is gone.

Task3 retains30000 ms observation freshness, three retained event files <=5 MiB per role, digest-fenced private writes and discard-only output. Post-rename durability uncertainty requires reload/reconciliation. Abandoned locks remain BUSY; there is no age/PID lock stealing. Task4 retains fixed localhost authenticated health and same-socket credential handling; its helper must be independently trusted before deployment.

The Task6 read contract remains unchanged:

| Record | Fixed path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind exact bytes; absent tunnel hash is null. The presently supported installed state is disabled/unregistered for both roles.

A remaining journal has exactly `schemaVersion:1`, `stage:'COMMITTED'`, and `installationDigest` matching the exact manifest SHA-256. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused, not automatically deleted or replayed. Metadata is bounded to262144 bytes. The actual plist must match the fixed renderer, not merely a manifest-supplied hash. Writer changes require versioned review.

## 7. Exact handoff and isolation

Continue **Task5 native composition**, not installation: independently trusted CoreAuthority and runtime-exclusive ownership, production directory/helper binding, real combined native acceptance, supervisor-death/orphan handling, cross-daemon currentCore and the separately verified restricted tunnel adapter. The generic same-socket health, native proof, stores, output and supervisor already exist and should be reused.

Task2 fixed-root/provenance, Task3 abandoned locks, Tasks6–7 administrative transactions/CLI/sealed packaging and Task8 independent/user-device acceptance remain open. No supervisor-cli.js or deployment-ready installer exists. Do not remove these gates merely to make the default native port runnable.

Only `feat/macos-service-lifecycle` was written. Starting separate refs: main=fdf5dda, Windows M2=f6daebed, MAC-01=a98c8ff, docs=31e66aa. Refresh and preserve concurrent updates before continuing. No original shared product code, WSL paths, dependency/lockfile/workflow, database migration, later-phase document or GPT-Bridge integration changed. The existing HTTP test has the synchronization-only repair described above.

**NOT_RUN:** independently trusted production authority, actual fixed-root launch, combined new Core-port/libproc/health fixture, installed launchd lifecycle/reboot, real tunnel/account/Keychain/TCC/browser/HAAR workflows and independent review. No administrator install, credentials/permissions change, merge, force push, rebase, branch deletion or Windows issue closure occurred.
