# MAC-02 Service Lifecycle — Supervisor State-Machine Checkpoint

**Updated:** 2026-09-28 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. State-machine components are tested; this is not an installed or deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Verified final code/test checkpoint:** `bd3234baa51cc4dd3c9dc238822ffef0772bdadb`.  
**Product implementation checkpoint:** `2b3999721b502b54d935437bd8a4ca377617d433`.  
**Continuation baseline:** `1fe69afb42638d4e173bb580d6c8f9a36381a79d` (Task 5 scaffold and nine tests).  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Actual progress and next boundary

| Task | Actual state |
|---|---|
| Task 1 | Strict LAB_ONLY configuration and fixed plist rendering implemented |
| Task 2 | Native/static preflight components exist; independently trusted helper provisioning, real fixed-root acceptance and installed live ownership remain gates |
| Task 3 | Restart history, safe status/events, bounded logs and discard-only output components implemented; production directory binding, abandoned locks and process integration remain gates |
| Task 4 | Existing native process/accepted-peer and authenticated-health components retained; they are not recreated by this change |
| Task 5 | Core/tunnel orchestration implemented with real lifecycle/telemetry stores and controlled process/clock fixtures; actual launch/stop/credential/environment/output bindings and runnable CLI are not implemented |
| Tasks 6–7 | Administrative installation, rollback, uninstall, local controls and sealed packaging remain unimplemented |
| Task 8 | Component CI exists; independent review, installed lifecycle/reboot and user-device acceptance remain incomplete |

**Next implementation:** bind the Task 5 supervisor to narrowly scoped native process ports, starting with tests for fixed executable/arguments/environment, actual child identity and confirmed stop. Reuse `supervisor.ts`, Task 4 ownership/health and Task 3 persistence/output. Do not implement them again or treat callback types as trusted installation evidence.

There is still no `supervisor-cli.js`. Generated plists are **NOT DEPLOYABLE**. This workflow does not install services, create accounts, use live tunnel/store credentials, configure Keychain/TCC/FileVault/SSH or merge branches. MAC-03–05 documents remain separate at `31e66aa21b705b1793f11122c1b12d5ebf41715c`.

This runbook is the current handoff. Full earlier implementation and verification records are preserved in the immutable baseline document:
https://github.com/jskjw157/gram-coding-agent/blob/1fe69afb42638d4e173bb580d6c8f9a36381a79d/docs/operations/macos-service-lifecycle.md

## 2. Implemented supervisor component

`packages/macos-lifecycle/src/supervisor.ts` now implements `runSupervisor(role, config, deps, signal)` and `dependencyDelayMs(attempt)` instead of throwing NOT_IMPLEMENTED.

The normalized configuration and nested tunnel configuration are detached from input and frozen before crossing any dependency boundary. Only existing LAB_ONLY configuration is accepted. Invalid configuration idles without consulting process/credential ports. A disabled tunnel returns without starting anything.

The module reuses `LifecycleStore` and `TelemetryStore`; it does not create another history or logging engine. A durable begin record must succeed before spawn. Missing/corrupt history is not initialized. Sticky restart-budget blocks stay idle until cancellation rather than clearing with elapsed time.

A prior active marker is recovered only if the independent `confirmStopped` port exists and returns literal `true`. Otherwise the marker is retained and no new child starts. This is a new required native integration boundary, not a production stopped-owner implementation.

One invocation owns at most one child. The supplied child must match role, locally chosen generation and release identity. Unexpected exit is counted once using the existing generation-bound history transition. The fifth unexpected failure within the rolling 300000 ms window keeps the existing sticky block.

### Core role

- Persists its attempt before invoking the fixed-role spawn port.
- Uses a 60000 ms startup budget for spawn/probe/backoff and clamps the last retry sleep to the remaining budget.
- Backoff is 1000, 2000, 4000, 8000, 16000, then 30000 ms. Invalid attempt counters are rejected.
- Accepts only healthy evidence matching the expected generation/release, not future-dated and younger than 30000 ms.
- Emits healthy observations with 5000 ms sleeps between successful cycles. Probe and storage latency also contribute to the wall-clock cycle; this is not a real-time cadence guarantee.
- Authentication rejection or a broader tool surface stops the child and idles without repeating the authenticated probe.
- Losing healthy evidence after readiness stops the owned child; this invocation does not create a replacement itself.

### Tunnel role

- Waits for current, identity-bound core evidence before requesting compatibility or credential availability.
- Requires the configured compatibility digest and literal `true` credential availability. These are internal attestations, not authorization accepted from CLI/MCP data.
- Rechecks core after asynchronous compatibility, after credential availability, immediately before spawn, and around transport observations.
- A changed/lost core generation stops the owned tunnel before accepting another transport observation, then returns for throttled lifecycle restart. It never starts or restarts the core.
- OFFLINE alone does not restart either process. UNKNOWN is not READY. AUTH_BLOCKED stops the tunnel and idles without repeated authentication attempts.

