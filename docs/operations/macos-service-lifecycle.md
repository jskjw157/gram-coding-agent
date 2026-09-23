# MAC-02 Service Lifecycle — Safe Status, Events and Child-Output Handling

**Updated:** 2026-09-23 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL; component code is not an installed or deployable service.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft and unmerged.  
**Verified product/code-test checkpoint:** `b608def267011a7227d98a44c2edc58faa409c07`.  
**Resume baseline:** `ee4a4c67e7b9618beade6f205dffe6f3347a9691`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Implementation merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Current progress, not deployment readiness

| Task | Actual state |
|---|---|
| Task 1 | Configuration, frozen labels and fixed LAB_ONLY plist renderer implemented |
| Task 2 | Native inspection/static identity/preview composition implemented; independent helper provenance, fixed-root acceptance and live peer identity still gated |
| Task 3 | Restart accounting plus canonical history, status/event schema, bounded event files and discard-only byte-pipe handling implemented and component-tested |
| Task 3 integration gates | Trusted production run/log directory binding, current-owner enforcement in the supervisor, abandoned writer-lock recovery and lifecycle integration remain open |
| Tasks 4–7 | Established-peer health, supervisors, administrative apply/rollback/uninstall, CLI and sealed packaging remain unimplemented |
| Task 8 | Component/native CI exists; full installed lifecycle, independent review and user-device acceptance remain incomplete |

The prior sequencing ruling remains: implement independent components without pretending the missing deployment trust has been established. No callback type, candidate-helper hash or helper-produced success value authenticates that helper. Task 2 and integrated Task 3 are not marked complete by this checkpoint.

MAC-03–05 documents remain separate at `31e66aa21b705b1793f11122c1b12d5ebf41715c`. They were not implemented or edited here. There is still no `supervisor-cli.js`; generated plists are **NOT DEPLOYABLE**.

## 2. Files added and existing behavior preserved

Six new production modules, all under `packages/macos-lifecycle/src/`:

| File | Responsibility |
|---|---|
| `telemetry.ts` | Closed safe event/status parsing, canonical status bytes, identity/freshness filtering |
| `child-output.ts` | Exclusive byte-pipe discard, one bounded shutdown drain, listener cleanup |
| `event-log.ts` | Validate bounded canonical segments and choose a one-slot rotation |
| `telemetry-store.ts` | Read/write status and append safe events via awaited whole-group CAS |
| `adapters/private-record-files.ts` | Shared fixed-family private-directory, descriptor, lock and atomic-file mechanics |
| `adapters/telemetry-files.ts` | Bind separate internal run/log directory capabilities to fixed status/event files |

`adapters/service-files.ts` now delegates to the shared engine while preserving its existing `createCircuitFilesAt` API, exported policy/I/O types, circuit filenames, limits and errors. Existing circuit/history/file tests remain unchanged. No alternate history engine was added.

Seven test files add **67 cases**: telemetry 30; child output 8; log planner 5; telemetry store 8; real telemetry files 13; same-tick status regression 1; native telemetry ACL integration 2. The previous 405 lifecycle tests are retained.

No original shared package, WSL path, dependency, lockfile, workflow, schema migration or GPT-Bridge integration changed in this increment.

## 3. Safe records and freshness

```ts
interface SafeEvent {
  schemaVersion: 1;
  role: 'core' | 'tunnel';
  generation: string;
  releaseDigest: string;
  code: SafeCode;
  observedAtMs: number;
  attemptCount: number;
}
interface ServiceStatus extends SafeEvent { state: ServiceState }
```

Only own enumerable data properties with exact keys are accepted. Accessors, symbols, unknown fields, invalid prototypes and arbitrary messages are refused with `INVALID_TELEMETRY`. IDs use the existing bounded generation grammar; the release digest is exactly 64 lowercase hexadecimal characters. Time is a nonnegative safe integer and attempt count is 0–5. The exact existing SafeCode vocabulary is reused.

Core and tunnel have different state vocabularies. `LOCAL_CORE_HEALTHY` and `TRANSPORT_READY` require code `OK`; `BLOCKED_RESTART_BUDGET` requires `RESTART_BUDGET`. This validates record consistency, not the truth of an observation.

Status is canonical UTF-8 JSON plus one newline, at most 65536 bytes. Decode/re-encode byte equality rejects duplicate keys, BOMs and noncanonical bytes. `currentStatus` returns null for invalid, future, mismatched role/generation/release or age >=30000ms. A malformed decoded status becomes unknown when read, never repaired. Filesystem/size/access errors are fixed errors and must also be treated as unavailable by future callers.

