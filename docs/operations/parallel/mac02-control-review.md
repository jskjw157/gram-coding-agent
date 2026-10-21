# MAC-02 Local Control — B3 Review (#148)

Base: `463ca94` / branch `fix/mac02-local-control` → PR target `feat/mac02-install-transactions`.
Scope: #148 B3 only. Config-first gate, journal gate, narrow reset capability, strict auth, bounded fail shape. No installer/rollback rework, no new design, no new SafeCodes.

## Interfaces

```ts
control(action: 'start'|'stop'|'restart'|'reset-failure'|'uninstall', ports: InstallPorts): Promise<InstallResult>
```

Source: `packages/macos-lifecycle/src/local-control.ts`.
`fail(code)`: exactly `{ ok: false, code }`, no extra keys.

Capability contract (types only, no runtime): `packages/macos-lifecycle/src/installation-transaction/control-contracts.ts`

```ts
interface LocalControlRestorePort extends RestorePort {
  resetStoppedFailure?(): Promise<InstallResult>;
}
interface LocalControlPorts extends InstallPorts {
  restore(): LocalControlRestorePort;
}
```

Test helpers (test-support only, never production): `packages/macos-lifecycle/src/test-support/installer-control/local-control-fixture.ts`, re-exported by `packages/macos-lifecycle/src/test-support/installer-control/index.ts`. Wrappers around the read-only `makeInstallFixture` ports (`packages/macos-lifecycle/src/test-support/installer/fixture.ts`, imported, never edited): `withMalformedConfig`, `withCorruptJournal`, `withMismatchedJournal`, `withResetExecutionSpy`/`resetExecutionCalls`, `withStoppedFailureCapability`, `withoutStoppedFailureCapability`, `withTruthyAuthorize`, `serviceMutationsOf`, `localRestoreOf`.

## Write paths (exclusive) vs read-only

Exclusive writes for this work (path audit, `git status --short`, node_modules excluded):

- `packages/macos-lifecycle/src/local-control.ts` (modified)
- `packages/macos-lifecycle/src/local-control.test.ts` (modified, reset tests only)
- `packages/macos-lifecycle/src/installation-transaction/control-contracts.ts` (new, types only)
- `packages/macos-lifecycle/src/test-support/installer-control/` (new: `index.ts`, `local-control-fixture.ts`)
- `packages/macos-lifecycle/src/review/lanes/control-regressions.test.ts` (new, 8 lane tests a-h)
- `docs/operations/parallel/mac02-control-review.md` (this file, new)

Read-only (honored, never edited): `test-support/installer/fixture.ts`, `installation-transaction/contracts.ts`, `installation-transaction/journal.ts` (`reconcileJournal`), `adapters/install-files.ts` (`validateManifestBytes`), `config.ts` (`parseConfig`).

## RED→GREEN table (lanes a-h)

Lane file: `packages/macos-lifecycle/src/review/lanes/control-regressions.test.ts`. RED = observed on base `463ca94` (failing-first capture); GREEN = asserted now. All GREEN results also assert `Object.keys(res).sort()` equals `['code','ok']`.

| Case | RED (base) | GREEN (fixed) |
|------|-----------|---------------|
| (a) start, malformed `prior.config` | service mutation `['start:core']` before config parse | `{ ok:false, code:'FOREIGN_SERVICE' }`, `serviceMutationsOf` = `[]` |
| (b) restart, malformed `prior.config` | stop/start ran before config validated | `{ ok:false }` (`FOREIGN_SERVICE` path), mutations `[]` (neither stop nor start runs) |
| (c) start, corrupt journal bytes | journal ignored, start proceeded to `OK` | `{ ok:false }` (`PARTIAL_INSTALL` gate), mutations `[]` |
| (d) start, mismatched journal digest | digest mismatch ignored, start proceeded to `OK` | `{ ok:false }` (`PARTIAL_INSTALL` gate), mutations `[]` |
| (e) reset-failure, no `resetStoppedFailure` capability | fell back to broad `resetExecutionRecords()` | `{ ok:false }` (`PARTIAL_INSTALL`), `resetExecutionCalls(spy)` = `0`, no fallback |
| (f) truthy non-`true` `authorizeLocalAdmin` (`'yes'`) | truthy accepted, start proceeded | exactly `{ ok:false, code:'NOT_AUTHORIZED' }`, mutations `[]` |
| (g) uninstall, `removeManifestOwned` returns `false` | pin: already fixed at `463ca94` (R3), never regressed | `{ ok:false }` (`FOREIGN_SERVICE` denial), live core plist preserved (`readLive('core')` not null) |
| (h) fail shape across malformed/no-capability/truthy | pin: every non-success result shape | every non-success result is exactly `{ ok:false, code }`, no extra keys |

## Behavior summary

