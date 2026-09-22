# MAC-02 Service Lifecycle — Restart Accounting and Private State Persistence

**Updated:** 2026-09-23 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Not an installed service, runnable supervisor or completed MAC-02.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft and unmerged.  
**Product implementation checkpoint:** `206798f2e10f0bc45a72e8415115de13035c3d1c`.  
**Latest code/test checkpoint:** `3ea9b296b77fad1d683130d971cf29d4b5c62a90`.  
**Resume baseline:** `0e32fd4bccf1fff684b38b11752e4cbcdf8347c7`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Implementation merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Current scope and sequencing ruling

| Task | Actual state |
|---|---|
| Task 1 | Implemented: strict LAB_ONLY configuration, frozen labels and fixed plist rendering |
| Task 2 | PARTIAL: file/release/ACL/account/registry/port inspection, static installation identity and six-port preview composition exist |
| Task 2 outstanding | Independent ACL-verifier provenance/bootstrap, live-instance identity through Task 4, real fixed-root positive acceptance |
| Task 3 | PARTIAL: pure restart accounting, canonical history store and real private-file compare-and-swap persistence implemented |
| Task 3 outstanding | Closed status records/writeStatus, safe appendEvent and three 5 MiB logs per role, bounded raw-child-output drain, process/supervisor integration |
| Tasks 4–7 | Authenticated established-peer health, supervisors, administrative apply/rollback/uninstall, runnable CLI and sealed packaging not implemented |
| Task 8 | Component/native CI exists; full lifecycle, independent review and user-device acceptance remain incomplete |

**Ruling:** retain the Task 2 deployment trust gate and develop independent Task 3 accounting/persistence behind internal ports. Do not derive trust from an unverified helper's own output, its own release manifest, or a caller-supplied success boolean. This does not mark Task 2 complete or authorize bypassing it. The cost of this sequencing is explicit: tested persistence is not operational service readiness.

MAC-03–05 documents were prepared separately on `docs/macos-operations-agent-design` at `31e66aa21b705b1793f11122c1b12d5ebf41715c`. This continuation resumes MAC-02 only and implements none of those later capabilities.

## 2. New modules and preserved work

Three production modules:

- `packages/macos-lifecycle/src/circuit.ts`: pure bounded restart history and transitions.
- `packages/macos-lifecycle/src/lifecycle-store.ts`: canonical encoding, digest-bound snapshots and durable transition ordering.
- `packages/macos-lifecycle/src/adapters/service-files.ts`: trusted private-directory reads and cooperative exclusive file replacement.

Five test files:

- `packages/macos-lifecycle/src/circuit.test.ts`: 42 cases.
- `packages/macos-lifecycle/src/lifecycle-store.test.ts`: 22 cases.
- `packages/macos-lifecycle/src/adapters/service-files.test.ts`: 24 real-filesystem cases.
- `packages/macos-lifecycle/src/adapters/service-files-failure.test.ts`: 2 additional failure cases.
- `packages/macos-lifecycle/src/adapters/service-files.native.test.ts`: 2 actual macOS ACL/persistence cases, explicitly skipped elsewhere.

This adds 92 tests to the previous 313-test lifecycle package. Existing configuration, trusted-files, release validation, native ACL/account/service probes, static installed identity and native-inspector code are reused without modification. No original package, dependency, lockfile, workflow, WSL path or shared M2 contract is changed. No GPT-Bridge integration is introduced.

## 3. Restart history and transition contract

`CircuitHistory` is closed data with exactly these fields:

```ts
interface CircuitHistory {
  schemaVersion: 1;
  blocked: boolean;
  lastSeenMs: number;
  exitsMs: number[];
  lastGeneration: string | null;
  activeAttempt: null | { generation: string; startedAtMs: number };
}
```

This is a new, not-yet-deployed format. `lastGeneration` is mandatory and initially null; no implicit migration of an older deployed format is claimed. The future supervisor must allocate fresh opaque generations locally. These fields are not a channel for user-entered text or credentials.

