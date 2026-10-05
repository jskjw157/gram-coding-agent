# MAC-02 Service Lifecycle — Exact Stopped Recovery and Session Wiring Checkpoint

**Updated:** 2026-10-03 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Durable Core/Tunnel process registration and exact stopped-recovery are wired through reviewed service sessions. Production bootstrap trust/credentials, installer/packager integration and installed acceptance remain incomplete.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Verified code/test checkpoint:** `df6284197e5506936721ec544672b3e065a9ebfe`.

## Current increment — crash/reboot-safe stopped recovery

This increment closes the cooperative recovery path that previously left a HELD execution slot blocking later starts after a supervisor crash.

- Core and tunnel process registrations bind the exact execution revision/token to PID, UID, kernel start identity, generation and release digest.
- `tunnel.process.json` uses the same private run-directory protections as Core but a separate tunnel-only decoder/validator.
- tunnel start is not exposed until the durable registration is published; failed publication must confirm actual child exit before reporting a failed start.
- `ExecutionLeaseStore.recoverStopped` transitions HELD→FREE only with literal stopped proof and an exact compare-and-swap of the observed record.
- stopped recovery treats `OWNED` and `UNKNOWN` as not stopped. Only native `FOREIGN` for the exact registered PID+UID+start-time+executable identity is accepted for a HELD slot.
- stale stopped proof cannot overwrite a newer owner.
- a FREE cooperative execution slot can confirm no currently owned child without probing native process state.
- reviewed runtime binds the recovery verifier to the already reviewed release/helper/context and reviewed service-session dependencies pass that capability into the existing supervisor recovery hook.
- no TTL, process age, guessed PID, port absence, launchd label presence, stale-file deletion or truthy non-boolean evidence authorizes recovery.

### TDD / exact-head verification

Key RED checkpoints:
- `ee1ed4229cc76cf9cdfccab61b51b990fedb729c`: stopped-recovery behavior intentionally absent; 4 new failures / 882 previous passes on Ubuntu.
- `1e145aee0bd6ec67ae03fedeef6fd2bb0992c9ce`: reviewed runtime lacked `confirmStopped`; 4 new failures / 886 previous passes.
- `f63deda696a616f865569353cb0c1819bc6548b2`: reviewed session dependency glue absent; 2 new failures / 890 previous passes.

Verified exact head `df6284197e5506936721ec544672b3e065a9ebfe`:
- focused workflow `37097179807`: success on Ubuntu and native Apple Silicon Mac;
- root CI `37097179859`: success;
- native Mac lifecycle: **78 files / 914 tests passed**, zero failures/skips;
- same Mac root suite: **86 files / 962 tests passed**, zero failures/skips;
- lint, typecheck, root tests, build, diff and production-output checks passed;
- plist structure: 2 valid roles / 12 altered cases rejected; native `plutil` accepted both generated plists.

No actual launchd install, reboot/logout acceptance, administrator mutation, real credential, Keychain/TCC/FileVault change, network/tunnel session, HAAR business action or merge was performed.

### Remaining deployment blockers

- direct `supervisor-cli.js` remains fail-closed without an independently provisioned production bootstrap trust source;
- bootstrap ACL helper provenance cannot be derived only from the candidate release it is meant to verify;
- real Core/tunnel credential providers remain unprovisioned;
- installer/rollback/packaging integration and sealed artifact provenance are still pending external lanes;
- actual user-Mac launchd/reboot/logout acceptance and final privileged-boundary review remain NOT_RUN.

---

# MAC-02 Service Lifecycle — Fixed Supervisor Entry and Reviewed Tunnel Authority Checkpoint

**Updated:** 2026-10-03 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. A fixed launchd-only supervisor executable entry and reviewed tunnel binary/compatibility authority are now tested components. Independent bootstrap trust provisioning, real tunnel credential/provider health, installed service acceptance and final lane integration remain incomplete.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Verified code/test checkpoint:** `ba707e3a724335164be604b47669d7337b4ec17d`.  
**Supervisor CLI RED:** `58eba6519f2d61da0149b3f2c2a150a0b554b5b4`.  
**Tunnel authority RED:** `0d5f7690beef9f8feb8d109b97db687cd4acb763`.

