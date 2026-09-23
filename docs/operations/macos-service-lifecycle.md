# MAC-02 Service Lifecycle — Owned-Connection Health Components

**Updated:** 2026-09-23 (Asia/Seoul)  
**Status:** IN_PROGRESS / PARTIAL. Task 4 native owned-peer/authenticated-health components are exact-head CI verified; the service is still not deployable or independently reviewed.  
**Branch / PR:** `feat/macos-service-lifecycle` / #138, Draft and unmerged.  
**Verified exact-head code/test checkpoint:** `40d9dfbbf6a2aa8dd924d95bb2e09779ddac1d8d`.  
**Resume baseline:** `ef0d31c80cb6ed5f387afd5428349c988cd7414f`.  
**Plan:** `docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md` at `3c643d4c10772d57287af0b401e4219ad7782a34`.  
**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`.  
**Merge base:** `fdf5dda2211e011e473f1c89095b78d7cb565c2f`.

## 1. Actual progress and immediate gate

| Task | Actual state |
|---|---|
| Task 1 | Strict LAB_ONLY configuration and fixed plist renderer implemented |
| Task 2 | Native inspection/static identity/preview components exist; independent ACL-helper provenance, fixed-root acceptance and live identity remain gated |
| Task 3 | Restart history, private persistence, safe status/events/log rotation and discard-only output components exist; production bindings, current-owner enforcement, abandoned locks and supervisor integration remain open |
| Task 4 | Authenticated health, same-socket transport, live-process sealing and native libproc accepted-peer verification are component-implemented and exact-head CI verified; supervisor spawn/registration/stop wiring remains Task 5 |
| Tasks 5–7 | Supervisor, admin install/rollback/uninstall, runnable CLI and sealed packaging not implemented |
| Task 8 | Component tests exist; full installed lifecycle, independent review and user-device acceptance remain incomplete |

**Immediate resume:** begin Task 5 supervisor state-machine work from the verified Task 4 ports. The supervisor must create and retain the actual ChildProcess handle, seal its start/UID/executable identity, compose the native accepted-peer verifier and never substitute PID/port/persisted status for live ownership. Keep Task 2 helper provenance/fixed-root and Task 3 production-binding/abandoned-lock gates open.

No `supervisor-cli.js` exists. Generated plists remain **NOT DEPLOYABLE**. No real credential, account, Keychain entry, OS permission, tunnel or storefront was provisioned. MAC-03–05 documents remain separate at `31e66aa21b705b1793f11122c1b12d5ebf41715c`; none was implemented or edited here.

## 2. New modules and interfaces

Two product files under `packages/macos-lifecycle/src/`:

- `health-probe.ts`: closed child-claim validation, bounded protocol responses, health/tool-surface evaluation and generation-bound evidence.
- `adapters/loopback-http.ts`: paused local socket, verifier ordering, one fixed HTTP exchange per checked socket, bounded response collection and cleanup.

Three test files add 52 Vitest cases: `health-probe.test.ts` (29), `adapters/loopback-http.test.ts` (20), `adapters/loopback-races.test.ts` (3). This is a count of tests written, **not 52 final tests verified passing**.

The internal interfaces are:

```ts
interface CoreCredentials {
  withValue<T>(use: (secret: string) => Promise<T>): Promise<T>;
}
interface ConnectedPeerVerifier {
  current(child: OwnedChild): Promise<boolean>;
  verify(socket: Socket, child: OwnedChild, signal: AbortSignal):
    Promise<'OWNED' | 'FOREIGN' | 'UNKNOWN'>;
}
```

`current` must eventually bind the actual live registered child handle, start identity, UID, generation and sealed release. `verify` must establish the server-side accepted peer of the exact already-open client socket. Neither implementation is provided in this increment. A callback's TypeScript type or a supplied claim does not authenticate anything.

The public package index/MCP tool surface is unchanged. These are internal composition seams, not remote tools or serialized configuration. `createLoopbackConnections()` with no verifier returns no connection. Its only dial target is `127.0.0.1:3847`. The internal binder accepts an already-open local socket so temporary-port fixtures can exercise the same transport; it is not an arbitrary host/URL API. Tunnel health and process spawn/stop are not implemented here.

## 3. Authenticated health sequence

`probeCore` performs these steps in order:

1. Open a paused connection, obtain ownership proof and confirm current identity.
2. Read the existing unauthenticated `/healthz` source shape.
3. Initialize MCP with the pinned compatibility fixture `2025-11-25`.
4. Send the initialized notification and require an empty 202 response.
5. List exactly one tool, `agent_health`, without a continuation cursor.
6. Call that tool and require the exact health object: `{status:'healthy', database:'ok', mcp:'ready'}`.

There are five HTTP exchanges: health, initialize, initialized, tools/list and tools/call. Each newly opened connection must independently pass the verifier. The protocol date is a pinned candidate, not a claim about the latest protocol. Actual compatibility with the pinned repository SDK remains a required test gate.

Responses require the expected JSON-RPC IDs and result shape. MCP errors, tool isError, broader/duplicate/missing tools, unexpected protocol versions, extra health fields, empty/malformed/oversized data and redirects cannot produce healthy evidence. 401/403 after authentication produce AUTH_BLOCKED without retry. An optional validated session ID is retained only inside the probe, never included in evidence or logs.

JSON and a deliberately bounded single-response SSE form are parsed. Body and HTTP headers are capped at 65536 bytes; body collection also caps chunk count. Each exchange has a 2000 ms total deadline including acquisition/checks; continuous trickling does not reset it. Unsupported content encodings are refused, not decompressed. No raw protocol body or provider exception is returned as public evidence.

A successful result binds generation, release digest and observation time. Invalid identity claims are rejected before contacting ports and are not echoed. Health evidence is not a permission grant, website login, GUI readiness or a substitute for a native ownership provider.

## 4. Same-socket credential boundary

The transport uses Node's HTTP parser and a one-use Agent whose connection factory can return only the already-checked socket. It has no alternative connection factory, pool reuse, proxy, redirect-following or authenticated retry. A dead socket cannot silently reconnect to a replacement listener.

Current identity is checked before and after asynchronous peer proof. It is checked again after the local credential callback resolves and before sending bytes. An absent/foreign/unknown proof prevents authenticated requests. The credential is a synthetic value in tests; no production credential provider is connected.

The binder has its own 2000 ms proof deadline. The production dialer's deadline also covers binding. Requests are single-use, fixed-path and fixed-method. Abort reasons, stream errors and header-validation errors return only HEALTH_UNKNOWN. Close/error/abort paths destroy the owned connection.

**Review corrections reproduced locally:**

- A generation change during initial asynchronous proof previously still yielded a connection capability.
- A generation change during the pre-broker proof previously allowed one unnecessary credential-broker invocation, although the later check prevented request bytes.
- A direct binder could wait indefinitely on a verifier unless its caller supplied a deadline.

All three were reproduced against byte-matched remote source in a supplemental Node 22 test run, then corrected. The corresponding Vitest cases are committed but their final CI execution is still pending. These checks do not claim atomic protection from trusted same-UID/root code or a compromised native verifier.

## 5. Verification: distinguish completed, RED and unexecuted

| Checkpoint | Observed result |
|---|---|
| Protocol RED `697c4eb` | Native run `35807407400`, job `107011202018`: 29 failed / 472 prior passed; one scaffold rejection was attached late by a timer test |
| Protocol implementation `5da1a1a` | Focused Mac/Linux `35807687220` and root `35807687231`: completed/success |
| Transport RED `94e53c7` | Native run `35807813336`, job `107012433390`: 20 failed / 501 prior passed against the unimplemented transport |
| Transport implementation `9832dff` | Run `35808036297`: failure before execution; both jobs had empty steps, runner_id 0 and no downloadable log |
| Corrective code `ee803ee` | Run `35808863336` jobs also returned failure with no steps; root `35808863353` returned failure. Not a final CI pass |
| Supplemental local contract suite | Linux Node 22.16.0, actual copied production source: 24 tests; first 21 passed / 3 reproduced failures, then 24 passed / 0 failed |
| Supplemental partial typecheck | Global TypeScript 5.8.3, copied contracts/health/transport with repository strict flags: passed; NOT repository TypeScript 6/Node 24 verification |

The runner-start failure's underlying cause has not been established. No billing, quota, outage or code-failure diagnosis is asserted from empty steps alone. No CI configuration, runner label, assertion, time limit or security condition was weakened to avoid it. A subsequent documentation commit's checks do not replace missing code verification.

The 24 local checks include actual loopback sockets, zero-byte foreign/unknown rejection, no reconnect on socket death, delayed credential/abort races, invalid headers, oversized responses, compression refusal, trickled-body deadlines, one-use requests and a **synthetic** JSON/SSE MCP fixture. The health and transport source copies were verified against Git blob hashes `b40a4d4ee3284fbac14026d49588346ff425b3e2` and `c34110959be80efb4411caebfff669709f8a19a4`.

This local suite is not the repository Vitest suite, not native macOS, and not the actual MCP SDK. The two real repository MCP-server compatibility tests in `loopback-http.test.ts` were written, but have not run against a completed transport in CI. Do not claim a 524/572 final suite pass or claim supported SDK compatibility from the synthetic fixture.

Useful evidence:
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35807687220
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35807813336
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35808036297
- https://github.com/jskjw157/gram-coding-agent/actions/runs/35808863336

Local authoring has Node 22 and global TypeScript, no pnpm/full checkout; direct GitHub DNS was attempted and failed. Earlier actual repository verification used the unchanged read-only Actions exact-head detached worktrees. No local Node 24 or full repository run is claimed.

## 6. Prior behavior and Task 6 read contract retained

Task 1–3 product files were not changed. Circuit accounting remains five unexpected exits in a rolling 300000 ms, sticky block, durable begin-before-spawn, generation-bound exit/reset, and no silent initialization of missing/corrupt recovered history. Status remains an observation with a 30000 ms lifetime. Event logs retain three <=5 MiB segments per role; transient files/crash remnants are outside that retained bound. Child output remains discard-only with a 20000 ms shutdown drain.

Private-file CAS preserves complete old bytes before rename; a post-rename sync failure can leave complete new bytes with uncertain durability and requires reload/reconciliation, not blind retry. Crash-abandoned locks remain BUSY. No age/PID stealing, authorized stopped recovery or production directory trust wrapper was added.

Static installed identity remains limited to pristine or disabled/unregistered installations. Actual plist bytes must match the fixed renderer, not only a manifest hash. The one-shot preview remains read-only and revalidates account/release/install/ports. Missing independently trusted ACL support fails closed.

The existing Task 6 installation read contract must be preserved:

| Record | Fixed location |
|---|---|
| Configuration | `/Library/Application Support/HAAR/GramAgent/config/service.json` |
| Manifest | `/Library/Application Support/HAAR/GramAgent/config/installation.json` |
| Journal | `/Library/Application Support/HAAR/GramAgent/config/install-journal.json` |
| Core plist | `/Library/LaunchDaemons/com.haar.gram-agent.core.plist` |
| Tunnel plist | `/Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist` |

Manifest exact fields: `schemaVersion:1`, `state:'COMMITTED'`, `runtime:{name,uid,gid}`, `configSha256`, `releaseId`, `releaseDigest`, `plistSha256:{core,tunnel}`, `desiredEnabled:{core,tunnel}`. Runtime name is gram-agent; digests bind exact bytes; absent tunnel hash is null; the currently supported installed state is disabled for both roles.

A remaining journal requires exactly `schemaVersion:1`, `stage:'COMMITTED'`, `installationDigest` equal to the manifest's exact-byte SHA-256. Absence is allowed only with an otherwise valid installation. Intermediate/mismatched journals are refused, not deleted/replayed. Metadata is bounded to 262144 bytes. Any writer contract change requires explicit versioned review.

Detailed prior implementation and 472/520 native telemetry verification remain in the historical runbook:
https://github.com/jskjw157/gram-coding-agent/blob/ef0d31c80cb6ed5f387afd5428349c988cd7414f/docs/operations/macos-service-lifecycle.md

## 7. Review, rulings and handoff

**Review:** author self-review only; independent review NOT_PERFORMED. No security certification, native attestation or completed Task 4 is claimed.

**Rulings:**

- Develop bounded protocol/transport behind internal ports while preserving native-trust gates. Cost: components cannot be deployed safely by themselves.
- Use a fixed protocol candidate and an internal ephemeral-socket fixture seam, not configurable production endpoints. Cost: actual repository SDK compatibility remains to be demonstrated.
- When final Actions jobs failed before execution, run a clearly labeled local Node 22 supplemental suite. Cost: Node 24/Vitest/macOS compatibility and final root lint/typecheck/build remain unverified; do not mark the task done.

Resume with an exact-head `pnpm install --frozen-lockfile`, lifecycle tests, root lint/typecheck/test/build and compiled plist checks on Linux and native arm64 Mac. Inspect any actual MCP compatibility failure without relaxing the allowlist, byte/deadline bounds or pre-auth ownership requirement. Then implement registered-child and native libproc/accepted-socket verification; validate actual foreign/PID-reuse/death/rebind cases with synthetic credentials only. The verifier must be independently trusted before production use.

Only this MAC-02 branch was written. Starting separate refs: main `fdf5dda`, Windows M2 `1dc39d38`, MAC-01 `a98c8ff`, docs `31e66aa`. Windows had advanced externally before this continuation and was left untouched. Do not overwrite any later concurrent updates.

**NOT_RUN:** final exact-head repository suite; completed-transport real MCP compatibility; native accepted-peer/process proof; trusted-helper fixed-root acceptance; user-Mac installation; launchd/reboot recovery; actual Keychain/TCC, tunnel, browser or HAAR operations. No merge, force push, rebase, branch deletion, Windows issue closure or credential onboarding occurred. Empty-importer lockfile normalization remains a packaging gate.

Reference semantics (not deployment evidence):
- Node 24 HTTP custom connection factory: https://nodejs.org/download/release/latest-v24.x/docs/api/http.html
- Pinned MCP transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports


## 8. Task 4 native ownership checkpoint — exact-head verification

This section supersedes the older pending-CI language in sections 2, 5 and 7 for Task 4 only. Earlier RED records remain historical evidence.

### Added implementation

- `adapters/owned-process.ts` now seals an actual live child handle to PID, UID, kernel start sec/usec, generation, release digest and executable device/inode. The caller cannot supply the start identity as a trusted fact.
- `platform/macos/native/peer-owner.c` uses Apple libproc process/FD/socket inspection. Current identity checks PID, UID, process start time and executable device/inode. Accepted-peer proof additionally scans the target process FDs and requires an established IPv4 loopback TCP socket matching the already-open client's server/client port tuple.
- The native helper has no arbitrary command selector and receives only bounded numeric identity/tuple arguments. Its output vocabulary is `START <sec> <usec>`, `OWNED`, `FOREIGN` or `UNKNOWN`. Missing/ambiguous inspection fails closed.
- `createMacConnectedPeerVerifier` rechecks the live child before and after accepted-socket proof. A dead/replaced handle, changed generation/release, executable mismatch, foreign socket or unknown proof cannot become `OWNED`.
- The existing same-socket transport remains the only path that can obtain the synthetic internal credential. The checked connection is one-use; there is no authenticated reconnect to a replacement listener.

### TDD and corrective record

| Checkpoint | Observed evidence |
|---|---|
| Native ownership RED `804ac22` | Ubuntu exact-head behavioral run showed 6 new `NOT_IMPLEMENTED` failures with prior applicable tests still passing; this isolated the new contract before implementation |
| Native fixture RED `04a245c` | macOS run compiled the test suite but failed because `platform/macos/native/peer-owner.c` did not yet exist; the desired native dependency was therefore proven absent before implementation |
| Native implementation `d1a4ea2` | macOS behavioral phase compiled the helper and passed all three real process/socket fixture tests; subsequent full typecheck exposed six implicit-any errors in the new proof factory |
| Contextual typing correction `fa8f5a1` | minimal typed-object correction removed the TypeScript defect; native behavioral tests continued to pass |
| Existing test-race correction `40d9dfb` | the no-reconnect test now waits until the server has observed the initial connection before destroying the client during credential acquisition; it still requires accepted-count exactly 1 and zero request bytes, so the security assertion is not weakened |

The intermittent prior `accepted() === 0` failure was a test scheduling race: client `connect` can resolve before the server-side `connection` callback increments the fixture counter. It was unrelated to the native verifier and reproduced only on the assertion timing. The correction establishes the initial accepted connection before testing that no second connection appears.

### Fresh exact-head evidence

Exact head: `40d9dfbbf6a2aa8dd924d95bb2e09779ddac1d8d`.

- Root CI run `35828930247`: completed/success.
- Focused lifecycle run `35828930223`: macOS and Ubuntu jobs completed/success.
- Native macOS job `107076807999`: macOS arm64, Node 24.20.0; lifecycle **35 files / 533 tests passed, zero failed/skipped**.
- The same Mac job's root collection: **43 files / 581 tests passed, zero failed/skipped**; lint, typecheck, build and diff checks passed.
- Ubuntu job `107076808139`: applicable lifecycle **514 passed / 19 Apple-only skipped**; root **562 passed / 19 Apple-only skipped**; lint, typecheck and build passed.
- Generated plist structure accepted two roles and rejected 12 altered structures; native `plutil -lint` passed both generated plists. No service was installed.
- Native ownership tests compiled `peer-owner.c` using the installed Apple SDK and exercised real child-process start identity, executable inode/device, accepted loopback socket ownership, foreign server rejection, executable mismatch and post-exit invalidation.
- Real repository MCP compatibility tests also passed at this exact head: correct credential produced healthy evidence and wrong credential remained blocked.

The earlier zero-step Actions failures at `3563e4b` were rerun against the exact same SHA and then executed successfully, separating runner availability from code correctness. No workflow or security assertion was weakened to obtain this result.

### Remaining gates after Task 4

Task 4 component behavior is ready for Task 5 consumption, but MAC-02 is **not** complete. Still open:

- Task 2 independently trusted ACL-helper provenance/bootstrap and real fixed-root acceptance.
- Task 3 production run/log directory binding and ownership-verified recovery of abandoned writer locks.
- Task 5 actual fixed-role supervisor spawn/stop, live generation ownership, circuit integration, 5-second observations and gated test-tunnel startup.
- Task 6 local-admin apply/rollback/uninstall and stopped authorized reset/recovery.
- Task 7 runnable CLI and sealed packaging, including helper inventory/provenance.
- Task 8 installed launchd/reboot/user-device acceptance and independent review.

No actual account, Keychain/TCC setting, FileVault/SSH setting, tunnel credential, browser session, HAAR store action or administrator installation was touched in this checkpoint.