The future supervisor must mint identifiers locally and establish live current-owner identity. A string matching the identifier grammar is not secret redaction or authorization; do not copy child/site/user messages into approved identifier fields. Status freshness alone does not prove process ownership, authenticated core health, website login or business readiness.

`writeStatus` validates/copies before asynchronous I/O, refuses corrupt existing bytes and reversed observation time, and awaits exact-byte CAS. Same-generation release changes are refused. Sequential changes within one wall-clock millisecond are permitted; the whole-record digest, not timestamp uniqueness, fences concurrent writers. Current-generation authorization belongs to Task 4/5, not to caller-supplied serialized claims.

## 4. Bounded structured event logs

Under the separately supplied private log directory, fixed names are:

```text
core.events.0.jsonl       tunnel.events.0.jsonl
core.events.1.jsonl       tunnel.events.1.jsonl
core.events.2.jsonl       tunnel.events.2.jsonl
```

Each retained segment is <=5242880 bytes (5 MiB), including its canonical `schemaVersion`/`sequence` header. The slot is `sequence % 3`; validated event lines follow the header. Missing sequence gaps, duplicate/wrong slots, extra fields, malformed bytes, wrong roles, reversed times and overflow are refused rather than silently reset.

An append fits in the newest segment or atomically replaces the next slot with a new header/event. The two other segments remain byte-for-byte unchanged. CAS compares all three prior digests under one role/event-group lock; destination-only comparison would incorrectly permit stale appends after a rotation.

**Ruling:** use one-slot replacement rather than a chain of three file renames. This keeps interrupted rotation from publishing a partially renamed set. Cost: each event validates/copies bounded retained data and rewrites at most one 5 MiB segment. This is a conservative LAB_ONLY design, not a high-throughput logging claim.

The retained bound is 15 MiB per role, excluding a transient same-directory replacement file and small lock. Crashed temporary files/locks are not automatically purged. Stopped ownership-verified recovery remains required before claiming an overall disk-space or unattended recovery guarantee.

## 5. Atomic private files and failure behavior

`createTelemetryFilesAt(runPolicy, logPolicy, io)` is internal, not a CLI/MCP configuration surface. Its already-provisioned directories and ACL verifier must be independently trusted. It creates no account, directory, credential, socket or service.

The shared engine supports only fixed `circuit`, `status` and `events` families. Circuit/status use one slot; events use three. It checks trusted ancestors, separate service-owned leaf, 0700 directories, regular 0600 singly linked files, descriptor/path identity and ACLs. Per-role family locks are exclusive and never stolen by age or PID.

Status files are `core.status.json` and `tunnel.status.json` in the run directory, separate from unchanged `*.circuit.json`. The appropriate `.status.lock`, `.events.lock` and `.circuit.lock` protect separate groups. No public arbitrary filename or validation callback is added.

A write copies validated input, acquires its group lock, rechecks all expected files, creates a private temporary file, writes and syncs it, rechecks files/lock/directory, renames one slot, then syncs the directory. Cleanup removes only its own still-matching temporary/lock inode. File replacement, wrong links, foreign locks and stale snapshots are refused.

Pre-rename failure preserves the prior complete record. Failure after rename can leave a complete newer record with uncertain durability; return `STATE_IO`, reload, and reconcile. Neither status nor event stores retry automatically or overwrite malformed state. Root and same-UID code remain trusted; repeated checks are not a sandbox or cryptographic authentication. OS sync calls are not hardware power-loss certification.

The existing restart accounting semantics remain unchanged: five unexpected exits in the rolling 300000ms window, sticky block, durable begin-before-spawn marker, generation-bound exit/reset and once-per-committed-recovery accounting. Missing/corrupt history is not a new installation. Detailed prior history evidence remains at the baseline runbook in Git history.

## 6. Discard-only child output

`attachChildOutput(stdout, stderr)` takes exclusive ownership of byte-mode readable pipes. It immediately resumes/discards bytes without retaining, concatenating, decoding or logging their content. Duplicate/object-mode inputs are rejected. The supervisor must not also attach a raw logger or competing reader to these pipes.

`finish()` starts one 20000ms shutdown deadline; startup has no drain timeout. Repeated finish calls share the same promise/deadline. The result is only `DRAINED`, `TIMED_OUT`, `ABORTED` or `STREAM_ERROR`. Abort reasons and stream-error messages are never returned. An error guard remains until close, then owned listeners are removed.

Timeout/abort destroys owned pipes, not arbitrary processes. The future supervisor separately manages process signals, owned child identity and the 20-second termination contract. Tests use actual PassThrough streams, fragmented synthetic secrets, environment-shaped strings, a 2 MiB chunk, timer boundaries and listener cleanup. End-to-end deployed process handling is not claimed.