- `freshHistory(nowMs)` is explicit new-installation construction, never fallback for missing/corrupt recovered state.
- `parseHistory(value)` validates own enumerable data properties, supported schema, finite nonnegative safe-integer times, dense bounded ordered exit arrays, generation syntax and active/last-generation consistency. It rejects accessors, symbols, unknown fields and nonstandard object prototypes. Returned objects/arrays are detached.
- `recordExit(history, nowMs, intentional)` counts only unexpected exits, keeps at most five recent exit timestamps and clears the active marker. The rolling window is `(nowMs - 300000, nowMs]`: an exit exactly 300000 ms old is excluded.
- The fifth unexpected exit in that window opens a sticky circuit. Elapsed time, reload and recovery do not close it.
- `beginAttempt(history, generation, nowMs)` refuses blocked or unresolved active state and immediate generation reuse. Its returned marker must be durably saved before any child spawn.
- `recoverAttempt(history, nowMs)` accounts for an unresolved active marker once, clearing it in the returned transition. Exactly-once accounting across repeated recovery depends on successfully committing that transition; an ambiguous failed write requires reload.
- `resetFailure(history, expectedGeneration, nowMs)` is only a pure reset proposal. It rejects unresolved active attempts and stale generation acknowledgements. It does not spawn a child or grant permission. Task 6 must independently establish a stopped installation and local authorization before calling it.

Reversed time, future timestamps relative to stored observation time, impossible shapes and invalid generation values are `INVALID_HISTORY`. The caller must not replace that error with a fresh history. The parser is validation, not cryptographic authentication against trusted root or same-user modification.

## 4. Store and durable-write boundary

`LifecycleStore` consumes the internal `CircuitFiles` port:

```ts
interface CircuitFiles {
  read(role: 'core' | 'tunnel'): Promise<Buffer | null>;
  compareAndSwap(
    role: 'core' | 'tunnel', expectedDigest: string | null, bytes: Buffer
  ): Promise<void>;
}
```

`encodeHistory` serializes normalized JSON plus a newline. `decodeHistory` accepts only canonical UTF-8 bytes, at most 65536 bytes, and compares the decoded/re-encoded bytes. Duplicate JSON keys, a BOM, unknown fields and noncanonical whitespace are rejected rather than silently normalized during recovery.

`HistorySnapshot` contains role, exact-byte SHA-256 digest and detached history. `write` requires that digest to match the supplied history and role, then consumes a closed `begin`, `exit`, `recover` or `reset` mutation. An exit must acknowledge the current active generation; duplicate or stale reports are rejected. Arbitrary replacement history is not the normal store interface.

`read` returns `MISSING_HISTORY` for absence; it does not write. `initializeNew` performs a create-only compare-and-swap against absence and cannot overwrite corrupt existing bytes. Its use belongs to the future independently authorized new-installation path, not general recovery.

The store awaits durable CAS before returning a successful begin marker. Concurrent writes against the same old digest produce a conflict rather than silently erasing a failure. If a provider reports failure after replacing bytes, the store returns `STATE_IO` and does not retry old state. Reload and reconcile the current record before any next transition.

Fixed internal errors include `INVALID_HISTORY`, `MISSING_HISTORY`, `RESTART_BUDGET`, `ACTIVE_ATTEMPT`, `STATE_CONFLICT`, `STATE_IO`, `UNSAFE_PATH` and `BUSY`. Unknown provider error text is not propagated. These codes are not yet a public MCP/CLI schema; future external mapping must be explicit.

## 5. Real private-file persistence

`createCircuitFilesAt(policy, io)` is an internal capability constructor, not CLI/MCP input. Its directory/UID/ACL dependencies must already be trusted. It provisions no account or directories. A future production wrapper must bind `/`, administrator-owned fixed ancestors, the actual non-admin service UID, the fixed run path and an independently trusted ACL verifier. That wrapper is not shipped in this increment.

Every directory component is opened without following links and held while the operation runs. Administrator-owned ancestors and the service-owned leaf have distinct UID checks. The leaf must be exactly mode 0700; parent unsafe writes, ownership mismatch and ACL refusal block operations. State files must be regular mode-0600 files owned by the designated service UID with exactly one hard link. Bounded descriptor reads compare file/path identity and mutation-sensitive metadata before/after reading.

