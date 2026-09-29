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