## Current increment — fixed private executable entry

`supervisor-cli.ts` is the private launchd entry referenced by the generated plist. It is deliberately separate from lane D's public diagnostic/operator CLI.

- direct execution is recognized only when `process.argv[1]` is the exact absolute path represented by `import.meta.url`;
- the only accepted runtime grammar remains the existing fixed `--role core|tunnel --config <fixed installed service.json>` contract;
- public-style commands such as `status` or `start core` are rejected before bootstrap;
- importing the module has no service start, signal hook, console output or process exit side effect;
- direct execution uses `process.exitCode`, never a forced process exit;
- without an independently trusted bootstrap capability the executable fails closed with exit 78. No production success stub was added.

RED `58eba65` produced six new expected failures while 823 prior tests passed on the Ubuntu focused run. GREEN code `ec7a05fc73e5dcb1db0c4fafc99da74d49317ac2` passed focused workflow `37073174865` and root CI `37073174861`; native Mac job `111057097805` recorded **65 lifecycle files / 851 tests** and **73 root files / 899 tests**, zero failures/skips.

## Current increment — reviewed tunnel runtime authority

For a tunnel-enabled reviewed release, the existing runtime authority now additionally exposes a frozen `tunnelRuntime` containing:

- compatibility digest copied from the strict reviewed configuration;
- a `TunnelAuthority` that requires the exact configuration/compatibility and matching LOCAL_CORE_HEALTHY release evidence;
- revalidation of the existing sealed release before every grant;
- descriptor identity of the fixed `bin/tunnel-client` that remains root-owned, executable, single-link and non-writable by group/world;
- an existing durable `tunnel.execution.json` HELD reservation matching the reviewed config/release before any grant.

The tunnel executable is trusted through the already independently pinned `releaseDigest` plus full `inspectRelease` inventory/content verification. The runtime does not treat the tunnel binary's own metadata as a new trust anchor. Tunnel-enabled binding now also refuses a missing/corrupt tunnel execution record rather than initializing it.

This component does **not** read a control-plane credential, contact a provider, start a tunnel, claim provider health, or solve the independently provisioned ACL/bootstrap trust anchor.

RED `0d5f769` recorded five expected tunnel-authority failures with 830 prior tests passing. GREEN `ba707e3a724335164be604b47669d7337b4ec17d`:

- focused workflow `37073884917`: completed/success on Ubuntu and native Apple Silicon Mac;
- root CI `37073884924`: completed/success;
- native Mac job `111059326371`: **66 lifecycle files / 857 tests passed**, zero failures/skips;
- same Mac root suite: **74 files / 905 tests passed**, zero failures/skips;
- lint, typecheck, root tests, build, diff/output exclusions all passed;
- plist verifier accepted 2 roles, rejected 12 altered cases; native `plutil` accepted both plists.

No real credential, OpenAI tunnel session, service installation, administrator action, account/security setting, browser/store operation or merge was performed.

---

# MAC-02 Service Lifecycle — Durable Tunnel Execution Lease Checkpoint

**Updated:** 2026-10-02 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Durable tunnel execution ownership and ambiguous-start cleanup are now tested; provider credentials, runnable production entry and installed acceptance remain incomplete.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Verified code/test checkpoint:** `4bd20ca99960e6769a0c2963c0ac89e7da59fdb2`.  
**RED checkpoint:** `7241caff04ae75dc33046604c48ad0efceec3a25`.

## Current increment — durable tunnel execution ownership

This increment adds `withExclusiveTunnelCustody` and integrates it as an optional `ExecutionLeaseStore` gate on the existing native tunnel custody adapter.