## 3. Cancellation, uncertain outcomes and port contracts

Abort handling bounds waits/probes without exposing provider error messages. A hung health probe can be canceled while the owned child is still stopped with a fresh, non-aborted stop signal. Stop has a 20000 ms deadline.

STOPPING intent may be recorded before cleanup, but the durable active attempt is cleared only after confirmed exit/stop. Stop rejection/timeout leaves that marker intact and does not report STOPPED. A telemetry failure does not eliminate the requirement to stop an owned child.

An unresolved spawn at cancellation is not proof that no process exists. The marker remains and the result is failure. A child returned later is checked and sent through bounded owned-child cleanup, but that late cleanup does not erase the durable marker. If the supervisor process has already exited, the continuation cannot run; the future native/launchd binding must provide parent-death cleanup and refuse a new spawn while ownership is uncertain.

A foreign returned child is never killed by PID/port guessing. Its inconsistent identity blocks further action and preserves the marker. No fallback to arbitrary shell/process commands is introduced.

`SupervisorDeps` is an **internal trusted composition interface**, not a serialized API. Required native contracts remain:

- A spawn failure must leave no untracked child. Retain the actual ChildProcess handle and use Task 4 to seal its live identity.
- Successful stop means the recorded child is confirmed terminated, not that `kill()` merely returned true.
- `currentCore` must establish live owned/authenticated health, not trust a persisted status record.
- `confirmStopped` must prove absence/stopped ownership independently; a truthy string or caller claim is insufficient.
- Configuration and compatibility validation do not substitute for sealed executable/helper provenance.
- Spawn/probe signals are scoped to their operation. Native adapters must remove settled-operation listeners rather than treating the completion abort as permission to kill a running child.
- Bound executable paths, argv and environment; exclude inherited injection/proxy/secret variables and drain outputs through existing discard-only handling.

Native composition, live current-generation registration, cross-invocation ownership, process-tree cleanup, user-device installation and actual tunnel compatibility are not certified by these fixture tests.

## 4. Tests, regressions and review

The nine existing supervisor tests are retained. This continuation adds:

- `supervisor-safety.test.ts`: 25 cases, including parameterized identity/freshness and compatibility failures.
- `supervisor-races.test.ts`: 9 cases.
- `test-support/supervisor-fixture.ts`: controlled clock/process ports with actual canonical lifecycle/telemetry stores and byte-level compare-and-swap.

There are 43 supervisor cases in total. New process actions are fixture traces/promises, not real installed services. The full suite also reruns the earlier actual macOS ACL/socket/process fixtures. Test utilities remain excluded from compiled product output.

Author self-review reproduced and corrected four defects:

| Defect | Reproduction and correction |
|---|---|
| Compatibility provider could mutate the normalized config it was supposed to validate | Mutation test failed; freeze both config levels before passing them to providers |
| Unknown truthy credential response could permit tunnel spawn | UNKNOWN-string test failed; require literal true |
| Unknown truthy stopped-owner response could clear a prior marker | UNKNOWN-string test failed; require literal true and preserve the marker otherwise |
| Core could disappear during compatibility before credential lookup | Ordering test failed; recheck current core before credential availability |

Additional coverage confirms cancellation of hung probes, late child cleanup, refusal to stop foreign children, begin-write failure before spawn and sticky accounting after five failed starts.

**Review:** author self-review only. **Independent review NOT_PERFORMED.** No deferred minor findings were recorded. No assertion, timeout, security gate or lint rule was disabled.

## 5. Fresh verification and RED/GREEN ledger

Exact final code/test commit: `bd3234baa51cc4dd3c9dc238822ffef0772bdadb`.

| Check | Observed result |
|---|---|
| Exact-head workflow | `36404724956`, Mac and Ubuntu jobs completed/success |
| Native Mac job | `108870597114`, full log read; macOS 15.7.9, darwin/arm64, Node 24.20.0, pnpm 10.34.5 |
| Mac package suite | 38 files / **576 passed**, zero failures or skips |
| Mac root suite | 46 files / **624 passed**, zero failures or skips |
| Ubuntu job | `108870596756`, all applicable steps succeeded; Apple-only cases explicitly skipped |
| Lint, typecheck, root test, build, diff | Passed on both exact-head jobs |
| Compiled plist structure | Two roles passed, 12 altered structures rejected |
| Native plist syntax | Both generated plist files passed plutil |
| Existing root workflow | `36404724946`, completed/success; synthetic PR merge preview, not an actual merge |

- https://github.com/jskjw157/gram-coding-agent/actions/runs/36404724956
- https://github.com/jskjw157/gram-coding-agent/actions/runs/36404724946

The root total is 576 lifecycle tests plus pinned main's 48 tests. Unmerged Windows M2 and MAC-01 are not included. These counts belong to the code/test SHA above; a later documentation head has separate checks.

