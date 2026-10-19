# Mac sealed-release review: inventory descriptor scope

Status: code review candidate; actual Mac activation remains incomplete.

## Reproduced failure and measured work

The installed `local-eabbf7a` release remains immutable. An authorized read-only
diagnostic under the real `gram-agent` identity passed account and runtime-directory
validation, then exceeded 65 seconds inside installed release review. It did not
reach runtime binding. This localizes that diagnostic failure; it does not prove
which exact operation caused the earlier `HEALTH_UNKNOWN` installation result.

The original inventory recursively reopened the entire ancestry while the parent
walk still held its descriptors. A 12-directory fixture used 91 extra descriptors.
An aborted inventory also continued dispatching directory ACL checks. Both tests
failed before the implementation change.

An instrumented, read-only comparison enumerated the same public root-owned
installed tree (2,545 entries), using the original installed adapter and the new
compiled adapter. A synthetic positive ACL probe was used **only as a timing
control**; it conveys no installation or runtime authority. Every inventory
produced SHA-256 `92c9558a4556a4015a03e2da15866ce1a38bd8a53d9ed451116ffce25f49b165`.

| Operation | Original | Active ancestry scope |
| --- | ---: | ---: |
| Directory opens | 5,867 | 367 |
| Peak held descriptors | 169 | 19 |
| lstat calls | 20,176 | 14,690 |
| fstat calls | 17,601 | 12,475 |
| Directory ACL verdicts | 367 | 367 |
| Descriptors left open | 0 | 0 |

Observed times were 151,376 ms and 14,334 ms. Other authorized work and an
independent test run overlapped part of the comparison, so these wall times are
not a controlled speedup estimate. Reduced calls and identical inventory results
are the primary evidence. Full review still includes every file hash and native
ACL checks; inventory timing alone cannot prove the 60-second review budget fits.

## Implemented boundary

Only descriptors held by one active recursive inventory are reused. Directory
scopes still compare full path and descriptor identity, ownership, mode, link
count, size and timestamps before/after use. Child opens retain NOFOLLOW and ACL
validation. Symlinks are inspected without following them, and unlisted regular
files remain metadata-only until the manifest authorizes hashing. All held
handles close on success, refusal and cancellation.

Cancellation now reaches both inventories, checks at walk boundaries, and stops
subsequent dispatch once observed.
The two hash workers, both complete inventories, all content hashes and the final
manifest read remain required. The inventory optimization itself does not
change deadlines; the later preparation budget correction is described below. No cache retains open descriptors across independent reads.

## Actual Mac state and safe resumption

The last authorized read-only diagnosis found live journal `PUBLISHED`, no previous
installation digest, Core absent/disabled, tunnel absent, no listener on 3847 or
8080, and apply result `HEALTH_UNKNOWN`. The COMMITTED manifest and prebuilt/staged COMMITTED journal were
prepared before health acceptance and are not evidence of completed activation.
The original key was checked by metadata only; its bytes were never read by the
diagnostic. No subsequent code or test action has changed installed files,
services, live journal, key, account or OS permissions.

Do not repeat apply, promote a staged journal, delete/reset execution records,
replace files inside a sealed release, or use generic launchctl enable/bootstrap
as a recovery shortcut. The existing operator rejects a partial transaction;
ordinary apply/control still refuse a partial transaction. The internal recovery
candidate described below must pass its separate review and CI gate before use.

A real-start review must have the following concrete artifacts before another
administrator action:

1. An exact candidate source SHA and sealed release digest, exact-head CI results,
   independent review, and bounded full native review results. Local fake-home
   preparation must cover both source review and binding; ordinary-user review
   does not substitute for the service identity.
2. An implemented and tested native recovery path for this exact fresh PUBLISHED
   transaction. It must bind the original journal/manifest/config/plist hashes,
   refuse drift or an unknown/owned conflicting process, preserve the current key
   in place, and acquire the installation mutation lock for those writes.
   All five staged files and existing runtime records must be accounted for.
3. A fixed, reviewable command sequence naming the old and new release digests,
   fixed Core label, exact file writes and compensation behavior. It must retain
   evidence on failure and commit the journal only after authenticated owned
   Core health is proven. A fake-home fixture must exercise success, timeout,
   interrupted publication and refusal paths.
4. An explicit approval covering those root file/journal operations and Core
   LaunchDaemon start/stop. The intended endpoint remains loopback
   `127.0.0.1:3847`, LAB_ONLY, agent_health only, tunnel disabled. Key rotation,
   account/permission changes, external trust/tunnel registration, main merge
   and deployment require their own scope; none is implied by this code PR.

The internal recovery implementation is now present; final CI acceptance and
the executable administrator procedure remain gates. This document is a review gate and evidence record, not an executable recovery
procedure or a request to reauthenticate now.

