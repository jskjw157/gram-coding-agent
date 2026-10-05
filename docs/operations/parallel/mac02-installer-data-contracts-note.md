# MAC-02 B4 data-contracts note (#149)

Lane B4, branch `fix/mac02-install-data-contracts`, base `feat/mac02-install-transactions`.
Scope: R4 uid/gid validation + R7 real-reader digest + honest fixture.
B1 (apply), B3 (control), A (#144), rollback services, packaging, and CLI are untouched.

## Review findings addressed (PR #144, verbatim)

- R4: "`validateManifestBytes` accepts uid0, string uid, negative gid (3 cases)" —
  required "closed runtime/domain validation consistent with unchanged installation reader".
- R7: "fixture previous-install digest differs from the actual reader" —
  required "derive fixture observation/digest from real reader and real service
  state, not a parallel digest algorithm".

## Fixed data contracts

- `runtime.uid`: safe integer, 1..0xfffffffe. `runtime.gid`: safe integer,
  0..0xfffffffe. `runtime.name` is `gram-agent`. Builder and wire validator
  enforce the same range, type, and exact keys.
- `releaseId` on the wire uses the `parseConfig` shape
  (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`); empty, malformed, and oversize ids
  are refused. `buildManifest` cross-checks release id/digest against the
  parsed config bytes and plist bytes against the config render, so a
  caller-mutated object or buffer never widens what builds. Tunnel presence
  must match the config tunnel flag; empty plist buffers are refused.
- `configSha256` binds actual stored bytes; journal `installationDigest` binds
  the manifest SHA; intermediate journal inventory is a duplicate-free
  fixed-name allowlist.
- Closed schema sets are capped at 1024 entries; duplicates, negatives,
  non-integers, and holey arrays are refused. Missing DB is accepted only with
  an explicit empty accepted set.
- Provisioning initializes absent records for verified new installs only;
  existing HELD/unknown durability reconciles (`PARTIAL_INSTALL`), never rewrites.
- `previousInstallDigest` equals the unchanged `inspectInstallation` digest:
  `src/test-support/installer-data/real-reader.ts` drives the real reader over
  fixture live bytes with registry jobs derived from actual stopped state.
  Running snapshots are refused (null), never digested as stopped.

## Honest-fixture statement

- `restorePrior(prior)` performs real byte replacement from the reviewed prior
  (falling back to the pre-operation baseline when called without one) and
  clears staged scratch. No-op restore is gone.
- `snapshotBytes` additionally observes service stopped state and execution
  state, so state drift changes the snapshot.
- Fixture exports and signatures are unchanged. Where the honest fixture
  exposes failures outside B4 scope, they are reported as known sibling
  failures below — expectations and skips were not adjusted to force green.

## Verification

- RED (test-only commit): 8 failing assertions in
  `src/review/lanes/data-regressions.test.ts` plus an unresolvable
  `installer-data/real-reader` import in `real-reader.test.ts`.
- GREEN: new tests pass; package suite, typecheck, and lint were run.
- Pre-existing baseline failures at base `463ca94` (environmental: native
  process/port probes, file-backed stores, 5 MiB rotation) are unrelated to
  this lane and remain reported separately, not absorbed into this diff.
