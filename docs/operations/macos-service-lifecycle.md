# MAC-02 Service Lifecycle — Runtime Review Metadata Checkpoint

**Updated:** 2026-09-30 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Metadata validation is implemented and tested; native bootstrap and installed service acceptance remain incomplete.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft, open and unmerged.  
**Parallel ownership:** #139 v2; ChatGPT A #143; installer repairs #146–149; packaging #141; public CLI #142.  
**Verified code/test checkpoint:** `c2275d4ff9e20336e5e507a61edf1703d0015446`.  
**Continuation baseline:** `c7b51db11cddff6be0917a9fb6ac927f72ec0ff3`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.

## 1. Delivered scope and explicit interruption

This increment adds `runtime-review.ts` and 36 tests in `runtime-review.test.ts`. The existing `adapters/runtime-authority.ts` now reuses the same validator instead of its private duplicate (+2/-12 lines). Existing public types, runtime interfaces and native behavior remain intact.

The initially proposed credential-file/private-ACL batch was rejected by the tool safety check. No tree or commit resulted from that request. That operation was stopped and was not retried through another tool, encoding or path. The delivered replacement is a different, metadata-only operation: validating already supplied configuration and reviewed binary hashes. It does not read credentials or files, execute a helper, modify ACLs, establish native trust, or launch a service. Credential-file/private-ACL work remains PAUSED, not implemented.

**The generated plists remain NOT DEPLOYABLE.** `supervisor-cli.js` is still absent. This component does not complete the native bootstrap or connect real authentication. Independent whole-branch review remains deferred to integration.

Previous verified store/session/internal-entry implementation, full history and contracts:
https://github.com/jskjw157/gram-coding-agent/blob/c7b51db11cddff6be0917a9fb6ac927f72ec0ff3/docs/operations/macos-service-lifecycle.md

## 2. RuntimeReview metadata contract

`RuntimeReview` remains exported from `adapters/runtime-authority.ts` with the same fields: `config`, `configDigest`, `nodeDigest`, `fileAclDigest`, `peerOwnerDigest`. The new module imports/re-exports that type only; it does not import native adapters at runtime.

Exports from `runtime-review.ts`:

```ts
copyRuntimeReview(value: unknown): Readonly<RuntimeReview>
encodeRuntimeReview(value: unknown): Buffer
decodeRuntimeReview(bytes: Buffer, expectedDigest: string): Readonly<RuntimeReview> | null
```

`copyRuntimeReview` accepts only exact plain data records, refuses accessors and unexpected fields without invoking them, normalizes configuration with the existing parser, and checks its normalized digest. All binary pins are exactly 64 lowercase hex characters. The output and nested configuration are detached and frozen. Invalid copy/encode requests throw only `INVALID_RUNTIME_REVIEW` without the offending value or cause.

The private envelope is exactly `JSON.stringify({schemaVersion:1,review:normalizedReview}) + '\n'`, capped at 65536 bytes. Decoding copies the buffer, checks its SHA-256 against the supplied expected digest, parses strict UTF-8 and compares with canonical re-encoding. Duplicate fields, BOM, unknown keys, reordered envelopes, extra newlines, invalid text, mismatches and oversized input return null.

**The expected digest must originate independently of the candidate.** Hashing the same untrusted bytes and passing that hash is not approval. This module cannot determine provenance or supply a trust anchor. Its record is not `release.json`, an installation manifest, a public CLI format, a credential store or an authorization grant.

`RuntimeReview.configDigest` is the normalized configuration hash. It is not `Preview.configDigest` (composite preview token), `Preview.previousInstallDigest` (files+registry composite), installation `configSha256` (stored configuration bytes), or the expected digest of this review envelope.

## 3. Verification actually executed

Exact code/test checkpoint `c2275d4ff9e20336e5e507a61edf1703d0015446`:

| Check | Observed result |
|---|---|
| Focused workflow | `36624597738`, completed/success |
| Native Mac job | `109598227754`; macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5; full log read |
| Mac lifecycle | 58 files / 813 passed; zero failures/skips |
| Mac root | 66 files / 861 passed; zero failures/skips |
| Root quality checks | lint, typecheck, test, build and diff check passed on the exact-head Mac run |
| Ubuntu job | `109598227614`; focused workflow completed successfully; precise final Linux test count not claimed from unread logs |
| Compiled plist checks | 2 roles accepted, 12 altered cases refused; native plutil passed both files |
| Existing root CI | `36624597750`, completed/success; synthetic PR merge preview, not an actual merge |

Root861 includes lifecycle813 plus pinned main48; separate MAC-01, Windows M2 and external-lane code are not included. Existing native suites were rerun, but the new 36 cases operate only on synthetic in-memory metadata. No installed service, native bootstrap, real credential, tunnel or reboot acceptance is implied. Tests/test-support remain excluded from production output.

https://github.com/jskjw157/gram-coding-agent/actions/runs/36624597738
https://github.com/jskjw157/gram-coding-agent/actions/runs/36624597750

RED evidence: `61a362c13c2fa1116076e51063ced852734610ac`, workflow36624310062, Ubuntu job109597245318. Full log read: 5 expected new positive-path failures,786 passes,22 native skips. The conservative scaffold already rejected invalid inputs; all36 cases are not claimed to have failed. The implementation then passed the full suites without weakening tests. Local clone failed DNS and local Node24/pnpm were unavailable; the full validation above used the existing read-only Actions exact-head isolated worktrees, not a local full-suite claim.

## 4. Existing installation and execution contracts retained

Fixed installation paths:

| Item | Path |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; hashes bind actual bytes; absent tunnel hash is null. The current static installation reader supports stopped/disabled, unregistered roles, not live-owned acceptance.

Final journal exact fields: `schemaVersion:1`, `stage:'COMMITTED'`, `installationDigest` matching exact manifest bytes. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused by the existing reader, not silently removed/replayed. Metadata limit262144 bytes. Plist bytes must match the fixed renderer, not merely a manifest-supplied hash. Installer repair lanes own the transaction writers; A owns later live acceptance integration.

Existing run records remain `core.execution.json`, `tunnel.execution.json` with fixed transaction locks `core.execution.lock`, `tunnel.execution.lock`. Verified new installation alone may initialize absent records. Existing HELD state, generation and revision must survive upgrade/rollback. Runtime binding never calls initializeNew or resets locks. The Core process hint needs no installer initialization: absence remains unavailable until a validated Core publishes it. Preserve the run directory and last hint.

## 5. Parallel handoff and next exact work

A #143 owns this metadata codec and its use in runtime-authority. External B1–B4/C/D files and schemas were not changed or merged. No conclusion about the latest external repair quality is made by these tests. Their heads and combined regression results still require a separate review.

The next non-credential connection is admission of this exact reviewed metadata from an independently trusted local source before preparing the existing service session. Reuse `copyRuntimeReview`/`decodeRuntimeReview`, `createReviewedServiceSession` and `runSupervisorEntry`; do not invent another lifecycle engine or treat matching candidate hashes as provenance. No disk location, provisioning writer, automatic trust grant, public command or production stub was introduced by this increment.

The paused credential/private-ACL operation must not be retried as a tool-safety workaround. Native trust provisioning, the standalone fixed supervisor entry, provider-verified restricted tunnel, full-size timing, orphan/stopped recovery, installation/logout/reboot acceptance and final integration remain open. No actual administrator, account, credential, Keychain, OS-security, tunnel, browser or store change was performed; no merge, force push, rebase, branch deletion or Windows issue closure.
