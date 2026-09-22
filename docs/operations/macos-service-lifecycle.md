# MAC-02 Service Lifecycle — Native Inspection Checkpoint

**Updated:** 2026-09-22 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL; not an installed service or completed MAC-02.  
**Branch:** `feat/macos-service-lifecycle`; Draft PR #138.  
**Code checkpoint:** `0702ec2fd6371f2e9c013b3c572fae8a2a8056c0`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Implementation merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. What exists now

Task 1 configuration validation and fixed-role plist generation remain intact. Task 2 now has actual descriptor-bound filesystem reads, sealed-release inventory/hash validation, a native Apple ACL metadata helper and fixed-command local account inspection in addition to its previously implemented preflight decision layer.

| Plan task | Current status |
|---|---|
| Task 1 | Implemented: strict LAB_ONLY configuration, canonical digest, frozen labels and XML renderer |
| Task 2 | PARTIAL: real file/release/ACL/account components implemented; native installed-job/port ownership and complete trusted preview composition remain absent |
| Tasks 3–7 | NOT_IMPLEMENTED: durable circuits/status/logs, authenticated peer health, supervisors, admin installation/rollback/uninstall, runnable CLI and sealed packaging |
| Task 8 | Read-only package, actual temporary-filesystem and native ACL/plist checks; full lifecycle/independent/user-device acceptance incomplete |

No native Inspector factory currently wires all six inspection ports to `preview`. The library never substitutes successful booleans for the missing installation/port checks. An accepted test configuration or a green unit suite is not deployment authorization.

## 2. Descriptor-bound file checks

`adapters/trusted-files.ts` opens directories and regular files with no-follow flags, keeps directory handles during inspection, checks owner/mode/link count and compares path/descriptor device, inode, timestamps and size before and after use. It rejects writable group/world permissions, set-ID modes, hardlinked files, leaf/ancestor symlinks, missing ACL evidence, unexpected replacement/truncation and out-of-scope relative paths.

Reads/hashes have explicit byte bounds. Inventory enumerates links as metadata without following their targets and does not open unlisted file data. Tests use real temporary trees including spaces, mode changes, hardlinks, symlinks and file replacement; no store credential is involved. Reads can update filesystem access times; no promise of unchanged atime is made.

The internal anchor/prefix parameters are not operator-supplied CLI/MCP options. Tests anchor at runner-owned temporary directories. A future deployment must anchor at `/`, require root ownership through every fixed-path ancestor and independently trust the ACL helper. Temporary fixture success does not prove `/Library` deployment trust. Concurrent malicious administrator/root mutation is outside the threat model; these checks do not claim to sandbox trusted root.

## 3. Sealed release validation

`release-inspection.ts` first matches the operator-reviewed SHA-256 against the exact manifest bytes, then validates the closed manifest schema, required core/lifecycle/Node/lockfile entries, tool metadata `['agent_health']`, file inventory, executable modes, link targets and actual file hashes. Changed manifests, altered bytes, duplicate/escaping paths, unlisted files, wrong lock identity and invalid compatibility ranges fail closed.

Links are resolved against the verified inventory component by component, before processing `..`, with bounded work/expansions. No real link target is opened. Root-alias escapes, file-as-directory traversal and loops are rejected; a correctly contained internal pnpm-style link remains supported.

A manifest hash is not self-authentication. The expected digest is supplied independently. Manifest tool names do not prove the running MCP tool surface; that remains Task 4. `schemaCompatibility` metadata does not establish compatibility of an actual database; Task 6 must examine its recorded migrations. Fixture Node/supervisor paths contain inert text and are never executed by release inspection.

## 4. Actual Apple ACL helper

`platform/macos/native/file-acl.c` accepts only an already-open descriptor on fd 3. It uses native metadata/ACL calls, returns only a schema version, safe boolean and device/inode identity, and never receives a pathname, reads file data, seeks the descriptor, changes permissions or opens a network connection.

`adapters/macos-acl.ts` passes that descriptor to the trusted helper with a minimal environment and no shell. It bounds output to 4 KiB and runtime to 2 seconds, requires exact metadata identity, and suppresses raw output/errors. Unknown/native-error results are false. ACL policy is deliberately conservative: every allow-write ACE is rejected irrespective of principal or ordering; restrictive deny entries are left intact. This is not a complete effective-access evaluator.

**Trust gate:** the helper executable must be independently provisioned and authenticated, not chosen from the release it is validating. The current helper-path parameter is an internal port, not a public command. A trusted deployment/helper-loading composition is not implemented. Do not point it at an arbitrary executable and interpret its answer as authority.

Native tests compile the helper without administrator privileges in a runner temporary directory. Only test files receive temporary ACL changes, which are removed afterward. No launchd service, account, TCC permission or real keychain is changed.

## 5. Local account inspection