## Historical native full-review refusal (earlier machine load)

After the inventory-only comparison, an ordinary-user (UID 501) read-only run
used the real independently provisioned bootstrap ACL helper and the optimized
compiled adapter, retaining the existing 60-second deadline. It refused on
cancellation after 60,062 ms during the initial inventory: 95 ACL calls in total,
zero negative ACL verdicts, zero content hashes and one manifest read. All started
work had unwound before the aggregate result was emitted. No credentials,
authority acquisition or service session was used.

That run did **not** establish full-size native startup readiness.
Repeated fixed-helper ancestry validation and native helper process startup were
measurable follow-up work. Raising the timeout or skipping security checks is not
justified by this result. The service-user diagnostic has not been repeated, and
no new authentication is requested.

## 2026-10-19 resumed verification and recovery candidate

All new checkout files, downloads, caches, fixtures and artifacts are on the
mounted X9 Pro under `source/codex-gram-mac-20261019`; the original internal
checkout and paused evidence were preserved. Current public installed bytes were
rechecked: live journal is still canonical PUBLISHED with previousDigest null,
the Core job is absent and loopback health cannot connect. Native publication
consumed configuration/core/manifest stage files; only the COMMITTED journal
stage remains. Tunnel live/stage files are absent.

The optimized adapter passed a full read-only native ACL review in 4,819 ms:
2,154 hashes, two inventories of 2,545 entries, 2,522 ACL calls and no negative
verdicts. This ran as ordinary UID 501 and grants no runtime authority. A complete
prepare-only run in an owned external fixture passed in 13,712 ms (review 5,727,
record provisioning 884, binding 5,961), with no session run or credential use.
No deadline was raised for those historical measurements. They superseded
the earlier timing refusal under that verification environment; they do not prove the exact cause of the
original installation failure or establish actual UID 550 startup readiness.

The new internal recovery candidate is `resumeFreshPublished` with the fixed
system composition `createSystemFreshPublishedResumePorts`. It preserves the
ordinary apply/control partial-install refusal and accepts only this same-release,
Core-only, tunnel-disabled, fresh PUBLISHED case. It is not a CLI/MCP route and
performs no elevation.

It binds exact canonical config/plist/manifest/journal bytes and the real consumed
staging layout, account identity, sealed content, key metadata, pristine FREE
revision 0/circuit records and absent process/status/event hints. It acquires the
existing installation lock and revalidates the complete transaction digest.
Core owned health and a fresh PID/UID/start-time/executable pin are required before
STARTED. Before stopping, ownership and immutable scope are checked again; after
stopping, the same process must be native FOREIGN with the released matching
lease and matching history generation. A separate supervisor start-attempt pin
supports compensation before a Core health pin exists. UNKNOWN never authorizes
stopping. Compensation explicitly reports unknown outcomes. The same release
review deadline bounds never-settling proof reads; cancellation cannot authorize
a late action. Lock cleanup failures remain `lockUnknown` on every outcome.
After exact native FOREIGN, socket occupancy may drain for at most 90 seconds
using read-only observations. UNKNOWN refuses immediately; the process proof
and immutable snapshot are checked again after idleness. No service command
is retried during this drain.

Only the existing COMMITTED journal stage can be published after these checks.
Write refusal and a write followed by uncertain readback are separate outcomes;
uncertain results omit a claimed journal stage and must not be retried blindly.
The lock excludes cooperating installation writers. No atomic exclusion of
trusted root/admin changes is claimed.

Public pins for the currently observed same-release transaction:

| Pin | SHA-256 |
| --- | --- |
| Sealed release | b56fae25c8cc95f300f61dfb680adb435c59fc8df4d13f29134bd4c62a57a80b |
| Installed manifest | 8ced6f0706af5c04cea92505aa43fcdcecd123828a312287f3791f6ad6086e64 |
| Live PUBLISHED journal | 8a2ce94ad3836f95f8c3d72a7dc21aca886da376c96622e391be9493a582f75d |
| Existing COMMITTED journal stage | f9878de40f0cd94e2a46e892deea6a319cf9e2fdd6cf26ef86f56f388869f4c3 |

Real recovery, new release installation, Core start, authenticated health and MCP
communication are all NOT_RUN in this resumed increment. The candidate still
requires final regression/independent review, an exact sealed source/digest and a
reviewed administrator procedure. Existing authentication is not repeated merely
to gather the same diagnosis. If new administrator authentication is necessary,
only that concrete prepared step will be requested; no password is read, logged
or transmitted by this work.