| Checkpoint | Evidence |
|---|---|
| Baseline scaffold `1fe69af` | Earlier native run `35829571585` / job `107078825220`: nine NOT_IMPLEMENTED failures and 533 prior passes |
| Expanded tests `0a7e5ad` | Run `36403434794`, Ubuntu `108866443811`: 34 failures, 514 prior applicable passes, 19 explicit Apple skips; timer test also exposed a late-attached scaffold rejection |
| First implementation `9a2365b` | Native job `108867378154` reported all steps successful |
| Review regressions `1bad05b` | Run `36404008355`, Ubuntu `108868261219`: four reproduced failures, 553 passes, 19 Apple skips |
| Product correction `2b39997` | Native job `108869892562`: all 576 behavioral tests passed; root stage then caught one new-test no-invalid-void-type lint error |
| Final test correction `bd3234b` | Changed deferred signal payload from void to explicit undefined; no product logic/assertion changed. Full final verification above passed |

Local authoring has Node 22/global TypeScript, no pnpm and no complete local repository checkout; direct npm DNS was unavailable. No local Node 24/full-worktree test claim is made. Actual verification uses the unchanged read-only Actions exact-head worktrees. Frozen install can normalize the existing empty workspace importer; the workflow checks that dependency resolutions remain unchanged. Packaging still must resolve this explicitly.

## 6. Rulings retained for integration

1. Require independent stopped-owner proof before recovering an old active attempt. This prevents duplicate process startup; cost: operator-assisted recovery remains necessary until a real native proof path is integrated.
2. Retain the active attempt until termination is confirmed, while recording STOPPING intent separately. This preserves orphan tracking; cost: an interrupted intentional stop may conservatively count one crash during later recovery.
3. Own at most one child per invocation. On core replacement, stop the tunnel and return for launchd's existing throttle rather than creating another child inside the same invocation. Cost: reconnection waits for that throttle.
4. Deliver internal state-machine components without pretending that callback types authenticate releases, credentials or processes. Cost: native composition and deployment acceptance remain outstanding; this is not a runnable installation.

These rulings do not waive the approved FileVault, non-admin, localhost-only MCP, secret-safe output or live-business approval requirements.

## 7. Earlier components and installation writer contract preserved

Task 1–4 product files, public package index, fixed service labels, original WSL entry points, migrations and policies are unchanged in this increment.

Task 3 retains five-crash/300000 ms accounting, canonical bounded history, digest-fenced writes, no silent reset, 30000 ms status freshness, three retained event segments of at most 5 MiB per role, and discard-only child pipes with a 20000 ms shutdown drain. Transient/crash files are not included in the retained log bound. Post-rename durability uncertainty requires reload/reconciliation, not blind retry. Abandoned locks remain BUSY; no age/PID lock stealing is authorized.

Task 4 retains live handle/start/UID/executable identity, native accepted-socket proof and same-socket authenticated requests. Its LAB_ONLY protocol sequence checks health, MCP initialization, initialized notification, exact one-tool agent_health list and exact health result. Missing/foreign/unknown proof is not OWNED. The protocol fixture is pinned, not a claim about the latest MCP specification. The native helper must still be independently trusted before deployment; temporary fixture compilation does not establish production provenance.

The Task 6 read contract remains binding:

| Record | Fixed path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind exact bytes; absent tunnel hash is null. The presently supported installed state is disabled/unregistered for both roles.

A remaining journal has exactly `schemaVersion:1`, `stage:'COMMITTED'`, and `installationDigest` matching the exact manifest SHA-256. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused, not automatically deleted or replayed. Metadata is bounded to 262144 bytes. The actual plist must match the fixed renderer, not merely a manifest-supplied hash. Any writer change requires explicit versioned review.

## 8. Isolation and exact handoff

Only `feat/macos-service-lifecycle` is written. Separate observed refs: main `fdf5dda`, Windows M2 `f6daebed`, MAC-01 `a98c8ff`, docs `31e66aa`. Windows advanced externally; refresh all refs before continuing and preserve concurrent work.

Continue Task 5 native composition, not Task 6 installation: fixed sealed process spawn, environment allowlist, live owner registration, actual confirmed stop and child-output integration. Add tests that reject unknown executable/helper identity and prove no untracked child survives cancellation or supervisor death. Do not expose an arbitrary executable/path/shell API to make the fixture ports runnable.

Keep Task 2 helper provenance/fixed roots, Task 3 production run/log binding and abandoned-lock recovery, Task 6 authorization/transactions, Task 7 CLI/sealed packaging and Task 8 independent/user-device acceptance explicit. Real administrator writes, live credentials, publication and merge retain separate gates.

**NOT_RUN:** user-Mac provisioning, installed launchd start/stop/reboot, production run/log directory binding, supervisor-native spawn/stop wiring, actual tunnel credentials, Keychain/TCC, browser or HAAR workflows. No service, account, credential, OS permission or live store was changed. No merge, force push, rebase, branch deletion or Windows issue closure occurred.