- the `tunnel.execution.json` slot is acquired before native custody spawn;
- a second cooperating supervisor cannot spawn while the slot is HELD;
- successful stop does not release the slot until the actual child exit resolves;
- spontaneous confirmed exit releases the lease;
- copied/foreign handles, uncertain CAS, missing records and failed stops fail closed;
- no TTL, PID-age, port ownership or elapsed-time reclaim is introduced;
- an already-cancelled start writes no reservation;
- the native tunnel rejection path now waits for confirmed child exit when an OS child exists and cleanup is uncertain, so an outer lease cannot mistake a live orphan for a definite no-child failure.

The wrapper contains no provider credential, compatibility policy, health interpretation or public CLI surface. `TunnelCustodyOptions.execution` is optional for controlled fixtures, but production composition must later supply the same reviewed runtime execution store already used for Core.

### Fresh exact-head verification

Exact head `4bd20ca99960e6769a0c2963c0ac89e7da59fdb2`:

- focused workflow `36919938564`: completed/success on Ubuntu and native Apple Silicon Mac;
- root CI `36919938531`: completed/success;
- native Mac job `110563172982`: **64 lifecycle files / 845 tests passed, zero failures/skips**;
- same Mac root suite: **72 files / 893 tests passed, zero failures/skips**;
- lint, typecheck, test, build, diff and production-output checks passed;
- plist structure: 2 roles accepted / 12 altered cases rejected; native `plutil` accepted both generated plists.

RED evidence at `7241caf`: **14 new failures, 809 prior tests passed, 22 Linux-native skips**. Thirteen failures came from the deliberate `NOT_IMPLEMENTED` tunnel-lease scaffold and one reproduced the existing ambiguous cleanup race (`rejected` vs required `pending`). The implementation was then added without weakening those expectations. A later test-only lint correction replaced invalid `deferred<void>()` generic uses with `deferred<undefined>()`.

No real OpenAI tunnel credential/session, launchd install, administrator action, account mutation, Keychain/TCC/FileVault/security change, browser/store operation or merge was performed.

---

# MAC-02 Service Lifecycle — Reviewed Bootstrap and Tunnel Custody Checkpoint

**Updated:** 2026-09-30 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Reviewed-metadata admission, role-aware native sealing, fixed tunnel invocation and tunnel child custody are tested components; credential/provider wiring and installed acceptance remain incomplete.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Parallel ownership:** #139 v2; ChatGPT A #143; installer repairs #146–149; packaging #141; public CLI #142.  
**Verified code/test checkpoint:** `56acae2035b543fa7fe5007573ee2ae9f0ae8b71`.  
**Continuation baseline:** `c2275d4ff9e20336e5e507a61edf1703d0015446`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.


## Current increment — reviewed bootstrap and tunnel custody

This increment adds three narrow runtime pieces without taking over installer, packager or public-CLI lanes:

1. `reviewed-bootstrap.ts` requires an independently supplied expected SHA-256 before it reads candidate review bytes, copies those bytes, decodes the existing canonical RuntimeReview envelope, revalidates the bound runtime configuration, and only then prepares the existing service session. Preparation uses no credentials and launches no child.
2. `owned-process.ts` now has additive `sealMacOwnedProcess` support for both core and tunnel roles while the existing core-only API remains compatible. The connected-peer verifier remains core-specific.
3. `adapters/native-tunnel.ts` derives only the fixed OpenAI `tunnel-client run --config <fixed path>` command with a nonsecret environment, then provides a custody-only adapter that accepts a reviewed authority grant, seals the exact tunnel child, discards child output, permits one launch attempt, and stops only the exact ManagedChild it returned after rechecking native ownership. It does not read a control-plane key, authenticate a tunnel, inspect provider protocol, or claim tunnel readiness.

The previously safety-blocked credential-file/private-ACL source was not retried or bypassed. Production credential/provider integration therefore remains an explicit missing gate. No fake `supervisor-cli.js` or deployable tunnel entry was created.

### Fresh exact-head verification