Only these role filenames are generated: `core.circuit.json`, `tunnel.circuit.json`, and their corresponding `.circuit.lock` writer locks. A genuinely absent target is returned only below a verified existing directory. Symlinks, hardlinks, unexpected directories, oversized files and path replacements are not treated as absence.

CAS uses an exclusive per-role lock, rechecks the current digest, writes a private same-directory temporary file, syncs it, rechecks state/lock/directory identity, renames it atomically, and awaits directory sync. Cleanup removes only paths still referring to its held temporary/lock inode. A replaced foreign lock is preserved; no process is killed.

**Failure semantics:** failure before rename leaves the previous complete record. Directory-sync failure after rename can leave a complete newer record with unconfirmed durability; it is reported as failure, not rolled back or called success. Caller buffers are copied before asynchronous I/O. The test suite injects actual partial temporary writes and sync/rename failures.

**Limits:** locks coordinate cooperating writers. A crash while holding a lock leaves `BUSY`; there is no age/PID-based lock stealing, stale-lock cleanup or journal recovery here. Temporary remnants may need separately verified stopped recovery. Trusted root and same-UID code are outside this isolation guarantee. Repeated path checks are not an OS sandbox or atomic protection against those principals replacing paths/ACLs. OS sync calls and passing tests are not a hardware power-loss guarantee.

## 6. Task 2 and Task 6 contracts retained

`inspectInstallation` continues to accept a genuinely pristine installation or an explicitly disabled, unregistered installation with verified static files. Manifest/account/config/release/plist identities must match; actual plist bytes must equal the fixed renderer, not merely a manifest-provided hash. Orphans, unknown registrations and incomplete journals are refused. Static identity is not live process ownership.

`composeInspector` remains one-shot and ordered across host/account/release/installation/ports/plist checks, with final account/release/installation/port revalidation. `createMacInspector` still fails closed when its independently trusted ACL dependency is missing. No new code in this increment supplies or authenticates that dependency.

The earlier closed installation read contract for the future Task 6 writer is preserved:

| Logical role | Fixed location |
|---|---|
| configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| core | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| tunnel | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

