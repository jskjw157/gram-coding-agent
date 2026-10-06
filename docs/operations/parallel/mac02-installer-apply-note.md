# MAC-02 Installer Apply Note (B1 lane #146)

Base: `463ca94` (`origin/feat/mac02-install-transactions`) / branch
`fix/mac02-apply-transaction`. Scope: `apply` transaction only; legacy
`rollback` export and its describes untouched (B2 owns rollback).

## Defect found (RED)

`apply` re-read `preview.configDigest` / `preview.previousInstallDigest`
after `await` points (revalidation match, prior-digest match). The preview
object is caller-owned and mutable, so a mid-flight mutation changed the
decision inputs after review: a mutated token forced a spurious
`CONFIG_CHANGED` on a valid install (and, symmetrically, post-await
re-reads could not be trusted to equal the reviewed values).

RED log: `/tmp/mac02-apply-RED.log` — 2 failed / 9 passed in
`src/install-service.apply.test.ts` (both snapshot tests fail with
`CONFIG_CHANGED` instead of `OK/COMMITTED`).

## Fix (GREEN)

Snapshot the three preview scalars (`configDigest`,
`previousInstallDigest`, `releaseDigest`) synchronously after validation,
before the first `await`, and use only the snapshots afterwards. `config`
was already safe (`normalized` is a parsed copy). Hunk is APPLY-region only
in `src/install-service.ts`; `git diff --stat` proves no rollback hunk.

GREEN log: `/tmp/mac02-apply-GREEN.log` — 38/38 across
`install-service.apply.test.ts` (11), `install-service.test.ts` (9),
`installation-transaction/review-fixes.test.ts` (17),
`installation-transaction/journal.test.ts` (1).

## Regression coverage added (all in lane-owned paths)

- preview/prior snapshot under deferred auth (the RED→GREEN pair)
- R5: lock-release rejection downgrades COMMITTED success to
  `PARTIAL_INSTALL` with stage + COMMITTED journal evidence
- R8: authorize/lock/revalidate outer exceptions become
  `NOT_AUTHORIZED` / `PARTIAL_INSTALL` (no throws, no secret/cause leak)
- stale preview token: `CONFIG_CHANGED` with zero service/file mutations
- health failure: `HEALTH_UNKNOWN/PUBLISHED`, core re-stopped, journal
  `PUBLISHED`, DB bytes preserved
- tunnel disable: only the manifest-owned stale plist removed, then
  `COMMITTED`; foreign tunnel bytes block with `FOREIGN_SERVICE` and no
  removal
- interruption matrix: `publish:manifest:after` keeps `FILES_STAGED`
  evidence; `STARTED:after` keeps `STARTED` (retry-shaped success blocked);
  DB bytes preserved in both
- concurrent applies: exactly one `COMMITTED`, the other `BUSY`

## Rollback-untouched attestation

`git diff --stat` on `src/install-service.ts` shows a single hunk inside
`apply` (lines ~122-161). The `rollback` export (line ~329+) and the
`install-service rollback` describes are byte-identical to `463ca94`.
Forbidden paths (`adapters/install-files.ts`, closed-schema,
journal/schema-guard/provisioning, `test-support/installer/fixture.ts`,
`rollback-service.ts`, `rollback-contracts.ts`, rollback lanes/fixtures,
`platform/macos/packaging/**`) have no hunks.

## Open items

- R6 full round-trip (`apply` → unchanged `inspectInstallation` digest
  equality with actual service-state fixture) is covered by the existing
  `review-fixes.test.ts` real round-trip; no new R6 test added here.
- Full package suite has pre-existing environment failures (native
  process/probe tests, timing-sensitive event-log/telemetry rotation)
  unrelated to this lane; lane-area suites are green.