Exact code/test head `56acae2035b543fa7fe5007573ee2ae9f0ae8b71`:
- focused workflow `36700329553`: completed/success on Ubuntu and native Apple Silicon Mac.
- native Mac job `109837995559`: **62 lifecycle files / 831 tests passed, zero failures/skips**; root **70 files / 879 tests passed, zero failures/skips**.
- root lint, typecheck, test, build and diff checks passed; production-output exclusions passed.
- plist verifier accepted 2 roles and rejected 12 altered cases; native `plutil` passed both generated plists.
- root workflow `36700329445`: completed/success; this is still CI evidence, not an actual merge or installed-daemon acceptance.

RED evidence was kept separate:
- reviewed-bootstrap scaffold failed only its new positive paths before implementation.
- role-aware native seal failed because the new function was absent.
- tunnel launch-plan scaffold produced explicit `NOT_IMPLEMENTED` failures.
- tunnel custody scaffold produced six explicit `NOT_IMPLEMENTED` failures while the prior suite remained green.

Current tunnel custody tests execute real temporary Node child processes, including one that ignores SIGTERM and requires bounded SIGKILL. The native ownership verdict itself is a controlled proof port in these tests; this is not evidence that a real OpenAI tunnel-client session was authenticated or connected.


## 1. Delivered scope and explicit interruption

This increment adds `runtime-review.ts` and 36 tests in `runtime-review.test.ts`. The existing `adapters/runtime-authority.ts` now reuses the same validator instead of its private duplicate (+2/-12 lines). Existing public types, runtime interfaces and native behavior remain intact.

The initially proposed credential-file/private-ACL batch was rejected by the tool safety check. No tree or commit resulted from that request. That operation was stopped and was not retried through another tool, encoding or path. The delivered replacement is a different, metadata-only operation: validating already supplied configuration and reviewed binary hashes. It does not read credentials or files, execute a helper, modify ACLs, establish native trust, or launch a service. Credential-file/private-ACL work remains PAUSED, not implemented.

**The generated plists remain NOT DEPLOYABLE.** `supervisor-cli.js` is still absent. This component does not complete the native bootstrap or connect real authentication. Independent whole-branch review remains deferred to integration.

Previous verified store/session/internal-entry implementation, full history and contracts:
https://github.com/jskjw157/gram-coding-agent/blob/c7b51db11cddff6be0917a9fb6ac927f72ec0ff3/docs/operations/macos-service-lifecycle.md

## 2. RuntimeReview metadata contract

`RuntimeReview` remains exported from `adapters/runtime-authority.ts` with the same fields: `config`, `configDigest`, `nodeDigest`, `fileAclDigest`, `peerOwnerDigest`. The new module imports/re-exports that type only; it does not import native adapters at runtime.

Exports from `runtime-review.ts`:

```ts
copyRuntimeReview(value: unknown): Readonly<RuntimeReview>
encodeRuntimeReview(value: unknown): Buffer
decodeRuntimeReview(bytes: Buffer, expectedDigest: string): Readonly<RuntimeReview> | null
```

`copyRuntimeReview` accepts only exact plain data records, refuses accessors and unexpected fields without invoking them, normalizes configuration with the existing parser, and checks its normalized digest. All binary pins are exactly 64 lowercase hex characters. The output and nested configuration are detached and frozen. Invalid copy/encode requests throw only `INVALID_RUNTIME_REVIEW` without the offending value or cause.

The private envelope is exactly `JSON.stringify({schemaVersion:1,review:normalizedReview}) + '\n'`, capped at 65536 bytes. Decoding copies the buffer, checks its SHA-256 against the supplied expected digest, parses strict UTF-8 and compares with canonical re-encoding. Duplicate fields, BOM, unknown keys, reordered envelopes, extra newlines, invalid text, mismatches and oversized input return null.

**The expected digest must originate independently of the candidate.** Hashing the same untrusted bytes and passing that hash is not approval. This module cannot determine provenance or supply a trust anchor. Its record is not `release.json`, an installation manifest, a public CLI format, a credential store or an authorization grant.

`RuntimeReview.configDigest` is the normalized configuration hash. It is not `Preview.configDigest` (composite preview token), `Preview.previousInstallDigest` (files+registry composite), installation `configSha256` (stored configuration bytes), or the expected digest of this review envelope.