The manifest requires exactly `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, and `desiredEnabled:{core,tunnel}`. The name is `gram-agent`; hashes bind exact bytes; absent tunnel hash is null. The currently supported installed state is disabled for both roles.

If a journal remains, it has exactly `schemaVersion:1`, `stage:'COMMITTED'` and `installationDigest` equal to the exact manifest SHA-256. An absent journal is allowed only with the otherwise valid installation. Intermediate/mismatched journals are refused, not replayed/deleted. Metadata is bounded to 262144 bytes. The future writer must use this contract or introduce an explicitly reviewed versioned change.

The installation manifest/journal, restart history and composite preview digest are different records. None substitutes for Task 4 established-peer identity or grants permission to send credentials to an occupied port.

## 7. Actual verification and scope

Final code/test commit: `3ea9b296b77fad1d683130d971cf29d4b5c62a90`.

| Check | Observed result |
|---|---|
| Focused exact-head workflow | `35782176376`, completed/success |
| Native Mac job | `106930105936`, full log read; macOS 15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5 |
| Native lifecycle package | 23 files / **405 passed**, zero failed or skipped |
| Native root collection | 31 files / **453 passed**, zero failed or skipped |
| Ubuntu job | `106930105762`, all applicable steps successful; Apple-only tests explicitly skipped |
| Root lint/typecheck/build | Successful on both focused jobs |
| Compiled plist structure | Both roles accepted; 12 altered structures rejected |
| Native plist syntax | Both generated files passed `plutil -lint`; no jobs installed |
| Existing root CI | `35782176433`, completed/success; synthetic PR merge preview, not an actual merge |

Evidence:
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35782176376
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35782176433

The 453 root tests are the pinned main's 48 tests plus 405 lifecycle tests. They exclude the unmerged MAC-01 and Windows M2 branches. A subsequent documentation-only head receives separately reported checks.

The filesystem tests operate on real temporary files, including file/rename/directory-sync fault injection, replacement, concurrency and store reloads. Most use a synthetic ACL callback. The two native integration cases compile the existing fd3 helper into an isolated temporary fixture, perform actual file sync/recovery with it, and verify that an actual macOS allow-write ACL rejects reading/replacing a record without changing its bytes.

That native helper build proves component interoperability, not independently authenticated production provenance. The tests do not install launchd jobs, create `gram-agent`, kill/restart the deployed supervisor, reboot the host, connect a real tunnel or access Keychain/store credentials. They do not claim machine-power-loss recovery.

## 8. RED/GREEN and corrective record

| Increment | Observed evidence |
|---|---|
| Circuit RED `1fc85b6` | Run `35780128847`, native job `106923222790`: 42 failed / 313 passed against explicit nonimplementing scaffold |
| Circuit implementation `c8cf6aa` | Focused `35780412140` and root `35780412133` successful; native step results read |
| Store RED `bfc069a` | Run `35780568037`, native job `106924734471`: 22 failed / 355 passed |
| Store implementation `5b69e22` | Native run `35781082797`, job `106926433559`: 377 behavioral tests passed, then two new-test lint errors; not full success |
| File adapter RED `7f38e44` | Run `35781345170`, Ubuntu job `106927307242`: 24 failed / 365 passed / 12 Apple-only skipped |
| File implementation `206798f` | Focused `35781742012`, native job `106928653818`: 401 package / 449 root passed; lint/types/build/native plist checks successful |
| Additional coverage `3ea9b29` | Two native ACL cases plus partial-write/foreign-lock cases; final 405/453 results above, no product-code change |

The two lint findings were an unused test assignment and a non-null assertion. They were corrected without weakening lint rules or assertions. The four final cases are added coverage, not a claimed newly reproduced/fixed production defect. Earlier implementation evidence is preserved at:
https://github.com/jskjw157/gram-coding-agent/blob/0e32fd4bccf1fff684b38b11752e4cbcdf8347c7/docs/operations/macos-service-lifecycle.md

## 9. Review, isolation and continuation

Author self-review checked generation/reset boundaries, stale snapshots, unknown commit outcomes, directory/file identity, fixed role names, exclusive-writer cleanup and missing trust. **Independent review: NOT_PERFORMED.** No security certification or reviewer approval is claimed.

Local authoring has Node22/global TypeScript, no pnpm and unavailable direct GitHub/npm DNS; git access was attempted. No complete local checkout/worktree or local Node24 repository run is claimed. Actual tests use the existing read-only GitHub Actions exact-head detached worktrees. No paid AI API, write-enabled CI, new dependency or alternate tunnel is introduced.

The existing empty-workspace-importer normalization remains unchanged: resolve it through a reviewed generated lockfile update before sealed packaging. Do not disguise temporary normalization as a pristine frozen install.

At the latest pre-documentation ref inspection, main was `fdf5dda`, Windows M2 `c5225dd8`, MAC-01 `a98c8ff`, docs `31e66aa`. Only MAC-02 advanced. No merge, rebase, force push, branch deletion, Windows issue closure, account provisioning or system-security change was performed.

**Next safe code work:** finish Task 3 closed status/event schemas, status persistence, safe bounded log rotation and raw-child-output draining against the written plan; reuse circuit/store/file modules. Define owned stopped recovery for abandoned writer locks before claiming automatic lifecycle recovery. Independently complete Task 2 helper trust and fixed-root acceptance; retain Task 4 live peer and Task 6 local-admin authorization gates. Do not mark either Task 2 or Task 3 complete from this checkpoint.

**NOT_RUN:** user's account provisioning; trusted-helper fixed-root positive preview; production state-directory binding; real launchd start/stop/reboot; live peer ownership; Keychain/TCC; real tunnel; browser and HAAR operations. Actual admin writes, real credentials, deployment and merging retain their separate gates. Generated plists still reference the absent `supervisor-cli.js` and remain **NOT DEPLOYABLE**.
