# Task-bound verification and immutable publish evidence (#158)

## Intent and scope
Complete the existing Gram M2 verification-to-publish boundary on the cloud/Linux development executor. A task may publish only files actually covered by its passed verification and diff review. This is not #159's external-controller protocol, #151's approval facility, Mac lifecycle work, or Windows/WSL live acceptance.

Baseline: feat/m2-vertical-slice 682a0b5048cc327de18158005df4bbb829885714. Integration must refresh after #156/#157, whose publication is owned separately.

## Contract
Preserve verify -> commit -> push -> exact remote confirmation -> lock release -> PR -> CI. Task identity and recorded workspace are resolved per call. All Git reads use CommandRunner with task attribution. No shared mutable current-task state, credential transfer, policy widening, new dependencies or old migration edits.

A VerificationSnapshot is {version:1,taskId,headSha,entries:[{path,mode,oid}]}. Entries are sorted unique candidate changed/untracked paths; absent files use mode '000000'/null oid, normal files '100644' or '100755' and their Git SHA-1 blob id computed locally from exact bytes. Paths are normalized repository-relative files, never .git, absolute, traversal, option/pathspec syntax, control characters or symlinks. Binary bytes are supported; filters/normalization that change committed bytes fail closed. Snapshot capture uses task-scoped status and HEAD plus guarded local file reads; capture detects stable before/after state, but does not claim OS isolation from a malicious same-user concurrent process.

VerificationRunner optionally accepts the real snapshot provider. It captures before checks, checks plan task/HEAD, records actual DiffReviewPort.changedPaths with the passed diff-review result, compares a second capture after all required checks, and seals snapshot evidence only after success. Crashes, drift, absent required checks, missing/failed evidence, or absent snapshot never create publishable evidence. Legacy diagnostic tests can omit the provider, but production publication requires sealed evidence.

Persist sealed evidence in a reserved typed verificationEvidence field of existing plan_json. Reject caller injection of that reserved field in createPlan. Repository methods alone record passed review paths bound to check ID and evidence reference, then the immutable snapshot. No schema migration is necessary. A bound read selects the latest plan for task+HEAD and returns one plan ID, its checks, its sealed snapshot and its passed review paths. No mixing independent latest reads. Legacy task-only diagnostic reads remain, but production adapters require exact HEAD.

Composition carries that evidence identity into publishing. Production verifies the same plan identity and current snapshot immediately before commit. After commit, before push, it checks the new commit's single parent equals verified HEAD and its complete raw changed-path/mode/blob set equals the approved subset of the snapshot. Hooks, additional paths or changed bytes cannot be pushed. A failed post-commit check preserves the commit/worktree/lock for explicit recovery.

## Components
- persistence verification repository: typed snapshot/evidence records and atomic recording/bound reads
- verification runner/evidence collector: propagate actual diff-review paths and seal successful snapshots
- agent snapshot adapter: policy Git reads, recorded-workspace checks, local byte hashing, post-commit verification
- existing agent adapters/composition/main: task-attributed HEAD, coherent plan evidence, guarded publication
- PublishingService: optional post-commit verification callback, wired mandatorily by production composition

## Acceptance
HEAD A evidence cannot satisfy HEAD B. Same HEAD with changed bytes/modes cannot publish. Missing plan/snapshot/review/evidence, foreign task evidence, invalid paths and zero required checks fail closed. Deletion and rename endpoints work; unrelated candidates are excluded from commit. Concurrent tasks preserve identity. Real adapters replace #157's test-only HEAD/path reads; deterministic evidence producers remain until #159. Full frozen install, lint, typecheck, root tests, E2E, build and independent review must pass. No Windows/WSL live acceptance claim.

Publication sends the exact inspected commit SHA as the push source refspec; it never substitutes mutable HEAD after inspection. Legacy non-publication RemoteService callers may retain their existing default, but PublishingService supplies the immutable SHA explicitly.

## Independent review and validation
Three Important review findings were reproduced and fixed before publication: successful command evidence reused by another plan; verification performed in a sibling cwd while sealing the registered workspace; and already-staged Git rename/deletion sources rejected by explicit staging. Plans now reserve an atomic command-run watermark and consume each command once; seal/readback checks command freshness, ownership and registered cwd. Verification freezes its input context and validates that cwd against the registered workspace before any check. Explicit commit staging omits already-deleted paths from `git add` while retaining both deletion/rename endpoints in `commit --only`.

Cloud/Linux validation after fixes: lint, typecheck, 399 root tests, 8 deterministic E2E tests, build and diff check passed. Verification evidence production and publication guards are real in E2E; external coding and fixture non-command verifiers remain deterministic. The existing repair-cycle production composition still fails closed pending snapshot-aware repair wiring; no repair/live-runtime completion is claimed. #159, #151, and Windows/WSL live acceptance remain separate.
