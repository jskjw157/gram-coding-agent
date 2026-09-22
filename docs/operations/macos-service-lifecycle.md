# MAC-02 Service Lifecycle — Native Service Probe Checkpoint

**Updated:** 2026-09-23 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Not an installed service or completed MAC-02.  
**Branch:** `feat/macos-service-lifecycle`; Draft PR #138.  
**Verified code checkpoint:** `bbeeb4cd3b6d403bea4270fca1b1735374b45b29`.  
**Resume baseline for this increment:** `6611c5562746b1aa1612a3e2eb9d7f8e652a3d19`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Implementation merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Current scope

| Plan task | Status |
|---|---|
| Task 1 | Implemented: strict LAB_ONLY configuration, canonical digest, frozen service labels, fixed XML renderer |
| Task 2 | PARTIAL: file/release/ACL/account inspection plus native launchd registration/override queries, TCP occupancy and trusted path-presence checks now exist |
| Task 2 remaining | Installed-manifest/plist identity, live OWNED-process proof, independently trusted helper bootstrap, fixed-root Inspector composition and complete preview acceptance |
| Tasks 3–7 | NOT_IMPLEMENTED: durable circuits/status/logs, authenticated peer health, supervisors, admin install/rollback/uninstall, runnable CLI and sealed packaging |
| Task 8 | Read-only unit/native/component CI exists; full lifecycle, independent review and user-device acceptance remain incomplete |

There is still no production Inspector factory wiring every native observation to `preview`. No missing check is replaced with a successful boolean. Registration, disabled overrides, path existence and port occupancy are separate observations, not permission to install or restart anything.

## 2. What this continuation actually added

New production modules:

- `packages/macos-lifecycle/src/adapters/macos-service-probes.ts`
- `packages/macos-lifecycle/src/adapters/trusted-presence.ts`

Five accompanying test files add 73 tests to the previous 190-test package: 42 service-output cases, 10 override-spelling cases, 15 real temporary-filesystem presence cases, and 6 actual-Mac service/port/plist cases. The native ACL/account/file/release implementation at baseline `6611c556` already existed and was reused rather than rewritten.

No dependency, original CI, WSL file, shared M2 contract, database schema, credential, account, TCC permission or launchd job was changed. This continuation does not use or copy GPT-Bridge.

## 3. Native service and port observations

Only fixed read-only commands are issued, with a 2-second timeout, 1 MiB output cap, minimal C-locale environment and no shell:

| Purpose | Fixed command |
|---|---|
| Core registration | `/bin/launchctl print system/com.haar.gram-agent.core` |
| Tunnel registration | `/bin/launchctl print system/com.haar.gram-agent.tunnel` |
| Disabled overrides | `/bin/launchctl print-disabled system` |
| Numeric TCP snapshot | `/usr/sbin/netstat -an -p tcp` |
| In-memory plist validation | `/usr/bin/plutil -lint -`, XML supplied on stdin |

No caller-supplied executable, arbitrary launchd label, network endpoint or secret is accepted. Native output is interpreted internally rather than returned as raw command output. The parsers reject failed, oversized, malformed or unexpected observations.

A job is absent only for the specific observed launchctl not-found status/message for the exact fixed label and system domain. Permission errors, empty output and an unknown response are not absence. A matching registration does not establish executable ownership, startup identity, health or authorization.

Disabled-state parsing preserves three outcomes per role: explicitly disabled, explicitly enabled, or no override. It accepts the known boolean spelling and the `enabled`/`disabled` spelling observed on the native CI runner. `disabled`/`true` mean disabled; `enabled`/`false` mean enabled. Unknown words and duplicate entries are rejected. An unset override is not assumed to mean that a service is safely stopped.

TCP inspection reports `free`, `occupied` or `unknown` for fixed ports 3847 and 8080. IPv4/IPv6/wildcard and bound non-listening sockets are treated conservatively. An unrelated remote port or numeric suffix is not confused with a fixed local port. No connection or authentication data is sent to a listener.

