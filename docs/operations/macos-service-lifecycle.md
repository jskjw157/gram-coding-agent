# MAC-02 Service Lifecycle — Installed Identity and Preview Integration

**Updated:** 2026-09-23 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. This is not an installed service or a completed MAC-02.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft and unmerged.  
**Implementation checkpoint:** `6114ea0724afda63066689fa9ec733d805af8056`.  
**Additional test checkpoint:** `dab581d97b8c4531f1adc4e6bc79d691a483e63e`.  
**Resume baseline:** `73003de0f5d0a0669f62ae7e8a4dd9c260b167ed`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Implementation merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Current scope

| Task | Status |
|---|---|
| Task 1 | Implemented: strict LAB_ONLY config, frozen labels, canonical digest and fixed plist renderer |
| Task 2 | PARTIAL: existing file/release/ACL/account/registry/port checks plus static installed identity and six-port preview composition implemented |
| Task 2 remaining | Independently authenticated ACL-helper bootstrap, running-installation identity via Task 4, real fixed-root native integration acceptance |
| Tasks 3–7 | Not implemented: durable circuits/status/logs, authenticated peer health, supervisors, administrative install/rollback/uninstall, runnable CLI and sealed packaging |
| Task 8 | Read-only component/native CI exists; full service lifecycle, independent review and user-device acceptance remain incomplete |

The new factory has fixed paths and actual native observation adapters. Its missing trusted ACL dependency fails closed. It is not a ready-to-install command, and constructing it is not proof that the machine is ready. No result authorizes installation or business operations.

## 2. This increment

Added four files, without rewriting the existing checks:

- `packages/macos-lifecycle/src/installation-inspection.ts`
- `packages/macos-lifecycle/src/installation-inspection.test.ts`
- `packages/macos-lifecycle/src/adapters/native-inspector.ts`
- `packages/macos-lifecycle/src/native-inspector.test.ts`

There are 38 installation identity cases and 12 composition cases: 50 additional tests over the preceding 263-test package. The implementation consumes actual bounded byte readers, release validation, path-presence checks and the existing decision-layer `preview`; it does not accept a precomputed trusted-release flag from a CLI.

No user account, launchd job, permission, database, credential, dependency, original workflow or Windows contract is changed by this increment. GPT-Bridge is not copied or integrated.

## 3. Static installation identity

`inspectInstallation(account, io)` accepts only a genuinely pristine installation or an explicitly disabled, unregistered installation with verified static files. All managed objects must be regular trusted files or genuinely absent; orphaned configuration, plist, journal or manifest files are refused.

An existing manifest must match the current non-admin account UID/GID, the exact configuration bytes and the configured release. The actual core/tunnel plist bytes must match both their manifest hashes and the output of the fixed renderer for that installed configuration. An attacker cannot make a foreign plist acceptable merely by putting its new hash into the manifest.

The installed release is revalidated through the existing full manifest/inventory/hash verifier. The old release digest is anchored by the root-controlled installed record; the candidate new release digest still comes independently from the caller's reviewed input. No staged program is executed to discover its identity.

Before returning, the implementation checks all path presences, all read bytes and registry state again. The resulting digest covers the complete fixed-file snapshot and registry observation, not just the installation manifest. It detects changed observations; it is not an atomic reservation against concurrent trusted-root actions.

**Conservative limit:** any registered job is refused, regardless of its name or PID. Present roles must have explicit disabled overrides and `desiredEnabled=false`. These checks establish static installation provenance, not live process ownership. Task 4 must provide established-peer evidence before support for running installations is added. Occupied ports are never upgraded to OWNED here.

## 4. Closed installation read contract for Task 6

The plan names installation manifests and journal stages but does not give their concrete JSON fields. This increment defines a closed read contract, not an administrative writer. A later writer must use it or introduce an explicitly reviewed versioned change.

Fixed managed locations:

