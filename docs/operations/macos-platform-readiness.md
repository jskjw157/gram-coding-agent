# Platform Readiness Diagnostic

## Scope
This package is DIAGNOSTIC_ONLY. It selects a compatible execution target and
explains missing observations. It does not install services, change permissions,
log in, read Keychain, run a browser, or perform a store operation.

## Run
From the repository root after a frozen install and package build:
`node packages/platform/dist/cli.js --json`

## Exit codes
0: supported platform diagnostic collected; capabilities may still be UNKNOWN.
2: unsupported execution target; JSON is still emitted.
64: unsupported CLI arguments; no host probe is run.
70: diagnostic failure; output contains a fixed error code, never the raw exception.

## Result interpretation
`liveProbesCollected: false` is expected in MAC-01. Runtime, isolation, user session,
vault, browser and account readiness are not fabricated. READY from a unit-test
fixture does not grant permission or prove that a live workflow can run.
A browser switch requires independent provider/account evidence. A changed
runtime/session/account context invalidates the earlier observations.

## Target-machine evidence
Record commit SHA, OS version, Node version/architecture, test commands, exit codes
and the redacted diagnostic result when run. Do not record account names, home
paths, environment dumps or credentials.
Until actually observed, use these explicit statuses:
- User's native arm64 Mac package diagnostic: NOT_RUN
- User's dedicated non-admin account validation: NOT_RUN
- User's launchd core/tunnel recovery: NOT_RUN
- User Keychain/broker and TCC checks: NOT_RUN
- Real store/browser workflow: NOT_RUN

A GitHub-hosted Mac job validates this package, not those production checks.

## Implementation and evidence checkpoint — 2026-09-20

Implementation branch: `feat/macos-platform-readiness`; Draft PR #137.
Reviewed plan/spec commit: `8f9a31da2e57e998c0e2055d9fe51dbd59b03556` (PR #136).
Plan: `docs/superpowers/plans/2026-09-20-macos-platform-readiness.md` at that commit.
Base: `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.
Windows PR #135 and the shared M2 contracts are outside this change.

| Cycle | Observed RED | Observed GREEN |
|---|---|---|
| Task 1 detector | `35505155770`: missing `detect.js`, after successful frozen install | `fc87f76`: focused `35505240716`, root `35505240709` |
| Task 2 scoped readiness | `35505308455`: missing `readiness.js`, preceding 10 tests pass | `16953df`: focused `35505606213`, root `35505606206` |
| Task 3 local CLI | `35505658258`: missing `diagnostic.js`, preceding 22 tests pass | `553a1bd`: focused `35505826219`, root `35505826177`; compiled Linux CLI validated |
| Task 4 integration | `35505876120`: missing this runbook; 30 other assertions pass | Read the exact current-head native-Mac/Linux and root checks on PR #137; do not infer acceptance from this table |

Actions records are under `https://github.com/jskjw157/gram-coding-agent/actions/runs/<run-id>`.
Current-head results and the final review checkpoint are recorded on PR #137:
https://github.com/jskjw157/gram-coding-agent/pull/137
These historic green results are not substituted for the final head's checks.

## Execution rulings

The authoring session could not resolve github.com for a direct clone and had
Node22 without pnpm. Product tests instead ran on Node24/pnpm10.34.5 GitHub
runners, in actual isolated detached worktrees. No local full-repository test or
local clone is claimed. The pinned unchanged base passed lint, types, 48 root-
discovered tests and build in run `35505056563` before feature testing.

The allowed focused workflow was introduced early for TDD. An initial lockfile
resolution produced unrelated changes, which the guard rejected before any
publication. The successful preparation reused already locked TypeScript/Vitest
versions, ran pnpm validation and added only the new nine-line importer. A
one-time, expected-head-guarded Contents API update targeted only this feature
branch. Its temporary write permission and publication code were removed at
`fc87f76`. The final workflow is read-only, has no credential-publishing step,
and does not use `pull_request_target` or persistent checkout credentials.

Two test-only plan adaptations preserve the repository's existing ESLint rules:
`Reflect.deleteProperty` replaces a computed delete in missing-probe fixtures;
JSON output checks avoid non-null assertions while still failing on missing
output. No test assertions or existing rules were disabled.

The final focused workflow preserves isolated worktrees and additionally runs
the compiled diagnostic on Linux and Mac, including unsupported-argument checks.
Its Mac assertion requires native darwin/arm64 Node. It does not validate a
non-admin account, launchd, FileVault recovery, user Keychain or a real browser.

## Review and continuation boundary

Readiness is not authorization. The caller must provide trusted, fresh,
context-bound observations; these internal TypeScript types are not an IPC
schema, sandbox or authentication mechanism. No raw secrets or live probes are
collected here. The production import guard is only a regression aid.

Independent reviewer: NOT_PERFORMED in this execution environment. Keep the
implementation PR Draft for review; no merge, Windows issue closure or live
Mac provisioning is authorized by this checkpoint. MAC-02 lifecycle/installer
work requires its own reviewed design/plan and real target-machine evidence.