- Config-first via `parseConfig`: `prior.config !== null` parses (`JSON.parse` + `parseConfig`) before ANY service call. Malformed returns `FOREIGN_SERVICE` with zero mutations (lanes a, b). Source lines 50-56.
- Journal gate via `reconcileJournal`: `ports.journal().read()` then `reconcileJournal(journal, prior.manifest)`; `partial` returns `PARTIAL_INSTALL` with zero service calls. Covers corrupt bytes and digest-mismatched COMMITTED journals (lanes c, d). Local control never repairs journals. Source lines 59-65.
- `LocalControlPorts.resetStoppedFailure` capability, no fallback: reset-failure stops both, re-confirms core stopped, then narrows `ports.restore()` to the optional `resetStoppedFailure`. Absent/non-function returns `PARTIAL_INSTALL`; the broad `resetExecutionRecords()` is never called as fallback (lane e). Failure results are re-wrapped as `{ ok, code }` only. Source lines 163-184.
- Strict `!== true`: `authorizeLocalAdmin` exceptions and any non-`true` value (including truthy `'yes'`) return `NOT_AUTHORIZED` before lock/mutation (lane f). Same strict form applied to `session.acquired`, `stop`/`start` results, `isStopped`, `ownedHealthy`. Source lines 32, 40, 74-75, 97, 111.
- Stop/start ordering: stop is tunnel then core, each result checked, then `isStopped` verified for both. Start is core first + `ownedHealthy('core')`, then tunnel only if parsed prior config has `tunnel.enabled === true` + `ownedHealthy('tunnel')`. Self-owned compensate-stop: any health/start failure after core started best-effort stops core and preserves the original failure (`HEALTH_UNKNOWN` or the tunnel start result). Source lines 68-125.
- Uninstall foreign-safe + no-op: stopBoth verified first; `digest === null` with both plists null is no-op `OK`, with any plist present is `FOREIGN_SERVICE`; `removeManifestOwned` denial/uncertainty (`!== true`) returns `FOREIGN_SERVICE` and preserves files (lane g, R3 pin). Second uninstall is no-op `OK`. State, credentials, run history, releases, logs never purged. Source lines 185-210.
- Lock release (R5 preserved): `session.release()` rejection downgrades success to `PARTIAL_INSTALL`, preserves failures, never retries unknown writes. Source lines 224-231.

## Wiring note for integrator A

Supply a real `resetStoppedFailure` on the restore port, connected to runtime UID plus confirmed-stopped plus `LifecycleStore` stopped reset. `local-control` consumes it via restore-port narrowing (`ports.restore()` cast to `{ resetStoppedFailure?: unknown }`, `typeof` check, then call); when absent it returns `PARTIAL_INSTALL` and never touches `resetExecutionRecords`. Test double: `withStoppedFailureCapability` funnels the narrow capability into the underlying `resetExecutionRecords` so the shared spy observes capability use exactly like a direct reset call; `withoutStoppedFailureCapability` strips it. Fixture `makeInstallFixture({ existingInstall: true })` ships without the capability, so the owned test `reset-failure without capability leaves reset untouched` (`local-control.test.ts`) and lane (e) both prove the no-fallback path.

## Full-suite result vs baseline

Baseline (before this work): 685 passed / 1 failed (`macos-service-probes.native.test.ts`, environment-dependent, expects real macOS fixed-port state).

Now: 694 passed / 1 failed (same env failure, no new failure). Delta +9 = +8 lane tests (`review/lanes/control-regressions.test.ts`) + 1 owned reset test (`local-control.test.ts`: `reset-failure without capability leaves reset untouched`; existing `reset-failure requires stopped core` now installs `withStoppedFailureCapability`).

Command: `pnpm --filter @gram/macos-lifecycle test` from the worktree root.

## Footer: suite tail (verbatim)

```
 RUN  v5.0.0 /Volumes/X9 Pro/source/gram-coding-agent/.worktrees/fix-mac02-local-control/packages/macos-lifecycle

 ❯ |macos-lifecycle| src/macos-service-probes.native.test.ts (3 tests | 1 failed) 64ms
   ❯ actual macOS read-only service probes (3)
     × observes a real fixed-port fixture without connecting to it 13ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |macos-lifecycle| src/macos-service-probes.native.test.ts > actual macOS read-only service probes > observes a real fixed-port fixture without connecting to it
AssertionError: expected 'unknown' not to be 'unknown' // Object.is equality
 ❯ src/macos-service-probes.native.test.ts:16:30
     14|   it('observes a real fixed-port fixture without connecting to it', as…
     15|     const initial = await inspectMacPorts();
     16|     expect(initial.core).not.toBe('unknown');
       |                              ^
     17|     if (initial.core !== 'free') { context.skip(); return; }
     18|     let connections = 0;

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 51 passed (52)
      Tests  1 failed | 694 passed (695)
   Start at  05:50:07
   Duration  3.41s (tests 85%, transform 7%, import 7%, worker 1%)

    Isolate  52 workers spawned · ~133ms startup each (spawn + environment, per file)
             at least ~852ms faster with isolate: false — reuses workers across files instead of one per file

/Volumes/X9 Pro/source/gram-coding-agent/.worktrees/fix-mac02-local-control/packages/macos-lifecycle:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @gram/macos-lifecycle@0.0.0 test: `vitest run`
Exit status 1
```

## Footer: path audit (verbatim)

```
M packages/macos-lifecycle/src/local-control.test.ts
M packages/macos-lifecycle/src/local-control.ts
?? docs/operations/parallel/mac02-control-review.md
?? packages/macos-lifecycle/src/installation-transaction/control-contracts.ts
?? packages/macos-lifecycle/src/review/
?? packages/macos-lifecycle/src/test-support/installer-control/
```

Writes confined to the six allowed paths. No source/test file edited by this doc task; no commit; no push.