| Logical role | Fixed location |
|---|---|
| configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| core | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| tunnel | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

The manifest requires exactly `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, and `desiredEnabled:{core,tunnel}`. The name is `gram-agent`; hashes bind exact bytes; absent tunnel hash is null. The currently supported installed state is disabled for both roles.

If a journal remains, it must have exactly `schemaVersion:1`, `stage:'COMMITTED'` and `installationDigest` equal to the exact manifest SHA-256. An absent journal is allowed only with the otherwise valid installation. Pending/intermediate/mismatched journals are refused, not replayed or deleted. Journal digest and composite preview digest are distinct values.

Metadata buffers are copied and bounded to 262,144 bytes even if the underlying reader misbehaves. Unknown fields, accessors in object inputs, invalid UTF-8, identity mismatch, provider exceptions and malformed evidence yield a fixed safe refusal, not raw error text or credential data.

## 5. Six-port preview composition

`composeInspector` uses one instance for one ordered preview: host, account, release, installation, ports, then plist validity. Reuse or out-of-order calls are rejected. Public results are detached from cached configuration/account/installation state.

At the final step it compares the proposed XML to the fixed renderer, runs the supplied plist syntax check, rereads account identity, revalidates the candidate release and static installation, and rechecks that the required ports remain free. Changed configuration/plists/release bytes/account/ports do not receive a successful preview.

The final-stage interface is the existing boolean plist-validity port. Drift discovered there produces a safe refusal through that interface; it is not currently distinguished as a dedicated CONFIG_CHANGED result. No claim of transaction-level exclusion or continuing readiness after return is made.

`createMacInspector` binds the ports to actual macOS account/registry/netstat/plutil adapters and descriptor-bound files rooted at `/` with owner UID 0. Managed paths and labels are immutable and cannot be set through config. No helper executable path, command string, secret, remote endpoint or success boolean is accepted by an external interface.

**Unresolved trust gate:** `trustedAcl` is an internal, already-trusted local code dependency. Without it every ACL check returns false. This factory does not authenticate, install, select or bootstrap that verifier. Neither a callback type nor helper output proves provenance. A real trusted launcher must establish independent helper identity before supplying this dependency. A default factory is therefore not deployable readiness.

## 6. Test evidence and its limits

The installation tests use real temporary files and the actual bounded descriptor readers, but their account, registry, release callback and ACL observations are controlled fixtures. The composed preview tests also execute the actual release verifier and installation validator over real bytes; host/account/registry/ports/plist checks remain test ports. They are integration tests, not a successful preview of `/Library` on a provisioned user's Mac.

Positive composition fixtures compare a hash of the whole temporary tree before and after preview: names, readable file bytes, owner/mode/link/device/inode and mutation-sensitive timestamps. An inert mode-000 canary has its metadata checked without content reads, and non-root runners verify it is unreadable. The preview trace contains no credential/browser/secret reads. atime is deliberately excluded. All fixture writes and cleanup belong to the tests, not the preview.

The existing native tests still compile and invoke the fd3 ACL helper, query actual launchctl/ports and validate plist syntax on the GitHub Mac. No service is installed or started by those tests.

### Verified implementation checkpoint

At `6114ea0724afda63066689fa9ec733d805af8056`:

- Focused workflow `35767531553`: both jobs completed/success.
- Mac job `106880742004`: full log read; macOS 15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5.
- Mac lifecycle: 18 files / **311 passed**, zero failed or skipped.
- Mac root: 26 files / **359 passed**, zero failed or skipped.
- Ubuntu job `106880741742`: all applicable steps successful; Apple-only tests skipped explicitly.
- Root lint, typecheck and build passed on both jobs. Compiled plist structure and native `plutil -lint` passed; 12 altered structures rejected.
- Existing root workflow `35767531681`: completed/success. It runs GitHub's synthetic PR merge preview, not an actual merge.

### Additional coverage checkpoint

The `dab581d97b8c4531f1adc4e6bc79d691a483e63e` commit strengthens full-tree preservation and adds two late release/port drift cases, without changing product code. Its observed results are:

- Focused workflow `35768010489` and existing root workflow `35768010579`: completed/success.
- Native Mac job `106882344895`: full log read; same native runtime family as above, all stages successful.
- Mac lifecycle: 18 files / **313 passed**, zero failed or skipped.
- Mac root: 26 files / **361 passed**, zero failed or skipped.
- Ubuntu job `106882344669`: all applicable stages successful; Apple-only skips remain explicit.
- Both matrices passed root lint, typecheck, tests, build and compiled plist validation. The Mac also passed native plist lint.

Exact-head evidence:
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35768010489
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35768010579

A later documentation-only commit receives separately reported checks; these runs are not represented as a test of a different head.

Counts exclude the separate unmerged MAC-01 and Windows M2 branches. The root baseline contributes 48 tests; Linux skips are not native successes.

## 7. RED/GREEN history

| Change | Observed RED | Observed GREEN |
|---|---|---|
| Static installed identity | `c2442bf`, run `35766591740`, native job `106877822061`: 38 failed / 263 passed against explicit nonimplementing scaffold | `332a22c`: focused `35766939093` and root `35766939005` completed/success |
| Six-port composition | `b7e3e16`, run `35767215546`, native job `106879679667`: 9 failed / 302 passed | `6114ea0`: exact checkpoint results above |

The fixed path-table assertion already passed at the second scaffold; it is not described as a failing behavior. The subsequent preservation and late-drift checks strengthen coverage of implemented behavior, not evidence of a newly discovered/fixed bug. No assertions, lint rules or native checks were disabled.

Earlier configuration, file/release, ACL/account, registry/port and path-presence history remains at:
https://github.com/jskjw157/gram-coding-agent/blob/73003de0f5d0a0669f62ae7e8a4dd9c260b167ed/docs/operations/macos-service-lifecycle.md

## 8. Review, execution and isolation

This increment received author self-review against the Task 2 requirements and Task 4/6 read-contract boundaries. **Independent review: NOT_PERFORMED.** Open trust/native acceptance gates are retained, not waived.

The local authoring environment has Node22/global TypeScript, no pnpm, and unavailable direct GitHub DNS (git access was attempted). No complete local checkout, local worktree or local Node24 repository execution is claimed. Real verification uses the existing read-only GitHub Actions exact-head detached worktrees. Supplemental local syntax transpilation is not represented as a typecheck.

The previous empty-workspace-importer normalization is unchanged. Resolve it through a reviewed generated lockfile update before sealed packaging. No new dependencies, CI permissions, workflow, paid API, privilege or alternate tunnel were introduced.

Refresh refs before the next edit. Initial refs: main `fdf5dda`, Windows M2 `c5225dd8`, MAC-01 `a98c8ff`, docs `3c643d4`. Only the MAC-02 branch is written. No force push, rebase, merge, branch deletion or Windows issue closure is authorized.

## 9. Exact continuation point

Do not rebuild static installation validation or the fixed-root composition. Continue Task 2 at independent ACL-verifier provenance and real fixed-root adapter integration; reconcile the defined read schema with the future Task 6 writer. Preserve conservative refusal of live jobs until Task 4 supplies established-peer proof. A registered label or PID is not a credential destination.

Then continue the approved Tasks 3–8, keeping development evidence separate from actual administrative/credential acceptance. No new general design approval is required for the already-approved scope; real administrator writes, credentials, deployment and merge retain their separate gates.

**NOT_RUN:** user's account provisioning; complete fixed-root preview with authenticated helper; real launchd start/stop/reboot; live peer ownership; Keychain/TCC; real tunnel; browser and HAAR operations. Generated plists still reference the absent `supervisor-cli.js` and remain **NOT DEPLOYABLE**.
