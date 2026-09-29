# MAC-02 Installer — Task 6 (install transactions)

Base: `3f5a350` / branch `feat/mac02-install-transactions` → base `feat/macos-service-lifecycle`.
Scope: #140 only. No Task 1 rework, no new design.

## Interfaces

```ts
apply(preview: Preview, config: ServiceConfig, ports: InstallPorts): Promise<InstallResult>
rollback(targetDigest: string, ports: InstallPorts): Promise<InstallResult>
control(action: 'start'|'stop'|'restart'|'reset-failure'|'uninstall', ports: InstallPorts): Promise<InstallResult>
```

`InstallPorts`: `authorizeLocalAdmin/lock/revalidate/readPrior/journal/publish/restore/services/readClosedSchema/trustedAcceptedSets`.
All mutations via narrow ports. No arbitrary paths/commands/secrets.

## Ordering

`apply`: admin → lock → revalidate(token == preview, priorDigest == previous) → PREPARED → stop tunnel+core + verify → STOPPED → stage (config/core[/tunnel]/manifest/journal) → FILES_STAGED → per-file publish → PUBLISHED → start core + owned health (+ tunnel) → STARTED → publish committed journal → COMMITTED.

Duplicate apply: installed identity + desired disabled match + clean-committed journal → `OK/COMMITTED` no-op. Else `PARTIAL_INSTALL`.

`rollback(targetDigest)`: digest check → admin → lock → readPrior → closed-schema exact-set match → stop both verified → journal STOPPED → `OK/STOPPED`. Both releases stay stopped; DB never copied/deleted; no migration probe.

`control`: stop/start/restart/reset-failure/uninstall. StopBoth verified. Uninstall removes only manifest-owned matching plists; manifest/config/journal/state/credentials/history preserved. Second uninstall no-op OK.

## Invariants

- preview token = `sha256({config, releaseDigest, previousInstallDigest})`; revalidate equality required.
- journal reconcile: absent+absent=fresh; COMMITTED matching manifest=clean; else PARTIAL.
- execution absent-only for new installs (`ensureExecutionAbsentOnly`).
- closed-schema exact-set match (`decideRollbackSchema`); absent only with explicit empty accepted set.
- lock released in `finally`.
- `desiredEnabled={core:false,tunnel:false}` lab disabled snapshot.
- `FIXED_FILES` only: config/service.json, config/installation.json, config/install-journal.json, 2 fixed plist paths. 256 KiB limit.

## Adapters

- `launchctl.ts`: exact `/bin/launchctl` vectors, fixed labels. absent vs permission/parse/OS distinguished. stop = disable → bootout → verify absent.
- `install-files.ts`: manifest/journal builders + validators, canonical config bytes, expected plist bytes.
- `closed-schema.ts`: `schemaCompatible/parseClosedVersions/decideRollbackSchema` pure predicates.

## Tests (byte-level, no boolean-only)

- `install-service.test.ts` (9): fresh commit byte-identity + DB preserved + ordering; duplicate no-op snapshot-equal; tamper → CONFIG_CHANGED/FOREIGN_SERVICE; foreign/partial prior blocked; interrupt → PARTIAL_INSTALL with STOPPED journal; auth/lock; rollback unknown → BLOCKED + DB equal; rollback exact-set → STOPPED + both stopped + DB equal.
- `local-control.test.ts` (5): stop OK; foreign start blocked; uninstall plist-only + preserves + DB + second OK; reset-failure; invalid action/auth.
- `adapters/launchctl.test.ts` (4), `install-files.test.ts` (2), `closed-schema.test.ts` (2), `journal.test.ts` (1).

## Baseline note

Pre-existing `service-files` / `telemetry-files` public-file failures reproduce on `umask 0077` only (mode 600); pass on `umask 022`. Unrelated to Task 6; left untouched.

## Review repair (PR #144 comment 2026-09-29, head e3c6589)

- R1: rollback requires targetDigest == installed prior digest, then
  restorePrior + re-verify digest; arbitrary digests blocked before mutation.
- R2: stopBoth + isStopped verified before readClosedSchema; unknown closure blocks.
- R3: uninstall honors removeManifestOwned=false as FOREIGN_SERVICE, preserves files.
- R4: validateManifestBytes enforces uid>=1 / gid>=0 integer domain (<2^32),
  matching the unchanged installation reader; buildManifest bounds aligned.
- R5: withLock/control release rejection downgrades success to PARTIAL_INSTALL,
  never retries unknown writes; failures preserved.
- R6: LAB_ONLY stopped/disabled delivery — health proven via owned evidence,
  then both jobs re-stopped before COMMITTED so output round-trips the
  unchanged stopped-install reader; start/health failures compensate-stop;
  tunnel disable removes the old manifest-owned tunnel plist.
- R7: fixture digest uses the real registry observation object
  ({jobs absent, overrides core:true/tunnel:bool|null}) in reader file order.
- R8: authorizeLocalAdmin/lock exceptions become fixed safe codes, never escape.
- Gaps: all journal/publish interruption points return bounded PARTIAL_INSTALL;
  restart/reset-failure validate prior identity like start/uninstall.
- Regression: installation-transaction/review-fixes.test.ts (17 tests) incl.
  real inspectInstallation round-trip (digest equality) after apply.
