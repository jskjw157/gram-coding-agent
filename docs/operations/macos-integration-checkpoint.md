# MAC-01 / MAC-02 integration checkpoint

## Source and review scope

This Draft integration combines the independent platform diagnostic from PR #137
with the successful lifecycle follow-up stack ending at PR #203. The merge commit
is `4f0610bd32fa19472db396de5565be35f6183800`, with these exact parents:

- MAC-02: `268601c9e83b8cd1ae33c9330d264ea8c012ef2d` (#203).
- MAC-01: `a98c8ff45497f8524bc2ffa9bda19ad60898faf1` (#137).

Both heads were rechecked on GitHub before integration. Main was
`ba9fc68`; #203 was 317 commits ahead with no missing main commits. #137 was
12 ahead and 10 behind main. #203 contains #138
(`e73e5dd04acea611ba6cf9ae5670fa313af06ade`) and all 18 later fixes. The
integration uses #203, rather than the earlier failing #138 head.

The review base is #203's `fix/143-launchd-absence-wait` branch. This keeps the
incremental diff focused on MAC-01 and this evidence document instead of repeating
the entire lifecycle stack. Both prerequisite Draft PRs remain open; this PR is
not permission to merge the stack or install it.

The merge was conflict-free. Its only lockfile addition is the nine-line platform
workspace importer; existing dependency resolutions are unchanged. Frozen pnpm
installation normalizes an empty lifecycle importer; that generated addition was
checked and restored, without changing resolutions.

## Contract boundary

The packages coexist in the workspace and root test discovery. Neither imports
the other's production code. Platform compatibility does not authorize service
installation or imply work readiness. MAC-01's compiled diagnostic remains
`DIAGNOSTIC_ONLY`, with `liveProbesCollected: false` and unknown capabilities on
a supported host. MAC-02 stays `LAB_ONLY`, with `businessReadiness: UNAVAILABLE`;
even `LOCAL_CORE_HEALTHY` does not establish isolation, service/user credentials,
browser/account readiness or a live business workflow.

No adapter was added to convert lifecycle telemetry into trusted readiness
observations. That future integration requires independently verified, fresh,
context-bound evidence and its own behavior tests.

## Local verification

Testing uses a fresh, separate checkout, a fake home and temporary fixtures on
native macOS 26.2 / arm64, with official Node 24.20.0 (archive SHA-256 verified)
and workspace-local pnpm 10.34.5. The existing host runtimes are unchanged.
Verification completed on the integrated tree plus the IPv6 fix below:

| Command / check | Result |
|---|---|
| `pnpm install --frozen-lockfile --store-dir <isolated-store>` | PASS; Node 24 SQLite native build completed |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | PASS |
| `pnpm test --maxWorkers=2` | PASS: 125 files / 1,418 tests, no skips |
| Focused TCP parser, command and native probe tests | PASS: 3 files / 48 tests |
| Explicit `review/lanes/rollback-regressions.test.ts` collection | PASS: 3 tests |
| `node --test platform/macos/package-release.test.mjs` | PASS: 14 tests |
| Compiled MAC-01 CLI on native Mac and unsupported arguments | PASS: UNKNOWN capabilities, exit 0; invalid argument exit 64 |
| Compiled lifecycle CLI with synthetic healthy evidence | PASS: `LOCAL_CORE_HEALTHY`, business readiness still UNAVAILABLE |
| Generated plist structure and negative cases | PASS: 2 roles / 12 altered cases refused |
| Native `plutil -lint` on generated fixture plists | PASS: both roles |
| Bootstrap/script syntax, backlog JSON, diff checks | PASS |
| Lifecycle production output excludes tests and test-support | PASS |

The root count includes eight generated test files from the existing non-Mac
package build configurations; it is the observed count after the workspace build,
not a claim of 1,418 distinct source test cases. No test was disabled. The local
Homebrew Python XML extension was unusable; the plist verifier passed unchanged
with `/usr/bin/python3`. Host Python installations were not modified.

The initial global pnpm launcher recursed during automatic version management in
the fake home. Only this task's process subtrees were stopped; the pinned local
pnpm then completed the frozen install. Early lint/test attempts before install
completion reported missing executables and are not counted as product failures
or successful validation.

## Native IPv6 defect found and fixed

The first full-suite run after dependency installation passed 1,366 tests and failed
`macos-service-probes.native.test.ts` at the initial fixed-port observation. A
focused repeat reproduced it. The fixed `/usr/sbin/netstat -an -p tcp` command
truncated some unrelated long IPv6 hosts; strict `isIP` parsing correctly refused
the incomplete table as UNKNOWN. No private addresses were logged.

The local `netstat(1)` manual identifies `-l` as printing full IPv6 addresses.
Read-only comparison confirmed `-W` did not solve this display format, while
`-anl` eliminated the malformed hosts. The only production change is adding `l`
to the fixed argument vector. Parser validation, fail-closed behavior, command
timeouts and output limits are unchanged.

`macos-tcp-command.test.ts` was run before the change: 1 expected failure / 2
passes. It simulates the native truncation boundary, requires the complete-address
request to recognize an occupied local port, continues to refuse incomplete
rows, and distinguishes a foreign port from a local binding. The focused native
and parser suite then passed all 48 tests, followed by the complete root suite.

## Review and remaining acceptance

An independent read-only reviewer examined the exact staged merge, package and
architecture boundaries, lockfile and focused workflows. No integration-induced
defect was found. This was a static review, not a full security audit of the 317
preexisting lifecycle commits.
The same reviewer separately examined the IPv6 production fix, new regression
tests and their RED/GREEN logs, and found no blocking defect.

No local system-service installation, launchctl mutation, account/security
change, credential/trust provisioning, tunnel registration or deployment is part
of this checkpoint. Fixture-only modes and ACLs do not establish an installed
service boundary. Dedicated non-admin service operation, reboot/logout recovery,
production trust and credentials, tunnel/provider acceptance, Keychain/TCC and
live browser/store work remain NOT_RUN on the user's Mac and require separately
scoped approval. The existing hosted disposable launchd workflow is separate
evidence and must be checked on this PR's final SHA.
