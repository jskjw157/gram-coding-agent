# MAC-02 Service Lifecycle — Implementation Checkpoint

**Status:** IN_PROGRESS / PARTIAL. This is not an installed service or a completed MAC-02.
**Branch:** `feat/macos-service-lifecycle`; Draft PR #138.
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.
**Base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Implemented scope

The new `@gram/macos-lifecycle` package currently contains pure configuration
validation and plist generation, and an asynchronous preflight decision layer
that consumes a read-only inspection interface. It does not construct a native
inspector, install a job, start a supervisor, authenticate MCP, read credentials,
or connect a tunnel.

| Plan task | Current implementation |
|---|---|
| Task 1 | Configuration parser, canonical digest, fixed-role plist renderer, example and tests implemented |
| Task 2 | Decision layer and adapter-input isolation implemented; native account/release/path/ACL/port inspection NOT_IMPLEMENTED |
| Task 3 | Persistent circuits, status storage and safe logs NOT_IMPLEMENTED |
| Task 4 | Owned socket/process proof and authenticated health NOT_IMPLEMENTED |
| Task 5 | Core/tunnel supervisors NOT_IMPLEMENTED |
| Task 6 | Administrative installation, rollback and uninstall NOT_IMPLEMENTED |
| Task 7 | Runnable local lifecycle CLI and sealed release packaging NOT_IMPLEMENTED |
| Task 8 | Read-only CI and generated-plist parsing checks added early; full lifecycle/native/independent-review acceptance NOT_COMPLETE |

Do not interpret a green CI check as completion of the absent tasks.

## 2. Configuration and rendering

Only schema version 1, `LAB_ONLY`, the `gram-agent` runtime name, a bounded
release identifier, a lower-case 64-character release digest, and the exact
supported tunnel object are accepted. Unknown keys, arbitrary commands, root
paths, ports, account overrides, accessor properties and malformed values are
rejected with the fixed `INVALID_CONFIG` error.

Tunnel-disabled configuration has only `enabled: false`. The enabled shape
requires a compatibility digest and the reference `test-tunnel-key`; accepting
that shape does not verify the binary, credential or authorization.

The renderer returns XML for the fixed core/tunnel labels, absolute arguments,
non-admin runtime, umask 077, and the reviewed launchd timing values. It does
not write the XML to an installation directory. The referenced
`supervisor-cli.js` does not exist yet. Generated plists are therefore NOT
DEPLOYABLE and must not be installed. The example's zero digest is not a
verified release digest.

## 3. Preflight decision layer

`preview(config, expectedDigest, inspector)` evaluates explicitly supplied
inspection results, using strict affirmative checks instead of optimistic
truthiness. Host, account, release, installation, ports and plist validation
have distinct refusal codes. Inspection exceptions return fixed codes without
the original error text. Unsupported hosts stop before release inspection.

The `Inspector` interface is an internal port, not an authenticated IPC schema
or proof of the machine's actual state. Current tests provide synthetic
observations from `src/test-support/`; those fixtures are excluded from the
production build. There is no CLI that accepts these observations as trust
claims and no native implementation wired to the decision function.

The successful `Preview.configDigest` is a composite review token covering
normalized configuration, the independently supplied release identity, and
the prior-installation digest. It differs from `configDigest(config)`, which
hashes the canonical configuration only. Neither value authorizes installation.
A future apply must repeat native inspection under its exclusive operation lock.

Adapters receive copies of configuration and role lists. This prevents their
input mutation from changing the settings later rendered/hashed or emptying the
list used to reject a conflicting port. It does not make an untrusted adapter
trustworthy; genuine native verification is still required.

## 4. Tests and execution environment

The authoring environment had Node22 without pnpm and could not resolve
GitHub/npm for a direct checkout/install. No local complete repository checkout,
Node24 execution, or user-Mac execution is claimed. Actual repository checks run
in GitHub Actions on Node24 and the repository's pnpm10.34.5, in detached
worktrees of the exact feature head.

The focused workflow now runs on Ubuntu and native Apple Silicon Mac. It runs
package tests, root lint/typecheck/tests/build, and checks that compiled output
excludes test fixtures. A compiled production renderer emits two temporary
fixture plists; Python validates their exact structure and rejects 12 altered
configurations. The native Mac job also runs `plutil -lint`.

Those checks validate serialization and package behavior only. They do not
prove launchd startup, file ownership, account provisioning, boot recovery,
Keychain access, authenticated peer identity, or a functioning remote tunnel.
Read the exact current-head run results on PR #138; workflow configuration
alone is not execution evidence.

### Observed development cycles

| Change | Observed RED | Observed GREEN |
|---|---|---|
| Configuration/plist behavior | `35510630523`, 44 executed assertions failed against nonimplementing scaffolds | `478c32f`: focused `35510736134`, root `35510736158` |
| Preflight decisions | `35511067022`, 38 failed / 76 passed; existing configuration tests passed | `40312c3`: focused `35511307153`, root `35511307145` |
| Adapter input isolation | `35511455906`, 2 failed / 120 passed; mutated configuration and emptied role list reproduced | `d3117af`: focused `35511569571`, root `35511569564` |

An additional 26 delimiter/role/accessor tests at `b905425` passed the existing
implementation immediately (`35510844242` / `35510844290`). They add coverage;
no defect or implementation fix is claimed for those already-rejected inputs.
Six exception tests were strengthened to verify actual adapter invocation and
the precise failure stage, rather than merely a generic false result.

The initial baseline job `106076993299` in run `35510332122` passed the unchanged
main's frozen install, lint, types, tests and build. Initial feature failures
included a test-only multiline invocation lint error and the metadata
normalization described below. Neither existing assertions nor lint rules were
disabled to pass.

## 5. Lockfile and CI ruling

The dependency-free workspace uses the already-locked root development tools.
Unlike the plan's example, it does not add duplicate package devDependencies or
upgrade TypeScript/Vitest. pnpm frozen installation succeeds but can add the
empty metadata entry `packages/macos-lifecycle: {}` to its temporary checkout.
The focused workflow accepts only that exact two-line normalization and rejects
any other lockfile byte change. The repository lockfile remains unchanged.

No write-enabled workflow or automatic lockfile publishing was introduced.
Before sealed release packaging, persist and verify the generated empty importer
through a reviewed file update so a clean frozen-install checkout is restored.
Do not describe the current normalized checkout as unmodified.

## 6. Continuation and remaining gates

Continue Task 2 at `release-inspection.ts` and the trusted-file/native inspection
adapters. Required evidence includes descriptor-bound reads, ancestor ownership,
ACL behavior, internal-link containment, inventory/digest checks, real account
membership, and owned/free port checks. Temporary real-filesystem fixtures must
prove no mutation or credential reads. Synthetic booleans cannot substitute for
those checks or mark Task 2 complete.

Then follow Tasks 3 through 8 in the approved plan. The same native sequential
execution choice remains in effect; no new scope approval is implied for real
administrative installation, production credentials or a live test tunnel.

Independent reviewer: NOT_PERFORMED. Inline source/test review found and fixed
the two adapter-input mutation cases. Keep PR #138 Draft and unmerged.

User-Mac account, launchd install/restart/reboot, native ACL/peer inspection,
Keychain/TCC, real tunnel, browser and HAAR workflow acceptance: NOT_RUN.
No Windows/MAC-01 package, task engine, original CI, backlog issue, main branch
or documentation branch is changed by this implementation checkpoint.
