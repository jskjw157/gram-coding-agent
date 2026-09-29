# MAC-02 Service Lifecycle — Reviewed Runtime Binding Checkpoint

**Updated:** 2026-09-29 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Lane A authority/directory composition is tested; not an installed or deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Parallel ownership:** #139 coordination; #143 ChatGPT A; #140 installer B; #141 packaging C; #142 diagnostic/CLI D.  
**Verified code/test checkpoint:** `23b75462ffb7528e1d0f6b202f6146a73267b1a7`.  
**Continuation baseline:** `3f5a3509055144358324bd1c41b436833097ab9a`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.

## 1. Progress and parallel ownership

This increment adds `adapters/runtime-authority.ts`, `adapters/runtime-directories.ts`, their two test files and `test-support/runtime/fixture.ts`. No previously existing product module, shared schema, dependency, lockfile or workflow changed. The only preexisting file updated at handoff is this A-owned runbook.

B/C/D continue from the pinned baseline, on separate branches with PR base `feat/macos-service-lifecycle`. A does not edit their installer, packaging, diagnostic/CLI files or lane notes. Their claims/PRs must be refreshed through #139 before later integration; this checkpoint makes no claim that external work is complete.

Per the user's instruction, independent review is deferred to combined integration rather than repeated between component steps. Targeted TDD and full quality checks remain mandatory. No merge or deployment was requested or performed.

| Area | Actual state |
|---|---|
| Task 1 | Existing strict LAB_ONLY config and fixed renderer retained |
| Tasks 2–4 | Existing file/ACL/account checks, persistence, telemetry, process/peer and authenticated-health components reused |
| Task 5 new | Independently reviewed digest inputs, actual file/owner/ACL checks and a pinned shared run-directory binding compose a CoreAuthority and ExecutionLeaseStore |
| Task 5 remaining | Bootstrap trust-anchor provisioning, fixed-root installed acceptance, orphan/stopped recovery, cross-daemon currentCore, real restricted tunnel composition and runnable entry |
| Task 6 | Installer/control/rollback component delegated to B #140; A owns native integration |
| Task 7 | Packaging delegated to C #141; diagnostic/CLI routing delegated to D #142; A owns final entries/glue |
| Task 8 | Combined native launchd/reboot/user-device acceptance and deferred independent review remain open |
| MAC-03–05 | Separate detailed design/plans at docs ref `31e66aa21b705b1793f11122c1b12d5ebf41715c`; not implemented by this change |

`supervisor-cli.js` still does not exist on this branch. Generated plists are **NOT DEPLOYABLE**. No real account, service, credential, Keychain/TCC/FileVault/SSH, tunnel, browser or store action occurred.

Prior reservation/native Core details are preserved at the immutable baseline:
https://github.com/jskjw157/gram-coding-agent/blob/3f5a3509055144358324bd1c41b436833097ab9a/docs/operations/macos-service-lifecycle.md

## 2. Implemented runtime authority

`bindReviewedCoreRuntime(review, bootstrapAcl, signal)` uses the fixed `/Library/Application Support/HAAR/GramAgent` root, root-owned ancestors, actual macOS host/account probes and the current process identity. It returns `{ authority: CoreAuthority, execution: ExecutionLeaseStore }` or null. It neither launches Core nor reads a credential.

`RuntimeReview` contains `config`, normalized `configDigest`, `nodeDigest`, `fileAclDigest` and `peerOwnerDigest`. This is an internal trusted-bootstrap input, not a newly serialized release/installation schema. It must be independently approved, not populated from the candidate's own manifest. The normalized config digest is **not** `Preview.configDigest`, which remains the existing composite preview token.

The binder copies inputs before asynchronous work. It validates darwin/arm64/Node24, exact gram-agent account/UID/GID, non-admin membership and absence of inherited administrative group IDs. It compares the stored config, reuses the full existing `inspectRelease` inventory/hash/link verification, and separately checks the three executable pins, file modes and Node device/inode identity.

A launch grant requires a matching HELD execution reservation and repeated account/config/release/directory checks. Binding alone does not reserve or initialize a record. A missing/corrupt record returns unavailable; an existing HELD record is retained. Occupancy is still cooperative evidence, not process liveness or authentication.

The native peer proof is wrapped with fixed helper-path/pin/context rechecks and bounded use. Binding only constructs that proof; it does not execute candidate helpers. A candidate manifest rewritten together with helper bytes cannot replace the independently supplied helper pin. No new command, arbitrary path or raw-secret MCP API was added.

**Trust boundary still open:** this module consumes an already trustworthy bootstrap ACL capability and reviewed pins. It does not install/sign that capability, authenticate a human approval, or prove the provenance of a caller-supplied function. Never pass an always-true test ACL or derive both pins and trust from the candidate bundle to enable a production launch. Root/admin and hostile same-UID code are not sandboxed by these checks.

## 3. Private directory identity and shared execution storage

`inspectRuntimeDirectories` checks existing `run`, `state`, `secrets` and `logs` directories. Each leaf must be owned by the runtime UID with mode0700; ancestors must have the supplied trusted owner and no unsafe group/world writes. Opened descriptors, path identity and ACL checks must agree.