**Hard boundary:** occupancy is not OWNED. Do not turn a matching label, PID or open port into permission to send credentials. Task 4 still owns live peer verification. A snapshot is not a reservation; eventual apply/start must revalidate. Diagnostic text is OS-version-sensitive: unrecognized formats fail closed rather than broadening acceptance.

## 4. Descriptor-bound path presence

`probeTrustedPath` distinguishes a regular file, a directory and a genuinely missing path without reading file contents or creating missing parents. Every existing ancestor is opened with no-follow flags and checked for expected owner, mode, link type/count and ACL. Handles remain open while the path is inspected. Path and descriptor metadata are compared before and after checking.

Only ENOENT below an already validated anchor may produce `absent`. A missing anchor, ENOTDIR, permissions/ACL failure, symlink, hardlink, wrong owner or replacement yields the fixed `UNSAFE_PATH` error. Raw exception text is not propagated.

The anchor and ACL callback are internal trust dependencies, not CLI/MCP options. Deployment must use `/`, owner 0, fixed paths and an independently trusted ACL verifier. Tests use temporary runner-owned anchors and a synthetic ACL callback; native ACL behavior is verified separately by the existing helper suite. These checks do not claim atomic exclusion of concurrent trusted-root changes. No atime guarantee is made.

Real-filesystem tests verify that missing parents are not created and existing fixture content and directory membership remain unchanged. They also cover unsafe ancestors, symlinks, hardlinks, wrong ownership, ACL refusal, file-as-parent and replacement during validation.

## 5. Existing components retained

`trusted-files.ts` retains descriptor-bound bounded reads/hashes and metadata inventory. `release-inspection.ts` checks the independently supplied exact-manifest SHA-256, closed schema, required core/Node/lifecycle entries, complete inventory, executable flags, internal link resolution and actual file hashes. No staged binary is executed to discover its identity.

`platform/macos/native/file-acl.c` consumes fd 3, reads native metadata/ACL only, and returns bounded safe/device/inode information. `macos-acl.ts` contains its output/errors and checks descriptor identity. The ACL rule is intentionally conservative: allow-write ACEs are refused, not evaluated as a full effective-access engine. The helper must not establish its own trust using the release under inspection.

`macos-inspection.ts` uses fixed dscl/id/dsmemberutil calls for `gram-agent`, requiring consistent UID/GID and group evidence. Native lookup tests do not provision or prove a correctly configured dedicated account. Manifest tool metadata is not authenticated MCP health, and database compatibility metadata is not a real migration/rollback check.

## 6. Verified code evidence

At exact code commit `bbeeb4cd3b6d403bea4270fca1b1735374b45b29`:

- Focused run `35762388130`: both native Mac and Ubuntu jobs completed successfully.
- Mac job `106863374178`: actual macOS 15.7.9, darwin/arm64, Node24.20.0; full log read.
- Mac package: **16 files / 263 passed, zero failed or skipped**.
- Mac root collection: **24 files / 311 passed, zero failed or skipped**.
- Ubuntu job `106863374459`: all enabled steps succeeded. Apple-only tests are explicitly skipped, not counted as native passes.
- Root lint, typecheck and build succeeded on both focused jobs.
- Actual Mac probes verified clean-runner registration/override queries, a temporary loopback listener with zero accepted connections, and plutil stdin validation. No launchd service was installed or started.
- Existing compiled-plist structural checks passed for both roles and rejected 12 altered structures; native `plutil -lint` passed.
- Existing root workflow `35762388195`: completed/success for this PR head. It uses a synthetic merge preview, not a real merge.

The 311 root tests include the pinned main's 48 tests plus the 263 lifecycle tests. They do not include the unmerged Windows M2 or MAC-01 branches. Documentation-only head verification, if newer, is recorded separately in PR #138.

Evidence:
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35762388130
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35762388195

## 7. RED/GREEN and corrective evidence

