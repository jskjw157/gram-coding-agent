# MAC-02 rollback-target note (B2 lane #147)

Base: `origin/feat/mac02-install-transactions` (463ca94).
Branch: `fix/mac02-rollback-target`.

## Scope

Standalone rollback-to-reviewed-target path in NEW files only:

- `packages/macos-lifecycle/src/rollback-contracts.ts` — target resolution
  (`isRollbackDigest`, `resolveRollbackTarget`)
- `packages/macos-lifecycle/src/rollback-service.ts` — `rollbackToTarget`
- `packages/macos-lifecycle/src/rollback-service.test.ts` — TDD tests
- `packages/macos-lifecycle/src/test-support/installer-rollback/fixture.ts` —
  rollback-scoped fixture (independent of `installer/fixture.ts`)
- `review/lanes/rollback-regressions.test.ts` — lane regression surface
- this note

`packages/macos-lifecycle/src/install-service.ts` is READ-ONLY on this lane:
`git diff --exit-code -- packages/macos-lifecycle/src/install-service.ts`
must exit 0. Forbidden paths (T1 install-files/closed-schema/journal/
schema-guard/provisioning/journal.test/installer-fixture/installer-data/
data-regressions lane, T2 paths, `packaging/**`) are untouched.

## Invariants

1. Only the reviewed installed identity (`prior.digest`) restores; arbitrary
   well-formed digests are refused with `ROLLBACK_BLOCKED_SCHEMA` and no
   service mutation.
2. Malformed digests are rejected before auth, lock, or any mutating port.
3. Schema is read only after both services are confirmed stopped with DB
   closure; unknown/unreadable/corrupt closure blocks rollback.
4. Both releases stay stopped; no live SQLite/WAL copy, no DB delete, no
   migration probe. DB bytes are asserted identical before/after.
5. Restored bytes must re-resolve to the reviewed target digest, otherwise
   the rollback is refused.

## TDD

- RED: `rollback-service.test.ts` fails on missing modules
  (`Cannot find module './rollback-contracts.js'`).
- GREEN: new contracts + service + fixture make the suite pass; lane
  regressions pass; `pnpm --filter @gram/macos-lifecycle test`,
  `typecheck`, and `lint` are clean (native-probe failures excluded —
  environment-only, pre-existing on the base).