It does not enumerate secret contents, create missing directories, change permissions or repair state. The directory witness pins device/inode/owner/group/mode rather than size or modification time, because ordinary record writes change directory contents. Later store reads/writes revalidate the witness before and after using the existing private-file adapter. Replacing the run directory with another otherwise valid directory is refused, rather than granting a fresh empty execution slot.

All bindings to the same approved layout reuse the same fixed execution record family. There is still no TTL, abandoned-lock deletion or automatic reset. An uncertain post-write outcome stays an error and requires reconciliation.

Ruling: keep the existing Core launcher path `${root}/state` unchanged during parallel work. A prior spec sketch mentions `state/lab`; this increment follows the already pinned implementation and does not relocate data or silently change the launch contract. Any later layout change needs coordinated migration/installer/packager treatment.

Ruling: consume independent bootstrap trust instead of treating candidate file-acl as its own verifier. Benefit: no circular self-approval. Cost: installed trust-anchor provisioning and full-size bundle timing remain acceptance gates. Initial binding/grant checks use a10000ms bound; peer operations use2000ms. No timing success for a real full deployment is claimed.

## 4. Verification actually executed

Added **38 tests**:35 authority/filesystem cases and3 native descriptor/ACL cases. The35 cases were observed failing before implementation.

| Checkpoint | Evidence |
|---|---|
| RED `58914ad` | Focused36501462342; native Mac109193037874:35 NOT_IMPLEMENTED failures and646 prior passes |
| Implementation `c3181df` | Native behavioral681 passes; quality gate found an unused test type import |
| Native fixture `9c9a4bf` | Adds3 Mac-only ACL/directory cases and uses the imported type; typecheck exposed missing contextual parameter types through Object.freeze |
| Final `23b7546` | Typed immutable RecordFiles/NativePeerProofPort/CoreAuthority wrappers; no relaxed compiler rules, security checks or assertions |

Exact code/test `23b75462ffb7528e1d0f6b202f6146a73267b1a7`:

- Focused workflow **36502578062**, Mac and Ubuntu completed/success.
- Mac job **109196615734**, full log read: macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5.
- **Mac lifecycle:46 files /684 passed**, zero failed/skipped.
- **Mac root:54 files /732 passed**, zero failed/skipped. This includes lifecycle684 plus pinned main48, not additional732 tests.
- Ubuntu job **109196615271**, applicable steps completed/success. Apple-only cases are explicitly skipped, not counted as native passes.
- Root lint/typecheck/test/build/diff checks passed. Production build excludes tests/test-support.
- Compiled plist validation passed both roles and rejected12 altered structures; native plutil accepted both files.
- Existing root workflow **36502578100** completed/success, using the synthetic PR merge preview, not an actual merge.

https://github.com/jskjw157/gram-coding-agent/actions/runs/36502578062
https://github.com/jskjw157/gram-coding-agent/actions/runs/36502578100

The native tests compile the existing ACL helper separately, outside the candidate fixture, and exercise actual descriptors and temporary directory ACLs. They confirm read-only binding, real shared-record acquire/release and refusal of an ACL write grant despite0700 POSIX mode. The account/host source and candidate executable bytes are controlled fixtures. This is **not** a real gram-agent account, `/Library` deployment, Core launch, combined Core/libproc/health, signed-bootstrap, tunnel or reboot test.

The earlier security-blocked combined Core/libproc/health fixture was not retried and remains NOT_ADDED/NOT_RUN. These directory tests are a different scoped task, not substitute acceptance evidence. Independent review remains deferred/not performed. New bindings add no claim that Task5 or MAC-02 is complete.

Local direct Git access failed DNS, and local Node22 is not the target toolchain. Full verification used unchanged read-only GitHub Actions exact-head isolated worktrees. A later documentation-head run is separate from the counted code/test log. Upstream deprecation notices and the existing empty workspace-importer normalization are not claimed fixed. Separate MAC-01, Windows M2 and external-lane changes are not included in these counts.

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

Existing run records remain `core.execution.json`, `tunnel.execution.json` with fixed transaction locks `core.execution.lock`, `tunnel.execution.lock`. Verified new installation alone may initialize absent records. Existing HELD state, generation and revision must survive upgrade/rollback. Runtime binding never calls initializeNew or resets locks. B receives this provisioning boundary without needing changes to its frozen release/CLI contracts.

## 6. Exact next work

Continue A #143 with trusted bootstrap provisioning and production composition, then cross-daemon owned/current Core observation and the restricted native tunnel port. Reuse the authority/directory witnesses, native Core, reservation, checked-socket health and supervisor already implemented; do not build another engine or modify external lane files.

A must connect the independently provisioned trust inputs and shared run binding to runnable entries. Trusted stopped-owner/orphan recovery and installed acceptance remain prerequisites for unattended recovery, not inferred from a HELD file, label or port. Apply/install control is B; packaging is C; public diagnostic/CLI routing is D. Refresh their claims and PRs through #139; integrate under the existing authority and perform the deferred combined review before merge/deployment.

No real service/account/credential/OS-security/store changes, administrator install, merge, force push, rebase, branch deletion or Windows issue closure occurred. Starting separate refs were main=fdf5dda, Windows M2=f6daebed, MAC-01=a98c8ff, docs=31e66aa. Preserve concurrent changes rather than resetting those refs.