## 3. Verification actually executed

Exact code/test checkpoint `c2275d4ff9e20336e5e507a61edf1703d0015446`:

| Check | Observed result |
|---|---|
| Focused workflow | `36624597738`, completed/success |
| Native Mac job | `109598227754`; macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5; full log read |
| Mac lifecycle | 58 files / 813 passed; zero failures/skips |
| Mac root | 66 files / 861 passed; zero failures/skips |
| Root quality checks | lint, typecheck, test, build and diff check passed on the exact-head Mac run |
| Ubuntu job | `109598227614`; focused workflow completed successfully; precise final Linux test count not claimed from unread logs |
| Compiled plist checks | 2 roles accepted, 12 altered cases refused; native plutil passed both files |
| Existing root CI | `36624597750`, completed/success; synthetic PR merge preview, not an actual merge |

Root861 includes lifecycle813 plus pinned main48; separate MAC-01, Windows M2 and external-lane code are not included. Existing native suites were rerun, but the new 36 cases operate only on synthetic in-memory metadata. No installed service, native bootstrap, real credential, tunnel or reboot acceptance is implied. Tests/test-support remain excluded from production output.

https://github.com/jskjw157/gram-coding-agent/actions/runs/36624597738
https://github.com/jskjw157/gram-coding-agent/actions/runs/36624597750

RED evidence: `61a362c13c2fa1116076e51063ced852734610ac`, workflow36624310062, Ubuntu job109597245318. Full log read: 5 expected new positive-path failures,786 passes,22 native skips. The conservative scaffold already rejected invalid inputs; all36 cases are not claimed to have failed. The implementation then passed the full suites without weakening tests. Local clone failed DNS and local Node24/pnpm were unavailable; the full validation above used the existing read-only Actions exact-head isolated worktrees, not a local full-suite claim.

## 4. Existing installation and execution contracts retained

Fixed installation paths:

| Item | Path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind actual bytes; absent tunnel hash is null. The current static installation reader supports stopped/disabled, unregistered roles, not live-owned acceptance.

Final journal exact fields: `schemaVersion:1`, `stage:'COMMITTED'`, `installationDigest` matching exact manifest bytes. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused by the existing reader, not silently removed/replayed. Metadata limit262144 bytes. Plist bytes must match the fixed renderer, not merely a manifest-supplied hash. Installer repair lanes own the transaction writers; A owns later live acceptance integration.

Existing run records remain `core.execution.json`, `tunnel.execution.json` with fixed transaction locks `core.execution.lock`, `tunnel.execution.lock`. Verified new installation alone may initialize absent records. Existing HELD state, generation and revision must survive upgrade/rollback. Runtime binding never calls initializeNew or resets locks. The Core process hint needs no installer initialization: absence remains unavailable until a validated Core publishes it. Preserve the run directory and last hint.

## 5. Parallel handoff and next exact work

A #143 owns this metadata codec and its use in runtime-authority. External B1–B4/C/D files and schemas were not changed or merged. No conclusion about the latest external repair quality is made by these tests. Their heads and combined regression results still require a separate review.

The next non-credential connection is admission of this exact reviewed metadata from an independently trusted local source before preparing the existing service session. Reuse `copyRuntimeReview`/`decodeRuntimeReview`, `createReviewedServiceSession` and `runSupervisorEntry`; do not invent another lifecycle engine or treat matching candidate hashes as provenance. No disk location, provisioning writer, automatic trust grant, public command or production stub was introduced by this increment.

The paused credential/private-ACL operation must not be retried as a tool-safety workaround. Native trust provisioning, the standalone fixed supervisor entry, provider-verified restricted tunnel, full-size timing, orphan/stopped recovery, installation/logout/reboot acceptance and final integration remain open. No actual administrator, account, credential, Keychain, OS-security, tunnel, browser or store change was performed; no merge, force push, rebase, branch deletion or Windows issue closure.