## 7. Task 2 and Task 6 contracts retained

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

## 8. Fresh verification evidence

Exact code/test commit: `b608def267011a7227d98a44c2edc58faa409c07`.

| Check | Observed evidence |
|---|---|
| Focused exact-head run | `35803572343`, Mac and Ubuntu jobs completed/success |
| Native Mac job | `106999195155`, full log read; macOS15.7.9, darwin/arm64, Node24.20.0, pnpm10.34.5 |
| Mac lifecycle | 30 files / **472 passed**, zero failed/skipped |
| Mac root collection | 38 files / **520 passed**, zero failed/skipped |
| Ubuntu job | `106999195458`, all applicable steps successful; Apple-only cases explicitly skipped |
| Root lint, typecheck, tests, build, diff | Passed on both focused jobs |
| Plist structure and native syntax | Two roles passed; 12 altered structures rejected; native plutil passed |
| Existing root CI | `35803572300`, completed/success; synthetic PR merge preview, not an actual merge |

- https://github.com/jskjw157/gram-coding-agent/actions/runs/35803572343
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35803572300

The root total is main's 48 tests plus 472 lifecycle tests. MAC-01 and Windows M2 are still separate/unmerged and not included. A later documentation-only head receives separate CI evidence.

New native telemetry cases compile the existing descriptor ACL helper into temporary fixtures, persist/reload safe records, and refuse an actual allow-write ACL without changing the log bytes. This proves component interoperability, not independent helper provenance or fixed `/Library` deployment. Most filesystem fault tests use controlled ACL ports; all operate only on temporary test paths.

## 9. RED/GREEN and review ledger

| Checkpoint | Actual result |
|---|---|
| Telemetry/output RED `44b4182` | Native run35801911666/job106993942281: 38 failed/405 prior passed |
| Telemetry/output implementation `185c711` | Focused35802133573/root35802133572 successful |
| Store/planner RED `4e4e61e` | Native run35802333849/job106995265076: 13 failed/443 passed |
| Store/planner `fc038a1` | 455 passed/one full-size test timed out; not full success |
| Test comparison correction `7c0aa94` | Full-byte Buffer.equals replaced per-byte object traversal; same 15s limit, focused35802796876/root35802796813 successful |
| File integration RED `432f325` | Native run35802971879/job106997290303: 13 failed/456 passed |
| File integration `c346274` | Focused35803172647/root35803172741 successful; prior circuit tests unchanged |
| Same-tick regression `e3b3f2e` | Native run35803388715/job106998614195: one STATE_CONFLICT failure/471 passed; two new native cases passed |
| Corrective implementation `b608def` | Final472/520 and full verification above |

Author self-review covered fixed filenames, whole-group CAS, retained bounds, corrupt/unknown I/O, listener cleanup, timestamp equality and unresolved trust. **Independent review NOT_PERFORMED.** The same-tick finding was reproduced before correction; other added native cases are coverage, not a claimed security fix. No test/lint rule, assertion, size bound or timeout was disabled.

## 10. Isolation and exact continuation

Only the MAC-02 feature branch is modified. Main `fdf5dda`, Windows M2 `c5225dd8`, MAC-01 `a98c8ff`, and docs `31e66aa` were the separate starting refs. Refresh all heads before further writes; do not overwrite concurrent work.

Local authoring has Node22/global TypeScript, no pnpm and unavailable direct GitHub/npm DNS. No complete local checkout/worktree or local Node24 repository run is claimed. Actual verification uses the existing read-only GitHub Actions exact-head detached worktrees. The unchanged empty-importer normalization remains a packaging gate; do not call the generated lockfile pristine.

**Next safe implementation:** Task 4 owned-connection/authenticated health tests, beginning with an unknown/foreign peer receiving zero credential bytes. Reuse these status/event/output modules; do not implement them again. Maintain Task 2 independent helper provenance/fixed-root acceptance, Task 5 live-generation/5-second observation/process integration, Task 6 authorized stopped recovery and abandoned-lock handling, and Task 7 packaging as explicit gates. No security-sensitive shortcut is authorized by green component tests.

**NOT_RUN:** user's account provisioning, independently trusted helper/fixed-root preview, production run/log binding, installed launchd start/stop/reboot, established-peer proof, live tunnel, Keychain/TCC, browser or HAAR operations. No account, secret, permission or live store was changed; no merge, force push, rebase, branch deletion or Windows issue closure. Generated service files remain **NOT DEPLOYABLE**.