`adapters/macos-inspection.ts` reads the actual process platform/architecture/Node version. For account lookup it calls only fixed `dscl`, `id` and `dsmemberutil` argument vectors for `gram-agent`, with bounded output/time and a minimal C-locale environment. It requires a matching local directory record, UID/GID, primary-group membership and an interpretable administrator-membership result. Missing, inconsistent or unparseable data yields null, not an assumed safe account.

Parser tests cover synthetic positive/negative OS outputs. Native CI also invokes the actual lookup without creating the account; that smoke assertion does not prove a properly provisioned `gram-agent` positive path. The user's dedicated-account acceptance remains NOT_RUN.

## 6. Verification evidence

Code checkpoint `0702ec2` passed focused run `35733022837` and the existing PR-root workflow `35733022842`.

| Observed verification | Result |
|---|---|
| Exact-head native Apple Silicon Mac job `106763107674` | SUCCESS; actual darwin/arm64, macOS 15.7.9, Node24.20.0 |
| Mac focused lifecycle tests | 11 files / 190 tests passed, zero failed or skipped |
| Mac root tests | 19 files / 238 tests passed, zero failed or skipped |
| Exact-head Ubuntu job `106763107212` | SUCCESS; Apple-only ACL tests explicitly skipped |
| Root lint, typecheck, build on both focused jobs | SUCCESS |
| Native compiled fd3 helper | All six actual ACL/descriptor cases passed in focused and root collection |
| Compiled plist structure and native `plutil -lint` | Both fixture roles valid; 12 invalid structures rejected |

Both focused job step lists and the full native Mac log were read. The existing root workflow uses GitHub's synthetic merge preview, not an actual merge. Documentation-only head checks following this code checkpoint are recorded separately in PR #138.

The original baseline has 48 root-collected tests. MAC-01 and Windows M2 are still separate branches and are not included in these counts. Linux explicitly skips Apple-only ACL tests; skipped tests are never counted as native passes.

| Development step | Observed result |
|---|---|
| Real-file/release RED `7cdd8c1` | Run `35730787883`: 41 new assertions failed, 124 existing passed |
| First file/release implementation `4f9ad20` | Behavior 165 passed, lint failed; not reported as full success |
| Native account/ACL RED `84ea938` | Mac run `35731360000`: 7 failed, 180 passed against nonimplementing probes |
| Lint/native header correction | Linux full checks succeeded at `4149aa6`; Mac required the proper `fcntl.h` declarations; no warnings/assertions were disabled |
| Symlink semantics RED `7bd617c` | Mac run `35732698773`: three path-semantics failures, 187 passed; all six real native ACL cases passed |
| Component-expansion correction `0702ec2` | See exact-code verification above and final PR head checks |

Previous Task 1/preflight evidence remains in Git history and PR #138: configuration RED `35510630523`, input-isolation RED `35511455906`, frozen-label RED `35511976729`, prior green head `8571b27` runs `35512040703` / `35512040708`.

## 7. Execution and review boundaries

Local authoring has Node22 and no pnpm; direct GitHub/npm DNS was unavailable. No complete local checkout or local Node24 repository run is claimed. Authoritative tests run in the existing read-only GitHub Actions exact-head detached worktrees, with Node24/pnpm10.34.5. No new workflow permission, external package, runtime privilege, paid API or automated merge was added in this continuation.

The previous empty-importer lockfile normalization rule is unchanged. Persist and validate the generated `packages/macos-lifecycle: {}` importer before sealed packaging; do not call the temporary installed checkout pristine.

Review in this continuation is author self-review, not an independent reviewer. The symlink parent-traversal issue was reproduced and corrected. Unknown deployment/helper provenance and installed-job/port proof are explicit remaining gates, not waived findings. Keep the PR Draft and unmerged.

## 8. Exact continuation point

Finish Task 2 by implementing native installed-manifest/plist/launchd identity, owned/free port observations and the fixed-root trusted Inspector composition. Prove helper provenance without trusting the bundle under inspection, and verify complete preview no-mutation behavior. Do not redo the implemented config/file/release/ACL/account modules from scratch.

Then continue Tasks 3–8 of the approved plan. No new general plan approval is needed for existing development scope; real administrator installation, actual test-tunnel credentials/access, production accounts and merge remain separate gates.

**NOT_RUN:** user-Mac provisioning, complete native preview against its installation, launchd start/stop/reboot, peer ownership, Keychain/TCC, real tunnel, browser and HAAR operations. Generated plists still reference an absent `supervisor-cli.js`: they are NOT DEPLOYABLE.

The Windows M2 branch advanced externally to `c5225dd8b8f6f014ed6dc036abc63e55945d39b6` before this continuation. It was only read, not edited. Refresh every branch ref at the next handoff; older c7fc805 snapshots are historical.

## 9. Platform reference basis

The helper is original code using Apple SDK interfaces. Apple source was consulted for declarations and API behavior, not copied as an implementation:
- filesec declarations: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
- Darwin ACL entry iteration: https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c
- Native descriptor metadata facilities: https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c

SDK source review is not runtime evidence; the actual native tests above provide the limited execution evidence claimed here.