Recovery first finishes the old transaction as COMMITTED/stopped. Replacement by
a new sealed release is a separate normal apply, followed by an explicit reviewed
start. Its file installation, launchd startup, owned health and authenticated
MCP agent_health results must be reported separately. Existing key bytes and
runtime history are never reset or replaced by recovery; database changes during
normal Core startup remain normal application work, not a recovery reset.


## Candidate validation and CI scope

Before the preparation budget correction, full lint, typecheck, build and
1,511 tests across 134 suites passed locally after the port-drain addition. Never-settling proof reads, uncertain
journal readback, lock cleanup and refusal/compensation paths have regression
coverage. Exact-head CI is recorded in the PR; local timings are evidence for
this environment only.

A separate external synthetic deployment also used the unchanged **installed
old sealed implementation**, including its original review adapter. Preparation
passed in 15,567 ms (review 6,530; provisioning 947; binding 6,980), 5,688 native
ACL calls, no negative verdicts and no session/credential use. Both old and new
code fit the existing budgets under that measurement load. Neither result attributes
the original failure solely to the adapter or predicts behavior under all loads.

Disposable CI keeps the existing apply/start/restart/stop/uninstall acceptance.
A separate disposable Mac VM requires an initially absent scope and a root-owned,
job-specific creation receipt. It refuses nonempty private directories and never
resets private records or a database.
A preparation-only run uses the synthetic runtime identity without a session or
credential use. The pre-Core failure case injects only a waiting sealed Node and
negative health result: real fixed-label launchd control, production start-attempt
composition and native helper must compensate it, retaining FREE0, PUBLISHED,
staging and key metadata. This is native compensation-fixture coverage, not a
claim that the default factory's entire failure path was exercised. A fresh
production factory then must complete owned Core health, exact stopped proof and
COMMITTED publication on the same pristine installation without a reset.
Neither CI setup/cleanup script may be run on a user's installed Mac.

The external volume path contains a space. Test aliases now decode file URLs
with `fileURLToPath`, and release assembly quotes the resolved Node executable
for its three host/version probes. The first external assembly attempt failed
before any build or installation because that executable was split at the space.

The first exact-head Mac run passed the original lifecycle phases, then failed
at the prepare-only child in the appended recovery fixture. Required CI guard
environment was provided to sudo's parent and could be removed by sudo's reset.
The fixture now uses a fixed `sudo ... /usr/bin/env -i ... node` vector and emits
bounded preparation diagnostics. Recovery runs as a separate job so its results
are distinct from normal lifecycle acceptance. This fixture split itself does
not alter production deadlines.

The later normal-start CI returned HEALTH_UNKNOWN without a detailed runtime
snapshot. A synthetic native-proof regression independently reproduced precision
loss in the observer: numeric lstat rounded a device/inode above 2^53 before
conversion to bigint. The observer now requests bigint stat values directly,
preserving exact ownership evidence. This is a proven correctness fix, not a
claim that it explains that CI failure. The start failure branch now collects
the existing bounded read-only snapshots before disposable cleanup.


## Preparation budget correction

A later external prepare-only run using the sealed a75fa99 bundle passed source
review in 27,730 ms and record provisioning in 4,412 ms. Binding consumed another
27,854 ms before the **combined** 60-second preparation timer cancelled it; the
session did not run and credentials were not used. This exposed a budget model
that forced two independent full sealed reviews into one review window.

Installed preparation now has two separately bounded 60-second phases: the
complete installed-source read (configuration/installation metadata through final
release evidence), followed by record provisioning plus runtime binding. The
supervisor's overall preparation cap is 120 seconds. Installed owned-health
observation has one absolute 240-second deadline for preparation, 60-second Core
startup and a final 60-second sealed review. Retries and backoff share that one
deadline. Hash coverage, inventory counts and native short probe limits remain
unchanged. Every earlier caller cancellation wins; each phase stops authorizing
later work and discards late results. Runtime operations use fresh signals rather
than the expired preparation signal. Already-dispatched create-only record writes
may finish after cancellation; there is no rollback or writer-quiescence claim,
and late completion cannot dispatch a binder or session.

The already installed old sealed runtime retains its original 60-second combined
preparation limit. Changing this candidate does not retroactively change that
release or clear the actual Mac recovery gate. Actual UID550 preparation,
recovery and activation remain unexecuted. The hosted CI and external fixture
results must be reported separately from the user's installed state.

Final local validation after the phase correction and cancellation guards:
lint, typecheck and build passed; 1,522 tests across 135 suites passed. The external
volume run used two workers and a 30-second test-case timeout for durable fixture
IO. An earlier default-concurrency run hit only 5-second fixture test timeouts;
no production timer or fake-clock deadline assertion was changed for that run.
Independent static review found and verified the additional record-CAS abort
guards; no blocking findings remain in the reviewed source scope. Exact-head
hosted checks and actual installed-Mac acceptance are separate gates.
