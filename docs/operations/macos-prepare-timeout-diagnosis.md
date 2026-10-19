# Mac prepare-only second-phase timeout diagnosis

This records the 2026-10-19 ordinary-UID 501 investigation. All diagnostic files,
fixtures, controlled temporary files and caches were on X9 Pro. It does not
establish actual UID 550 startup or authorize an OS service change.

## Command and execution path

The failed whole preparation command used Node 24.20.0 with external HOME,
TMPDIR and XDG_CACHE_HOME, executing the recorded
`diagnosis-20261019/profile-prepare-phase.mjs` in the external task directory.
The script invokes the unchanged 6373 sealed `runPreparePhase`, then
`createRuntimeRecordProvisioner.ensure` followed by
`bindReviewedCoreRuntimeAt` on the same synthetic installed layout. The phase
retains its 60-second cap. No ServiceSession runs and credentials are forbidden.
The exact script and five-second JSON progress stream are retained in the handoff.

The binder checks host/account/directories/config, performs a complete sealed
release review, independently pins Node/helpers, rechecks config/directories and
reads the execution record. The release review reads the manifest, inventories,
hashes with two workers, inventories again and rereads the manifest.

## Continuing work, rather than a stopped operation

The unchanged 6373 diagnostic reached hash completion counts 133 at 15s, 731 at 30s,
1,384 at 45s and 2,179 at 60s. It hit the phase cap during the second inventory.
At the return boundary one read was pending; it unwound within about 25ms, leaving
zero tracked file descriptors, filesystem operations and helper children.
No claim is made that an arbitrary never-returning filesystem call can be made
quiescent by a return-time timer.

The partial binder run issued 163,287 lstat, 147,656 fstat and 55,315 open/close calls.
Native ACL helpers accounted for 2,625 child processes. Aggregate native-helper
time was 18.9s and content reads (167MB at that partial boundary) 2.8s; aggregate
parallel-operation times are not additive wall time. Reopening and verifying the
same fixed ancestors for every file was a substantial avoidable component.
All ACL verdicts were positive. No hash mismatch or stalled progress was observed.
The evidence supports a deadline exhausted while making progress; it does not
identify which unrelated workload changed scheduling latency.

## Correction and current-load control

A native `ReleaseFiles.withReadSession` pins only the fixed prefix for one
inspection. Every read/hash/inventory compares all pinned FD/path full stats
before and after use. Relative paths retain owner/mode/ACL/NOFOLLOW checks and
leaf full-stat checks. No arbitrary subdirectory FD cache or cross-review open
handle cache is added. Scope shutdown rejects new IO, aborts, drains already
started reads, then verifies/closes the prefix. Abandoned operations make a
successful callback fail. A decorated port keeps its own read/hash guards.
Two inventories, every hash, two workers and final manifest evidence are kept.
No further production deadline is raised.

A sequential current-load control used the identical old sealed payload and
synthetic layout. These are individual measurements, not a statistically
controlled speedup claim:

| Same completed binder workload | Unchanged6373 | Prefix scope |
| --- | ---: | ---: |
| Whole provision/bind phase, ms | 8,199 | 7,597 |
| All open calls | 56,320 | 41,053 |
| All lstat calls | 177,222 | 161,969 |
| All fstat calls | 159,181 | 143,928 |
| ACL calls, including provision | 2,880 | 2,880 |
| Content bytes read | 289,576,151 | 289,576,151 |
| Completed content reads | 2,183 | 2,183 |
| Peak tracked descriptors | 54 | 47 |

The old code also passed under this later load. Therefore the difference between
the earlier 60-second refusal and the 7.6-second run must not be attributed solely
to this change. Call-count reduction is deterministic; wall time is load-sensitive.
An accidentally launched run before the new build completed was marked invalid
and excluded from this comparison.

## Original installed implementation controls

The original eabbf7a verifier reviewed the actual internal-SSD public release
twice in 12,584ms (6,297+6,286), using only public files as UID 501. It read no private
runtime directory or key and created no runtime authority.
A fresh external synthetic deployment using the original eabbf7a preparation code
and its original combined 60s limit passed source review 7,445ms, provision 1,066ms
and binding 7,616ms (17,497ms including setup). Credential uses and real session
runs were zero. These controls resolve the previously reproduced prepare-only
refusal under this later load; actual service-account/credential/native-health
acceptance still requires the normal scoped administrator operation.

## Validation

Twelve new regression cases failed before implementation and passed afterward.
The complete local suite passed 1,534 tests across 136 files; lint, types and build
also passed. Coverage includes prefix and leaf drift/ACL refusal, partial-prefix
cleanup, escaped ports, cancellation per hash chunk, never-settling callbacks,
unawaited operations, callback throws and concurrent independent scopes.
Independent static review found no blocking source issue. Exact-head hosted CI
and any actual administrator operation must be reported separately.