| Step | Observed result |
|---|---|
| Probe RED `909e94d3` | Run `35760936219`, Mac job `106858501383`: 17 failures / 218 passes against explicit nonimplementing probes |
| Initial probe implementation `8fc5888c` | Mac run `35761225300`: 1 failure / 234 passes; registry failed, real port/plutil checks passed |
| Format diagnosis `6fcb4cc5` | Mac run `35761384566`: 2 failures / 236 passes; safe diagnostics showed successful command output using enabled/disabled |
| Explicit spelling fix `25df7212` | Behavioral tests passed; a new test formatting lint error remained. Not reported as full success |
| Presence RED and lint correction `4597fc78` | Run `35762041650`, Mac job `106862202520`: all 15 new presence assertions failed; 248 previous assertions passed |
| Presence implementation `bbeeb4cd` | Both final focused jobs and root CI succeeded, as recorded above |

The ten added spelling cases extend coverage; the native failure was observed before the spelling correction. The lint rule and assertions were not disabled. The investigation used only bounded, redacted format metadata from a disposable runner, not raw production service details.

Earlier implementation and verification records remain available at the previous checkpoint:
https://github.com/jskjw157/gram-coding-agent/blob/6611c5562746b1aa1612a3e2eb9d7f8e652a3d19/docs/operations/macos-service-lifecycle.md

In particular, code `0702ec2` had 190 native package / 238 native root tests and corrected internal-link parent traversal. Task 1/preflight/frozen-label history remains in that checkpoint, Git history and PR #138. It is historical evidence, not a replacement for the new runs above.

## 8. Execution and review boundaries

The local authoring environment has Node22/TypeScript but no pnpm, and direct GitHub/npm DNS was unavailable. There is no complete local checkout or claimed local Node24 repository test run. Actual verification uses the existing read-only GitHub Actions exact-head detached worktrees. Local syntax-only transpilation is not represented as repository typecheck.

No workflow permissions, dependency versions, runtime privilege, paid AI API, automatic deployment or merge were introduced. The existing empty-importer normalization rule is unchanged: frozen installation may add only the empty `packages/macos-lifecycle: {}` importer in the temporary checkout. Persist that importer through a reviewed change before sealed packaging; do not call the temporary checkout pristine.

This increment received author source/test review, not an independent reviewer. No independent approval is claimed. Keep PR #138 Draft and unmerged. Even on a supported Mac, these exported library functions are not a runnable lifecycle CLI or deployment tool.

## 9. Exact continuation point

Do not rebuild the config, file/release, native ACL/account, registry/port or path-presence components. Finish Task 2 integration by binding the fixed installed manifest/plist paths to verified installation identity, establishing helper provenance and composing the six native Inspector ports without caller-provided success facts. Complete preview must prove no writes/credential reads, and must refuse foreign/unknown installations.

Task 4 owns established-peer authentication; Task 6 owns the journal/installation manifest and idempotent administrative apply. Resolve their read-contract boundaries before treating an existing running installation as OWNED. Do not invent that proof from this increment's mere registration or TCP occupancy. Then continue Tasks 3–8 of the approved plan. No renewed general plan approval is needed for already-approved development scope.

**NOT_RUN:** user-Mac provisioning; complete preview against its installation; launchd start/stop/reboot; live peer ownership; Keychain/TCC; actual tunnel; browser; HAAR operations. Real administrative changes, credentials and merge retain separate authorization gates. Generated plists still reference the absent `supervisor-cli.js` and remain **NOT DEPLOYABLE**.

At this continuation's initial ref inspection, main was `fdf5dda`, Windows M2 was `c5225dd8`, MAC-01 was `a98c8ff`, and docs were `3c643d4`. Only the MAC-02 feature branch was written. Refresh all refs at handoff; c7fc805 Windows snapshots are historical.

## 10. Primary platform references

Native code uses Apple SDK/system interfaces; platform source review is not execution evidence:
- https://github.com/apple-oss-distributions/network_cmds/blob/main/netstat.tproj/inet.c
- https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
- https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c
- https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c

Actual observed-format and filesystem/native tests, with their limits, are recorded above.
