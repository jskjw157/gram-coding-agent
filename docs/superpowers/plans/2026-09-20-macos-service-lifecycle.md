# MAC-02 macOS Service Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the selected native sequential execution method. Use superpowers:subagent-driven-development only if the user changes that method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a laboratory-only, non-admin macOS core/tunnel lifecycle with read-only preview, owned-process supervision, authenticated health, and recoverable installation, without executing HAAR business operations.

**Architecture:** Add `@gram/macos-lifecycle`, with pure configuration/plist/state decisions and narrow filesystem, process, loopback-health and launchctl adapters. Keep privileged local installation separate from non-admin supervisors; reuse the existing health-only core, never copy or expand M2. A provider-specific test tunnel remains disabled until its installed binary and test credentials have been separately verified.

**Tech Stack:** Repository Node `>=24 <25`, pnpm `10.34.5`, TypeScript `^6.0.0`, Vitest `^5.0.0`, Node built-ins, native macOS command/SDK facilities, and additive Linux/native-arm64 CI. Reuse locked dependency versions. No new AI API or external production package is required by this plan.

**Spec:** `docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md` at `3b66075d9ef4cf2d7e87416547ea807b43ec856e`, blob `20a0b648581e45e5575f653804fa67e357bbfd1d`. The parent operations design is `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md`. Read both before implementation.

**Plan state:** READY FOR WRITTEN-PLAN REVIEW; NOT EXECUTED. The user said to proceed after presentation of the written MAC-02 design, authorizing this planning step. This newly written plan still needs review. The prior native sequential execution choice is preserved; no new method choice is necessary. Neither this document nor its review grants administrative installation, real tunnel/account access, a merge, or a production rollout.

## Global Constraints

The following requirements carry the spec's meaning and numeric limits into every task:

- `LAB_ONLY`: the core tool allowlist is exactly `['agent_health']`; no browser, order, code-execution or other business tools may be exposed.
- "long-running processes run as `gram-agent`, never root; no passwordless sudo or remote privileged control tool."
- "preview is read-only; installation requires an explicit local administrative apply action against the exact reviewed configuration digest."
- "fixed labels, paths and executables; refuse foreign files, conflicting jobs and occupied ports rather than replacing or killing them."
- "restart does not replay tasks, approve actions, or infer successful side effects."
- "no secret values in plist, argv, install manifest, logs, diagnostic JSON, Git, task state or MCP output."
- "no FileVault, automatic-login, TCC, sleep, firewall, SSH or account-security changes."
- "atomic configuration replacement and service rollback; preserve databases, profiles, keys and workspaces."
- "no new business scheduler, secret vault, GUI IPC protocol or Task Engine in this increment."
- Core `127.0.0.1:3847`; tunnel health `127.0.0.1:8080`. No port overrides, forwarding proxies, new remote listeners, or alternate MCP tunnel.
- Two labels: `com.haar.gram-agent.core`, `com.haar.gram-agent.tunnel`. Plists under `/Library/LaunchDaemons/`.
- launchd settings: `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=30`, `ExitTimeOut=30`, `Umask=63` (octal 077). Actual target support remains a native test gate.
- Core startup deadline 60,000 ms; dependency waits 1, 2, 4, 8, 16, then 30 seconds; five unexpected exits in a rolling 300,000 ms open a persistent circuit.
- Probe cadence 5,000 ms; observation lifetime 30,000 ms; each health response at most 65,536 bytes and each request at most 2,000 ms; redirects forbidden.
- Child drain at most 20,000 ms; three 5 MiB log files per role. No raw child output in logs.
- No changes to WSL files, M2 contracts, current MCP routes, TaskStatus, policy, existing CI or the manifest-backed #1–#130 backlog.
- Process availability, authenticated core health, tunnel readiness, business readiness and user-Mac acceptance are different results.

## Review Focus

1. **Preview-to-apply replacement:** changed bytes, escaping links, hardlinks, writable ancestors, ACL grants or concurrent applies must not cross the privileged boundary. Tasks 2 and 6 test this.
2. **Wrong peer and reused PID:** a foreign listener or another generation must receive no internal-auth bytes, even if it returns HTTP 200. Task 4 tests the already-connected socket and process identity.
3. **Restart budget erased by a kill/reboot:** persist an active attempt before spawning; a stale active attempt is counted once; corrupt/future history blocks rather than resets. Tasks 3 and 5 test this.
4. **Migration during a failed deployment:** compatibility is checked against the actual closed lab database, not a pre-start number. Task 6 tests rollback refusal with byte-preserved DB/WAL files.
5. **Mock success mistaken for deployment:** root CI, native package checks, disposable launchd tests and the user's machine need separate recorded outcomes. Task 8 owns the matrix; skipped native tests do not count as passes.

---

## 1. Baseline, dependency decision and change budget

Freshly read repository refs for this planning pass:

| Ref | SHA |
|---|---|
| `main` | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` |
| `feat/m2-vertical-slice` | `c7fc805511bd777059d93c6a8360596a934919dc` |
| `feat/macos-platform-readiness` | `a98c8ff45497f8524bc2ffa9bda19ad60898faf1` |
| `docs/macos-operations-agent-design` | `3b66075d9ef4cf2d7e87416547ea807b43ec856e` |

PR #136 is the existing documentation PR. MAC-01 remains on its own branch; no merge/cherry-pick is assumed. Refresh refs and PR states before execution. The plan does not change prior source documents to make their historical status lines appear current.

**Source-derived integration details:** `HealthService` returns `{status, database, mcp}`, with healthy values `healthy`, `ok`, `ready`. The current migrator records applied versions in `schema_migrations`, not SQLite `user_version`. `/healthz` is unauthenticated; `/mcp` requires the internal header. The executable core uses fixed port 3847. These observations determine the tests below; do not substitute an invented schema. See section 8 sources.

**Planning choice:** do not import or copy the unmerged `@gram/platform` package. MAC-02 reports its own service lifecycle only; it has no generic business-readiness evaluator. After reviewed MAC-01 integration, a separate additive adapter may map an owned core observation to `CORE`, leaving other observations unknown. Pure MAC-02 tests can start now, as allowed in spec section 13.

**Allowed implementation paths:** `packages/macos-lifecycle/**`, `platform/macos/**`, `.github/workflows/macos-lifecycle.yml`, `docs/operations/macos-service-lifecycle.md`, and only necessary new-importer entries in `pnpm-lock.yaml`. Do not modify existing packages or root configurations to hide a failure. A native helper source under `platform/macos/native/` is allowed only for the fixed ownership inspection described in Task 4, not a general privileged helper.

**Proposed implementation branch:** `feat/macos-service-lifecycle`, in a separate worktree based on the then-current reviewed main. This planning pass creates neither branch nor worktree. A code baseline that contains a broader tool surface fails the LAB_ONLY gate; it is not made safe by filtering the tool-list response.

### Execution preflight, after plan review

- [ ] Refresh refs, inspect existing worktrees/dirty files, and record `MAC02_BASE_SHA` and the exact reviewed documentation commit. Do not reset, clean or overwrite an existing checkout.
- [ ] Create the isolated feature worktree and run the unmodified baseline checks:

```bash
git fetch origin
git status --short
git worktree list
git ls-remote --heads origin main feat/m2-vertical-slice feat/macos-platform-readiness docs/macos-operations-agent-design
git worktree add -b feat/macos-service-lifecycle ../gram-macos-service-lifecycle origin/main
cd ../gram-macos-service-lifecycle
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: Node24/pnpm10.34.5, successful baseline, no tracked-file changes. Record actual counts rather than inheriting the prior 48/79-test figures. If the session cannot execute the repository, use a read-only, exact-head CI job in an isolated worktree and label that environment. Do not silently add a write-enabled lockfile updater. Seed the new importer from identical existing locked versions, then have pnpm validate it; reject unrelated resolution churn.

- [ ] Maintain this plan's ignored progress ledger, including task base/head, RED/GREEN commands, review findings and deviations. No new issue numbering or Windows issue closure is part of execution.

## 2. Files and module interfaces

All names below are proposed implementation contracts, not existing repository APIs. Production files contain no test fixture switches, arbitrary-label service runner, configurable shell command, external URL or generic secret reader.

```text
packages/macos-lifecycle/
  package.json, tsconfig.json, vitest.config.ts
  src/
    contracts.ts
    config.ts / config.test.ts
    launchd-plist.ts / launchd-plist.test.ts
    release-inspection.ts / release-inspection.test.ts
    preflight.ts / preflight.test.ts
    circuit.ts / circuit.test.ts
    lifecycle-store.ts / lifecycle-store.test.ts
    health-probe.ts / health-probe.test.ts
    supervisor.ts / supervisor.test.ts
    install-service.ts / install-service.test.ts
    local-control.ts / local-control.test.ts
    diagnostic.ts / diagnostic.test.ts
    cli.ts, supervisor-cli.ts, index.ts
    adapters/
      trusted-files.ts / trusted-files.test.ts
      macos-inspection.ts / macos-inspection.test.ts
      owned-process.ts / owned-process.test.ts
      loopback-http.ts / loopback-http.test.ts
      launchctl.ts / launchctl.test.ts
      service-files.ts / service-files.test.ts
    test-support/fixtures.ts
    integration.test.ts, architecture.test.ts, native.test.ts
platform/macos/
  config/core-lab.example.json
  package-release.mjs
  native/peer-owner.c
  tests/native-launchd.mjs
  tests/verify-core.mjs
  tests/verify-plist.py
.github/workflows/macos-lifecycle.yml
docs/operations/macos-service-lifecycle.md
```

No root-directory migration is needed. Tests are collected from the new package; standalone native scripts are also run explicitly in its workflow. The native helper is built without root using the installed Apple SDK; inability to build/inspect returns an unavailable-ownership result and blocks authenticated activation.

### Shared contracts, introduced with Task 1

```ts
export type Role = 'core' | 'tunnel';
export const labels = {
  core: 'com.haar.gram-agent.core',
  tunnel: 'com.haar.gram-agent.tunnel',
} as const;
export const root = '/Library/Application Support/HAAR/GramAgent';
export interface ServiceConfig {
  schemaVersion: 1;
  mode: 'LAB_ONLY';
  releaseId: string;
  releaseDigest: string;
  runtimeUser: 'gram-agent';
  tunnel: { enabled: false } | {
    enabled: true;
    compatibilityDigest: string;
    credentialRef: 'test-tunnel-key';
  };
}
export interface AccountIdentity {
  uid: number; gid: number; admin: boolean; name: 'gram-agent';
}
export interface OwnedChild {
  role: Role; pid: number; startIdentity: string;
  generation: string; releaseDigest: string; uid: number;
}
export type SafeCode =
  | 'OK' | 'UNSUPPORTED_HOST' | 'INVALID_CONFIG' | 'ACCOUNT_INVALID'
  | 'UNTRUSTED_RELEASE' | 'UNSAFE_PATH' | 'FOREIGN_SERVICE' | 'PORT_IN_USE'
  | 'CONFIG_CHANGED' | 'BUSY' | 'AUTH_BLOCKED' | 'HEALTH_UNKNOWN'
  | 'TOOL_SURFACE_MISMATCH' | 'RESTART_BUDGET' | 'INVALID_HISTORY'
  | 'ROLLBACK_BLOCKED_SCHEMA' | 'PARTIAL_INSTALL' | 'NOT_AUTHORIZED'
  | 'TUNNEL_COMPATIBILITY_REQUIRED' | 'INTERNAL_ERROR';
export interface Result { ok: boolean; code: SafeCode }
export interface Preview {
  ok: boolean; code: SafeCode;
  configDigest: string; previousInstallDigest: string | null;
  releaseDigest: string; roles: Role[];
}
export interface Clock { nowMs(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
```

Do not infer authorization from `ok`, an expected digest, the string LAB_ONLY, account ownership, or a non-root UID. Those are necessary conditions, not independently sufficient trust proofs. Operation-specific ports appear in their owning task; internal ports are not MCP APIs.

## 3. Task-by-task implementation

### Task 1: Strict configuration and fixed-role plist generation

**Files:** Create package configuration, `contracts.ts`, `config.ts`, `launchd-plist.ts`, their tests, `index.ts`, and `platform/macos/config/core-lab.example.json`. Update only the new lockfile importer.

**Interfaces:** `parseConfig(value: unknown): ServiceConfig`; `configDigest(config: ServiceConfig): string`; `renderPlist(config: ServiceConfig, role: Role): string`. Later tasks consume these exact signatures. `renderPlist` is pure and never starts a process.

- [ ] **Step 1 — add package/test configuration and failing tests.** Use the existing workspace conventions; production dependencies remain empty.

```json
{
  "name": "@gram/macos-lifecycle", "version": "0.0.0", "private": true,
  "type": "module", "main": "./dist/index.js", "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json", "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run"
  },
  "devDependencies": { "typescript": "^6.0.0", "vitest": "^5.0.0" }
}
```

`tsconfig.json` extends `../../tsconfig.base.json`, includes `src/**/*.ts`, sets `rootDir: 'src'` and `outDir: 'dist'`, and excludes tests/test-support from production build. Vitest configuration:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  name: 'macos-lifecycle', environment: 'node',
  include: ['src/**/*.test.ts'], passWithNoTests: false,
} });
```

Use this literal fixture in the config tests and copy it into test-support only after GREEN:

```ts
import { expect, it } from 'vitest';
import { parseConfig, configDigest } from './config.js';
import { renderPlist } from './launchd-plist.js';
const input = {
  schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false },
};
it('rejects extra keys rather than treating them as runtime options', () => {
  expect(() => parseConfig({ ...input, command: 'anything' })).toThrow('INVALID_CONFIG');
});
it('does not permit a configurable core port', () => {
  expect(() => parseConfig({ ...input, port: 9999 })).toThrow('INVALID_CONFIG');
});
it('preserves spaces in fixed paths as individual XML array values', () => {
  const xml = renderPlist(parseConfig(input), 'core');
  expect(xml).toContain('<string>/Library/Application Support/HAAR/GramAgent/releases/lab-001/bin/node</string>');
  expect(xml).toContain('<key>Umask</key><integer>63</integer>');
  expect(xml).not.toContain('CONTROL_PLANE_API_KEY');
});
it('hashes normalized configuration independent of input key order', () => {
  expect(configDigest(parseConfig(input))).toBe(configDigest(parseConfig({
    tunnel: { enabled: false }, releaseDigest: input.releaseDigest,
    releaseId: 'lab-001', runtimeUser: 'gram-agent', mode: 'LAB_ONLY', schemaVersion: 1,
  })));
});
```

Also parameterize null/array input, wrong booleans, missing keys, non-hex digest, `../`, slash, control characters, root/admin runtime names, disabled-tunnel extras, and enabled tunnel without its compatibility digest. Release IDs use `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; reject `.` and `..`. No arbitrary installation root is a production option.

- [ ] **Step 2 — observe RED.** Run `pnpm --filter @gram/macos-lifecycle test`. Expected: these new feature assertions cannot pass before implementation. Resolve harness/import issues to observable failing assertions; an empty suite alone is not behavioral RED evidence.

- [ ] **Step 3 — implement the strict parser and serializer.** Reject unknown keys at every object level, construct a fresh ordered result, and hash its UTF-8 JSON with SHA-256. Fixed errors contain no offending input. XML escaping is one reusable pure function:

```ts
export function xmlText(value: string): string {
  return value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] ?? c));
}
```

Generate only these plist keys: Label, UserName, ProgramArguments, WorkingDirectory, RunAtLoad, KeepAlive, ThrottleInterval, ExitTimeOut, Umask, StandardOutPath, StandardErrorPath. Set the last two to `/dev/null` to avoid unbounded pre-main/runtime error output; supervisors write only their bounded safe event logs. ProgramArguments are the sealed `bin/node`, sealed `packages/macos-lifecycle/dist/supervisor-cli.js`, `--role`, the fixed role, `--config`, and the fixed installed configuration path. No shell, PATH search, EnvironmentVariables, NetworkState or AbandonProcessGroup. `renderPlist` rejects a tunnel role for a disabled tunnel. Test `xmlText` directly with XML metacharacters even though release IDs exclude them.

- [ ] **Step 4 — GREEN and root collection.** Run package tests/lint/typecheck/build and `pnpm exec vitest run --project macos-lifecycle`, then root `pnpm test`. No root config edit is needed for collection. Verify no existing lock resolution changed.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle platform/macos/config/core-lab.example.json pnpm-lock.yaml && git commit -m 'feat(macos): validate lab lifecycle configuration and render fixed plists'`. Record observed RED/GREEN and counts.

### Task 2: Read-only release inspection and mutation-free preview

**Files:** Create `release-inspection.ts`, `preflight.ts`, `adapters/trusted-files.ts`, `adapters/macos-inspection.ts`, tests and `test-support/fixtures.ts`.

**Interfaces:** `inspectRelease(config, expectedDigest, files): Promise<ReleaseEvidence>`; `preview(config, expectedDigest, inspector): Promise<Preview>`. `ReleaseEvidence` contains only verified digest/source/lock identity and fixed relative entries, never secret bytes. `Inspector` exposes `host()`, `account()`, `release()`, `installation()`, `ports()` and `plistValidity()` as read-only functions; it has no write/start/secret-use method.

- [ ] **Step 1 — failing test with zero-mutation evidence.** Add a test-only `makeInspector(overrides)` returning deterministic inspection results plus a `reads` trace. Its default fixture is supported native Mac, existing non-admin account, empty installation and free ports; do not package it in `dist`.

```ts
import { expect, it } from 'vitest';
import { preview } from './preflight.js';
import { labConfig, makeInspector } from './test-support/fixtures.js';
it.each(['x64', 'unsupported'] as const)('refuses %s without an install action', async arch => {
  const inspector = makeInspector({ arch });
  const result = await preview(labConfig(), 'a'.repeat(64), inspector);
  expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_HOST' });
  expect(inspector.reads).not.toContain('credential');
});
it('does not authorize an occupied unowned port', async () => {
  const inspector = makeInspector({ corePort: 'foreign' });
  expect(await preview(labConfig(), 'a'.repeat(64), inspector))
    .toMatchObject({ ok: false, code: 'PORT_IN_USE' });
});
```

Pin tests for UID 0, admin group membership, missing account, unknown membership, malformed metadata, wrong digest, foreign plist/job, mixed enabled state, and harmless already-owned running ports. To prove read-only behavior on real filesystem adapters, hash the complete fixture tree before/after; deny access to secret fixture files and confirm preview still never opens them. Do not run a staged binary just to discover its version during preview.

- [ ] **Step 2 — RED.** `pnpm --filter @gram/macos-lifecycle test -- src/preflight.test.ts src/release-inspection.test.ts`. Expected: exact refusal or zero-mutation assertions fail on a nonimplementing adapter, not a missing test fixture.

- [ ] **Step 3 — implement inspection.** Account discovery uses exact `gram-agent` resolution and complete group membership through fixed local OS calls; missing or unparseable output is ACCOUNT_INVALID. A home-directory basename is not an account lookup. Preview compares process architecture/version; it does not claim physical hardware type from x64 Node.

Release manifest schema contains `schemaVersion`, `releaseId`, `sourceCommit`, `lockDigest`, `files` (relative path, SHA-256, executable flag or internal link target), `coreTools: ['agent_health']`, `schemaCompatibility`, and optional tunnel compatibility identity. The independently supplied digest anchors exact manifest bytes; file inventory/hash validation then anchors the bundle. The manifest and inventory may contain no absolute caller-provided execution target. Fixed entries are `bin/node`, `apps/agent/dist/main.js`, lifecycle supervisors, and optional `bin/tunnel-client`. Reject extra executable entries outside the reviewed inventory, escaping/looping symlinks, hardlinked sensitive files, group/world writes and effective ACL write grants. Internal pnpm links may resolve only within the same sealed release. No root build/download/extraction is added.

Use open-file-descriptor checks rather than a `stat`-then-`readFile` decision. The narrow file reader has a maximum byte count and checks regular-file type, owner, mode, link count, device/inode consistency and ACL policy. All mutable directories have fixed admin-owned parents; operations never traverse a runtime-controlled ancestor. O_NOFOLLOW alone is not claimed to protect every ancestor. Native metadata inspection that cannot establish ACL/owner safety returns UNSAFE_PATH.

Implement the explicit first refusal as a pure helper in `preflight.ts`; tests vary each boolean independently. Collect these facts from the real inspector, never from CLI booleans:

```ts
export interface PreflightFacts {
  nativeMac: boolean; node24: boolean; validAccount: boolean;
  trustedRelease: boolean; safePaths: boolean;
  ownedInstallation: boolean; freeOrOwnedPorts: boolean;
}
export function firstRefusal(f: PreflightFacts): SafeCode {
  if (!f.nativeMac || !f.node24) return 'UNSUPPORTED_HOST';
  if (!f.validAccount) return 'ACCOUNT_INVALID';
  if (!f.trustedRelease) return 'UNTRUSTED_RELEASE';
  if (!f.safePaths) return 'UNSAFE_PATH';
  if (!f.ownedInstallation) return 'FOREIGN_SERVICE';
  if (!f.freeOrOwnedPorts) return 'PORT_IN_USE';
  return 'OK';
}
```

Import `SafeCode` from `contracts.ts`. This helper does not establish the facts or replace descriptor/ACL checks; adapters own that evidence.

Preview digest covers normalized config, verified release identity and current-installation digest. It is a review token, not a file-system capability. `preview` never loads a key, initializes SQLite, writes an output file, calls launchctl mutate operations, or contacts a tunnel.

- [ ] **Step 4 — GREEN.** Run new file-security/preflight tests with temp trees containing spaces, symlinks, hardlinks, oversized/truncated files, permission/ACL mismatch and path replacement between observations. Run package checks and root tests. Native ACL assertions are explicitly skipped on Linux, never reported as native success.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle && git commit -m 'feat(macos): inspect sealed releases and preview without mutations'`.

### Task 3: Persistent circuit, generations and safe event storage

**Files:** Create `circuit.ts`, `lifecycle-store.ts`, their tests and safe-file persistence in `adapters/service-files.ts`.

**Interfaces:** `recordExit(history, nowMs, intentional): CircuitHistory`; `beginAttempt(history, generation, nowMs): CircuitHistory`; `recoverAttempt(history, nowMs): CircuitHistory`; `resetFailure(history, generation, nowMs): CircuitHistory`. Store methods `read(role)`, `write(role, history)`, `writeStatus(role, status)`, `appendEvent(role, event)` use fixed file names only.

- [ ] **Step 1 — write pure state tests.** Define `CircuitHistory` as `{schemaVersion:1, blocked:boolean, lastSeenMs:number, exitsMs:number[], activeAttempt: null | {generation:string, startedAtMs:number}}`. Test fresh history plus five unexpected exits, exact five-minute boundary, an intentional stop, clock reversal, nonfinite/future input, truncated file, duplicate generation, and a hard-kill leaving the active marker.

```ts
import { expect, it } from 'vitest';
import { recordExit, beginAttempt, recoverAttempt, type CircuitHistory } from './circuit.js';
it('keeps a five-exit circuit blocked across a later restart', () => {
  let h: CircuitHistory = { schemaVersion: 1, blocked: false, lastSeenMs: 0,
    exitsMs: [] as number[], activeAttempt: null };
  for (const t of [1000, 2000, 3000, 4000, 5000]) h = recordExit(h, t, false);
  expect(h.blocked).toBe(true);
  expect(recoverAttempt(h, 900000).blocked).toBe(true);
});
it('counts the unclosed prior attempt once', () => {
  const h = beginAttempt({ schemaVersion: 1, blocked: false, lastSeenMs: 0,
    exitsMs: [], activeAttempt: null }, 'gen-1', 1000);
  const recovered = recoverAttempt(h, 2000);
  expect(recovered.exitsMs).toEqual([2000]);
  expect(recoverAttempt(recovered, 3000).exitsMs).toEqual([2000]);
});
```

- [ ] **Step 2 — RED.** Run `pnpm --filter @gram/macos-lifecycle test -- src/circuit.test.ts src/lifecycle-store.test.ts`; observe the missing persistent-block/one-time-accounting behavior.
- [ ] **Step 3 — implement pure accounting, then storage.** Keep exits where `0 <= nowMs - exitMs < 300000`; the fifth exit sets a sticky block. Time reversal/nonfinite/future history becomes INVALID_HISTORY and stays blocked. Only explicit reset clears it. Persist the active marker before spawn. Normal termination clears it; an unclosed prior marker becomes one unexpected exit before the next spawn. A supervisor's own unobserved crashes therefore cannot erase its retry budget.

The pure exit-accounting kernel, after strict history validation, is:

```ts
export function recordExit(h: CircuitHistory, nowMs: number, intentional: boolean): CircuitHistory {
  const invalid = !Number.isFinite(nowMs) || nowMs < h.lastSeenMs ||
    h.exitsMs.some(t => !Number.isFinite(t) || t < 0 || t > nowMs);
  if (invalid) return { ...h, blocked: true };
  const exitsMs = h.exitsMs.filter(t => nowMs - t < 300000);
  if (!intentional) exitsMs.push(nowMs);
  return { schemaVersion: 1, lastSeenMs: nowMs, activeAttempt: null,
    exitsMs, blocked: h.blocked || exitsMs.length >= 5 };
}
```

The caller records INVALID_HISTORY when the validation branch blocks; raw parse errors never enter status. `beginAttempt` refuses an existing active marker or blocked history, and writes the new generation/time before spawn. `recoverAttempt` clears/counts a prior active marker with `recordExit`; a second recovery sees null and changes no exit count. `resetFailure` is reachable only after Task 6's stopped/authorized reset path, never elapsed time alone.

Write status/history by bounded O_EXCL temporary file in the fixed directory, sync file, atomically rename, and sync the directory where supported. Reject unexpected existing owner/link/type and never truncate a foreign file. A failed durability operation is not success. Parse strictly with max 64 KiB. Corrupt history blocks; absent history is fresh only for a verified new installation. Reinstall does not reset existing circuits.

Events accept only role, generation, fixed SafeCode, time, attempt count and validated release identity. Drop arbitrary fields/messages. Rotate before exceeding 5 MiB; retain current plus two prior files. Drain/discard a child's byte streams; do not attempt to redact every possible secret-shaped string after storing raw bytes. Test fragmented fake secrets, environment-shaped strings and oversized chunks with zero occurrence in all persisted files.

- [ ] **Step 4 — GREEN.** Run package/root checks, fault-inject failed writes/rename/fsync and reload after each interruption. Verify log bounds and no executable operation in the pure state module.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle && git commit -m 'feat(macos): persist restart circuits and generation-bound safe status'`.

### Task 4: Owned connections and bounded authenticated core health

**Files:** Create `health-probe.ts`, `adapters/owned-process.ts`, `adapters/loopback-http.ts`, `platform/macos/native/peer-owner.c` and corresponding tests.

**Interfaces:** `OwnedProcessPort.spawnCore(config): Promise<OwnedChild>`; `owns(child): Promise<boolean>`; `stop(child, deadlineMs): Promise<Result>`. `openOwnedConnection(child, port:3847|8080): Promise<OwnedConnection|null>` creates a paused TCP connection without auth bytes and checks the exact accepted peer tuple. `OwnedConnection.request` permits only fixed health/MCP requests on that same socket, bounded size/time and no reconnect. `probeCore(child, connections, credentials): Promise<CoreEvidence>` returns fixed fields/status, never raw bodies/secrets. `CoreEvidence` binds child generation/release and observation time.

- [ ] **Step 1 — failing ordering and body tests.** Test-only `makeHealthPorts` creates a byte-recording owned/foreign peer fixture and a call trace; it does not implement the evaluator's health decision.

```ts
import { expect, it } from 'vitest';
import { probeCore } from './health-probe.js';
import { ownedChild, makeHealthPorts } from './test-support/fixtures.js';
it('sends no auth bytes to an unknown peer that returns 200', async () => {
  const f = makeHealthPorts({ peer: 'foreign', healthStatus: 200 });
  expect((await probeCore(ownedChild(), f.connections, f.credentials)).state).not.toBe('LOCAL_CORE_HEALTHY');
  expect(f.secretUses).toBe(0);
  expect(f.authenticatedRequests).toHaveLength(0);
});
it('blocks a broader core tool surface', async () => {
  const f = makeHealthPorts({ peer: 'owned', tools: ['agent_health', 'task_create'] });
  expect(await probeCore(ownedChild(), f.connections, f.credentials))
    .toMatchObject({ code: 'TOOL_SURFACE_MISMATCH' });
});
```

Add malformed/empty/oversized/trickled bodies, HTTP redirects, wrong JSON-RPC ID, MCP error, isError tool result, duplicate/extra tools, paginated tool list, nonhealthy DB/MCP values, peer death/rebind and context switch between calls. `agent_health` must parse to the actual source shape `{status:'healthy',database:'ok',mcp:'ready'}`.

- [ ] **Step 2 — RED.** Run the health/connection/ownership tests. A server that answers 200 is intentionally insufficient. Confirm the foreign listener's captured stream contains no synthetic auth token.
- [ ] **Step 3 — implement ownership before credentials.** Record a direct ChildProcess handle plus PID, UID, process start identity and sealed executable identity. For the native peer helper, use the installed Apple SDK's libproc process/FD/socket information to match the server-side established socket against the already-open client local/remote tuple, and the child PID/start identity. Return a closed enum: OWNED, FOREIGN, UNKNOWN. PID-only or listening-port-only matches are insufficient. If permissions/SDK/OS prevent that proof, return UNKNOWN and send nothing authenticated. Compile this read-only helper without setuid/root; its binary is part of the sealed inventory. Its arguments contain only numeric identity and fixed loopback tuple, not credentials or arbitrary commands.

Keep the checked connection open for the HTTP request; do not fall back to fetch/another connection after verification. Recheck the same owned generation immediately before obtaining the local synthetic credential. A peer closing the connection yields UNKNOWN, never an authenticated retry to a replacement listener. Unit tests simulate that race; native tests exercise real socket replacement. This narrows the spec's pre-auth ownership requirement without asserting that any same-user process is a sandbox.

Use Node's HTTP parser on the checked socket, disable connection pooling and redirects, bound headers/body to 64 KiB, and enforce a wall-duration request timer of 2 seconds including slow streaming. Clear listeners/timers and destroy the socket on all exits. Parse JSON or bounded MCP SSE frames according to the negotiated transport. Reject additional events/frames beyond limits; do not save raw protocol bodies.

Keep the healthy-body decision pure in `health-probe.ts` and test it separately from the transport:

```ts
export function validCoreHealth(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'database,mcp,status' &&
    v.status === 'healthy' && v.database === 'ok' && v.mcp === 'ready';
}
export interface CoreEvidence {
  state: 'LOCAL_CORE_HEALTHY' | 'UNKNOWN' | 'BLOCKED';
  code: SafeCode; generation: string; releaseDigest: string; observedAtMs: number;
}
```

Import `SafeCode` from `contracts.ts`. Any source-schema addition requires explicit fixture/contract review; it is not accepted by ignoring unknown response fields. `validCoreHealth` is only one condition: ownership, current generation, MCP authentication and exact tool surface must also pass.

MCP sequence: initialize with a supported pinned protocol fixture, validate negotiated version, send initialized notification, tools/list with exact one-tool allowlist and no continuation cursor, then tools/call `agent_health`. Check JSON-RPC IDs/results and current ownership on every newly opened connection. Compatibility with the repository's pinned MCP implementation must be demonstrated by `verify-core.mjs`; do not invent a protocol version from a date or use arbitrary request headers from configuration.

- [ ] **Step 4 — GREEN.** Run all tests/lint/typecheck/build, root suite, and on native Mac compile the helper and exercise ownership of actual fixture children/sockets. UNKNOWN due to a missing helper is a safe failure, not native acceptance. No live tunnel or secret is required.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle platform/macos/native && git commit -m 'feat(macos): verify owned peers before authenticated core health'`.

### Task 5: Fixed-role supervisors and compatible test-tunnel startup

**Files:** Create `supervisor.ts`, `supervisor-cli.ts`, supervisor tests; extend only new owned-process/health adapters and safe stores.

**Interfaces:** `runSupervisor(role, config, deps, signal): Promise<number>`, consuming Task 3 stores/clock and Task 4 owned-process/health ports. `TunnelCompatibility` is a verified manifest digest binding binary/version, config schema, fixed argument template, response recognizers and restricted test scope. `TunnelPort.spawn(config, compatibility, coreEvidence)` accepts no arbitrary executable/URL/header and returns `OwnedChild`.

- [ ] **Step 1 — write state-machine tests.** Test fixture ports record spawn/stop actions; clock advancement is explicit. Assertions target lifecycle state and effects, not mocked method return values.

```ts
import { expect, it } from 'vitest';
import { runSupervisor } from './supervisor.js';
import { labConfig, makeSupervisorFixture } from './test-support/fixtures.js';
it('waits for core without spawning a tunnel on an expired generation', async () => {
  const f = makeSupervisorFixture({ role: 'tunnel', coreEvidence: 'stale' });
  await f.runUntil(61000, () => runSupervisor('tunnel', labConfig(true), f.deps, f.signal));
  expect(f.spawned).toEqual([]);
  expect(f.retryDelays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
});
it('does not restart the core during a network outage', async () => {
  const f = makeSupervisorFixture({ role: 'tunnel', transport: 'offline' });
  await f.runUntil(70000, () => runSupervisor('tunnel', labConfig(true), f.deps, f.signal));
  expect(f.coreSpawns).toBe(0);
});
```

Also test five exits including prior unclosed attempt; configuration error; no credential; credential rejection; ambiguous transport health; start-before-core; core generation replacement; SIGTERM during wait/probe/spawn; intentional stop excluded from crash count; blocked process remaining idle rather than respawning children; force stop targeting only the recorded owned child. Create `makeSupervisorFixture` with explicit fake-clock timer queue, real circuit transitions and byte-recording child streams; do not hide policy in the fixture.

- [ ] **Step 2 — RED.** Run supervisor tests before its implementation. Observe forbidden spawn/retry decisions fail.
- [ ] **Step 3 — implement the two roles.** Install abort handling before any dependency wait. Core role validates LAB_ONLY sealed release, persists attempt, starts the fixed health-only entry under the existing non-admin identity, and establishes health within 60 seconds. It emits fresh generation-bound state on a 5-second cadence. On failure it records circuit history before exit; launchd restarts the supervisor. An exhausted/invalid circuit leaves the supervisor alive but idle until local reset.

Implement the dependency delay as a bounded pure function in `supervisor.ts`, with explicit tests for attempts 0–9 and invalid counters:

```ts
export function dependencyDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('INVALID_HISTORY');
  return [1000, 2000, 4000, 8000, 16000][attempt] ?? 30000;
}
```

Clamp each actual sleep to the remaining core startup deadline; install abort handling before sleep. Backoff does not extend a 60-second core-start deadline indefinitely.

Tunnel role defaults DISABLED. If enabled, require independently reviewed compatibility and locally provisioned restricted test credential; no creation or broadening of tunnel permissions. The existing `run --config` YAML shape is a candidate contract, not a universally supported binary interface. Missing compatibility returns TUNNEL_COMPATIBILITY_REQUIRED. Tests use synthetic providers; real credentials are loaded only inside the narrow child-launch path after all gates.

Child environment is constructed from an allowlist, not `{...process.env}`. Core receives only required state/secret directory paths and minimal nonsecret execution variables. Tunnel receives its configured environment references and fixed health/config paths; control-plane key goes only into that child's environment, not plist/argv/logs/core. Never source an env file as shell code. Verify unexpected inherited variables such as NODE_OPTIONS, DYLD_INSERT_LIBRARIES, HTTP_PROXY and arbitrary tokens are absent.

On core loss, stop the owned tunnel immediately after detection; do not claim zero detection latency or undo an already delivered request. Keep the LAB_ONLY tool surface so no business write exists during that interval. A new core generation requires fresh authentication and tool-surface verification. Network loss alone does not kill/restart core; explicit credential rejection blocks repeated key attempts. Unknown provider response remains UNKNOWN.

On shutdown, cancel waits/probes, persist intentional stop, SIGTERM the owned child, then after at most 20 seconds force only a revalidated owned child/process group. Do not detach children with a new session to escape launchd cleanup. Native supervisor-death cleanup is an acceptance condition: a surviving/unidentifiable child blocks a new spawn rather than being killed by port number.

- [ ] **Step 4 — GREEN.** Run state-machine suite/root checks plus native fixture-child shutdown tests. Verify no raw output survives and both the active marker and circuit persist through forced termination. Separate provider simulation from actual tunnel evidence.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle && git commit -m 'feat(macos): supervise lab core and gated test transport with bounded recovery'`.

### Task 6: Journaled apply, rollback and data-preserving uninstall

**Files:** Create `install-service.ts`, `local-control.ts`, `adapters/launchctl.ts`, transaction tests; extend new service-file adapters.

**Interfaces:** `apply(preview, config, ports): Promise<Result>`; `rollback(targetDigest, ports): Promise<Result>`; `control(action, ports): Promise<Result>`, where action is only `start|stop|restart|reset-failure|uninstall`. `InstallPorts` supplies `authorizeLocalAdmin()`, `lock()`, `revalidate()`, `readPrior()`, `journal()`, `publish()`, `restore()`, `services()`, `readClosedSchema()`; none is exported as an unrestricted CLI/MCP primitive. Lock is released in finally after durable result recording.

- [ ] **Step 1 — transaction tests with byte snapshots.** `makeInstallFixture()` supplies in-memory or temporary owned files, a deterministic interruption point and an event trace. Mutation methods operate on actual byte arrays/files, not booleans claiming success.

```ts
import { expect, it } from 'vitest';
import { apply, rollback } from './install-service.js';
import { labConfig, makeInstallFixture } from './test-support/fixtures.js';
it('rejects a changed preview before writing or stopping anything', async () => {
  const f = makeInstallFixture({ changedAfterPreview: true });
  const before = f.snapshotBytes();
  expect(await apply(f.preview, labConfig(), f.ports)).toMatchObject({ code: 'CONFIG_CHANGED' });
  expect(f.snapshotBytes()).toEqual(before);
  expect(f.serviceMutations).toEqual([]);
});
it('does not revert an executable onto an unknown migrated schema', async () => {
  const f = makeInstallFixture({ closedSchema: 'unknown' });
  const db = f.databaseBytes();
  expect(await rollback('b'.repeat(64), f.ports)).toMatchObject({ code: 'ROLLBACK_BLOCKED_SCHEMA' });
  expect(f.databaseBytes()).toEqual(db);
  expect(f.startedPreviousRelease).toBe(false);
});
```

Parameterize interruption before/after every journal stage, concurrent apply, duplicate apply, foreign-plist replacement between reads, partial previous install, bootstrap failure, unknown launchctl output, disabled desired state, compatible rollback and uninstall twice. Every failure preserves state/secret/release bytes. An unchanged apply is a no-op only if the installed job/configuration and desired state also match; identical input alone is insufficient.

- [ ] **Step 2 — RED.** Run transaction and launchctl tests, confirming stale apply, foreign resources and uncertain rollback are refused.
- [ ] **Step 3 — implement transactions in this exact ordering:**

```text
authorize local OS admin
 -> acquire fixed admin-owned installation lock
 -> read/revalidate configuration, reviewed release, prior installation and desired state
 -> reject stale preview / foreign object / conflicting operation
 -> write PREPARED journal with old/new digests and exact owned inventory
 -> disable/bootout tunnel, then core; verify owned processes gone
 -> write STOPPED journal
 -> stage and validate new files on each target's same filesystem
 -> write FILES_STAGED journal
 -> atomically publish owned configuration/plists with per-file progress journal
 -> write PUBLISHED journal
 -> enable/bootstrap core; verify owned authenticated LAB_ONLY health
 -> bootstrap tunnel only if enabled and compatible
 -> write STARTED then COMMITTED journal and final installation manifest
 -> release lock
```

No multi-file atomicity is claimed: journal and idempotent recovery cover the gaps between file renames. Root-owned config/journal inventory can name only generated fixed files. Preserve previous manifest/files/enabled flags; no journal-controlled arbitrary path write or delete. A crashed operation leaves PARTIAL_INSTALL, and status remains read-only. A subsequent authorized command first reconciles the journal; it does not assume a stale lock is safe to delete from PID absence alone. Verify lock owner start identity and journal before recovery, or return BUSY.

Use exact `/bin/launchctl` vectors for fixed system labels: enable/bootstrap, disable/bootout, and print for inspection. Never use `killall`, a PID scraped solely from a port, arbitrary user arguments, or broad cleanup. Native adapter must distinguish an absent job from permission/parse/OS errors; nonzero output is not automatically "already stopped". Stop disables before bootout and verifies absence; restart restores the intended enabled state. Uninstall removes only manifest-owned matching plists after stopping, and preserves state, credentials, run history, releases and logs; there is no purge flag.

The existing core migrates on startup. Rollback reads `schema_migrations` from the lab DB in read-only mode only after owned core is stopped; never invoke a release's migration function as a compatibility probe. The candidate reviewed release declares acceptable applied-version sets, and the actual complete set must match. Missing/corrupt metadata, failed DB close or unverified candidate means ROLLBACK_BLOCKED_SCHEMA. An absent never-opened DB is distinct from an existing unreadable one. Do not copy an active SQLite/WAL pair, delete the DB, or trust only SQLite user_version. Keep both release configurations stopped if safe rollback cannot be proven.

Use an explicit pure compatibility predicate, covered by tests for extra/missing/duplicate/noninteger versions, before any executable rollback:

```ts
export function schemaCompatible(actual: unknown, accepted: readonly (readonly number[])[]): boolean {
  if (!Array.isArray(actual) || !actual.every(v => Number.isSafeInteger(v) && v > 0)) return false;
  const versions = actual as number[];
  if (new Set(versions).size !== versions.length) return false;
  const key = [...versions].sort((a, b) => a - b).join(',');
  return accepted.some(set =>
    set.every(v => Number.isSafeInteger(v) && v > 0) &&
    new Set(set).size === set.length &&
    [...set].sort((a, b) => a - b).join(',') === key);
}
```

This consumes versions read from `schema_migrations` and the independently trusted release policy. It does not prove safe DB closure, migration compatibility or release provenance by itself. A missing DB has its own pre-first-start case and is not represented as an unreadable empty list.

For reset-failure, stop relevant fixed jobs and invoke a sealed, narrow reset helper as the resolved runtime account, without supplementary administrative groups; then revalidate and start only as previously desired. Do not replace service-owned history with a root-owned file that the supervisor cannot update. The native identity transition and fixed argv need explicit tests; no general user-switch shell API is exposed.

- [ ] **Step 4 — GREEN.** Run failure injection at every boundary, root suite, native disposable apply/stop/reapply/rollback/uninstall tests after local-native test authorization. Native tests never target personal state or a preexisting foreign install. Record skipped privileged tests separately.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle && git commit -m 'feat(macos): apply owned service transactions and preserve state on rollback'`.

### Task 7: Local CLI, sealed packaging and honest lifecycle status

**Files:** Create `diagnostic.ts`, `cli.ts`, package index exports, CLI tests, `platform/macos/package-release.mjs`, core verification script and initial operations runbook.

**Interfaces:** `runCli(argv, deps): Promise<number>`; `projectStatus(evidence): LifecycleReport`. Report contains schemaVersion, mode, per-role state/fixed code/generation/release identity, observation age, and `businessReadiness: 'UNAVAILABLE'`. It contains no full paths, usernames, UID/PID values, raw exception/provider response, credential references or arbitrary input text.

- [ ] **Step 1 — failing CLI tests.** No arguments means read-only `preview --json`. Named preview/status actions use --json; administrative actions require the sealed installed CLI, actual OS authorization, a configuration reference and expected configuration/current-install digest. Unknown/duplicate flags, arbitrary roles, labels, ports, URLs, commands and secret arguments fail before privileged ports or credential reads.

```ts
import { expect, it } from 'vitest';
import { runCli, projectStatus } from './diagnostic.js';
import { makeCliFixture, healthyLabEvidence } from './test-support/fixtures.js';
it('has no implicit apply or secret use in the default action', async () => {
  const f = makeCliFixture();
  await runCli([], f.deps);
  expect(f.actions).toEqual(['preview']);
  expect(f.secretUses).toBe(0);
});
it('reports lab health without claiming shopping capability', () => {
  expect(projectStatus(healthyLabEvidence())).toMatchObject({
    mode: 'LAB_ONLY', businessReadiness: 'UNAVAILABLE',
  });
});
```

Add fixed-error output tests for exception messages containing fake tokens/paths, stale or malformed status, wrong boot/generation/child, and process present with no owned connection. Supported CLI exit contract: 0 = requested local operation completed (not business readiness), 2 = unavailable/refused precondition, 64 = invalid usage, 70 = fixed internal failure; no raw thrown value.

- [ ] **Step 2 — RED.** Run diagnostic tests and compiled CLI smoke test; distinguish absent entry-point errors from failing argument/output assertions.
- [ ] **Step 3 — implement pure output projection and explicit command routing.** Argument parsing never accepts secret values. `status` neither repairs journals nor restarts a job. Dispatch only exact local-control methods. All outer catches map errors to known SafeCode or INTERNAL_ERROR. Supervisors have a separate private entry point; they cannot become a generic administrative command runner.

Keep the output envelope allowlisted rather than serializing internal adapter objects. The status projector consumes validated lifecycle evidence; before using generation/release values, validate their fixed syntax and current ownership, otherwise replace them with null:

```ts
export interface PublicRoleStatus {
  state: string; code: SafeCode; generation: string | null;
  releaseDigest: string | null; ageMs: number | null;
}
export interface LifecycleReport {
  schemaVersion: 1; mode: 'LAB_ONLY';
  core: PublicRoleStatus; tunnel: PublicRoleStatus;
  businessReadiness: 'UNAVAILABLE';
}
export function reportEnvelope(core: PublicRoleStatus, tunnel: PublicRoleStatus): LifecycleReport {
  const copy = (s: PublicRoleStatus): PublicRoleStatus => ({
    state: s.state, code: s.code, generation: s.generation,
    releaseDigest: s.releaseDigest, ageMs: s.ageMs,
  });
  return { schemaVersion: 1, mode: 'LAB_ONLY', core: copy(core), tunnel: copy(tunnel),
    businessReadiness: 'UNAVAILABLE' };
}
```

`projectStatus` validates role state against the spec's exact role enums before calling this kernel, so arbitrary strings from a child are not reportable state. Add the fixed `SafeCode` import; no raw error-body spread is permitted.

Packaging runs unprivileged from a clean verified build. Inventory contains the compiled lifecycle code, Node binary, the existing core/runtime dependencies and native peer helper; exclude tests, credentials, `.git`, user configs, caches and task DBs. Preserve only internal validated dependency links. Produce a canonical manifest/digest for independent review, not an executable root installer that downloads/builds arbitrary code. Staging the reviewed bundle into admin-owned immutable locations is a separate local administrative procedure, with owner/mode/ACL revalidation before execution. Packaging does not automatically install, sign, authorize TCC or create accounts.

`verify-core.mjs` imports the built existing core from the checked-out repository for an ephemeral, synthetic-credential localhost integration test; it exercises the actual health/MCP flow and closes resources in finally. It does not modify `apps/agent`. Native fixed-port tests run serially and refuse an occupied port. A broader tool surface fails closed; never remove tools from the probe output to make it match.

- [ ] **Step 4 — GREEN.** Run package/root checks and compiled CLI commands. Test package inventory links/hash changes and absent SDK/binary compatibility. Confirm `preview/status` leave fixture files unchanged and no report claims FileVault lock merely from host unreachability.
- [ ] **Step 5 — commit.** `git add packages/macos-lifecycle platform/macos docs/operations/macos-service-lifecycle.md && git commit -m 'feat(macos): expose safe local lifecycle controls and sealed lab packaging'`.

### Task 8: Integration, native acceptance and final review evidence

**Files:** Create `integration.test.ts`, `architecture.test.ts`, `native.test.ts`, native fixture scripts, `.github/workflows/macos-lifecycle.yml`; finish the operations runbook.

**Interfaces:** Test-only native adapters must exercise the same production parser/state/ownership logic. The native fixture script uses a disposable installation only after proving no existing fixed-label deployment is present; it never uses a production bypass flag. An inability to obtain native safety preconditions is an explicit not-run/refusal result.

- [ ] **Step 1 — pin architecture and evidence assertions before workflow/native harness implementation.** Assert root collection includes `macos-lifecycle`, its empty suite fails, business readiness is always unavailable, no application orchestration is imported into adapters, and pure config/circuit modules cannot import filesystem/process/network helpers. Forbid generic shell commands, alternate tunnel clients, test fixture imports in production and broad secret-reading exports.

Add workflow tests that require `permissions: contents: read`, `persist-credentials: false`, no pull_request_target, and explicit Linux/Mac jobs with native arm64 verification. Integration cases replay the 17-row spec matrix below and assert actual state/files/output, not merely that a named test exists.

- [ ] **Step 2 — RED.** Run the new package tests and observe the absent integration/workflow behavior. Native assertions only count as RED/GREEN if executed on native hardware.
- [ ] **Step 3 — add a read-only exact-head workflow.** Preserve `.github/workflows/ci.yml` unchanged. Use this job outline and explicit native commands; stage no live credentials and publish no repository changes:

```yaml
name: macos-lifecycle
on:
  pull_request:
    paths: ['packages/macos-lifecycle/**', 'platform/macos/**', 'pnpm-lock.yaml', '.github/workflows/macos-lifecycle.yml']
permissions:
  contents: read
jobs:
  lifecycle:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Isolated exact-head verification
        shell: bash
        run: |
          set -euo pipefail
          git worktree add --detach "$RUNNER_TEMP/mac02" HEAD
          cd "$RUNNER_TEMP/mac02"
          pnpm install --frozen-lockfile
          pnpm --filter @gram/macos-lifecycle test
          pnpm --filter @gram/macos-lifecycle lint
          pnpm --filter @gram/macos-lifecycle typecheck
          pnpm build
          pnpm exec vitest run --project macos-lifecycle
          pnpm test
          git diff --check
      - name: Native arm64 and disposable fixture checks
        if: runner.os == 'macOS'
        shell: bash
        run: |
          set -euo pipefail
          cd "$RUNNER_TEMP/mac02"
          node -e "if(process.platform!=='darwin'||process.arch!=='arm64')process.exit(1)"
          python3 platform/macos/tests/verify-plist.py
          node platform/macos/tests/verify-core.mjs
          node platform/macos/tests/native-launchd.mjs --fixture-only
```

The fixture flag belongs only to the test script, never the production CLI. Script checks for a disposable hosted environment, explicit test-mode authorization and no existing installation before any administrative effect; otherwise exits with a clearly recorded NOT_RUN result and does not pass its native acceptance gate. Read-only workflow permission does not itself authorize mutation on a user's Mac.

`verify-plist.py` parses emitted XML with `plistlib`, compares exact argv elements/keys, and invokes `/usr/bin/plutil -lint` on native Mac. It tests spaces/metacharacters and verifies no secret/env interpolation. `native-launchd.mjs` verifies admin-owned fixtures, actual non-admin process UID, bounded child shutdown/restart and no orphan after supervisor kill, stop persistence, port refusal and rollback/uninstall retention. On Linux run portable tests only; no simulated native acceptance. Real reboot/logout and actual OpenAI transport validation remain the separately authorized user-device/test-tunnel gates, not automatic CI steps.

- [ ] **Step 4 — full GREEN and boundary inspection.** Run root lint/typecheck/test/build, package collection, native jobs and compiled CLI, record counts/versions/commit and every failed/skipped test. Compare base-to-head changes to the exact budget. No other branch/ref is changed. Requery CI for the final exact head, and distinguish root synthetic-merge preview from exact-head matrix.
- [ ] **Step 5 — final review and handoff.** Request an independent review of privileged path handling, socket identity, child environment/output, journal recovery and schema rollback. If that reviewer is unavailable, record NOT_PERFORMED and keep Draft; do not write an independent approval. Commit the final allowed paths with `git add packages/macos-lifecycle platform/macos .github/workflows/macos-lifecycle.yml docs/operations/macos-service-lifecycle.md && git commit -m 'test(macos): verify service lifecycle and record native acceptance gates'`. Push only the feature branch, confirm remote SHA, then create/update its Draft PR. Do not merge, force-push, close Windows issues or apply on the user's Mac.

## 4. Complete requirement and acceptance mapping

All results below are **NOT_RUN** at planning time. Task numbers identify implementation ownership; they are not claims of executed coverage.

| ID | Spec acceptance case | Requirements | Task / required evidence |
|---|---|---|---|
| A01 | macOS x64 / unsupported OS / invalid Node | L03, L11 | T1–2: refusal and identical filesystem snapshot |
| A02 | Path spaces/XML metacharacters/escaping links | L03, L04 | T1–2, T8: exact argv/plist parse; file/link/ACL refusal |
| A03 | Missing/admin runtime account | L02 | T2, T8: no spawn; actual UID/non-admin inspection |
| A04 | Preview/apply digest race and concurrent applies | L03, L10 | T2, T6: stale/busy before mutation; native lock/journal |
| A05 | Foreign plist/job/port | L04, L06 | T2, T4, T6: no overwrite/kill/auth bytes |
| A06 | Empty/malformed health and unauthenticated 200 | L08 | T4: bounded schema + real MCP identity/tool checks |
| A07 | Stale/rebooted status or wrong child/release | L08 | T3–5, T7: current owned-generation check; unknown otherwise |
| A08 | Tunnel before core/core death/internet outage | L07, L08 | T5: bounded waits, exact-generation switch, no core storm |
| A09 | Credential rejection and secret-bearing child output | L06, L07 | T3–5, T7: blocked retry and zero secret occurrence |
| A10 | Five crashes, supervisor kill, stop then reboot | L04, L07 | T3, T5–6, T8: durable circuit, actual orphan/disabled-state tests; reboot is user-device gate |
| A11 | Partial install and compatible/incompatible rollback | L10 | T6: crash-point journal replay; closed-schema check; DB retention |
| A12 | Duplicate apply/uninstall with lab state | L03, L10 | T6: idempotence and byte-preserved DB/credentials/releases |
| A13 | LAB_ONLY tool-surface mismatch | L01, L05, L12 | T4–5, T7: actual tools/list exact allowlist; no wider core launch |
| A14 | Healthy core without isolation/GUI/vault evidence | L05, L08 | T7–8: businessReadiness UNAVAILABLE, not guessed READY |
| A15 | Root regression suite and branch diff | L01, L11 | T8: exact test output, allowed diff, unchanged other refs |
| A16 | Native hosted-Mac plist/process tests | L07, L11 | T4, T8: native arm64/socket/launchd evidence, distinct from user's Mac |
| A17 | User-Mac logout/reboot/reconnect | L09, L11 | T8 deployment gate: explicit authorization, actual device/test-state evidence |

L12 also has architecture tests in T8 proving no competing Task Engine, scheduler or vault module is introduced. The MAC-01 adapter remains a post-integration boundary rather than being silently copied.

## 5. Planning choices and unresolved platform inputs

The spec supplies the high-level constraints; the following are explicit planning refinements for review, not source facts or already working components:

- Fixed versioned JSON configuration with SHA-256 preview/install tokens; release IDs and schema validation above.
- A checked, already-connected socket instead of a separate pre-auth port check, to avoid reconnecting to a replaced listener.
- Read-only nonprivileged native peer inspection built into the sealed bundle; absence/inconclusive ownership blocks authentication.
- Standard output/error discarded by launchd; only fixed-schema rotated events written by supervisors.
- An active-attempt record before spawn makes supervisor hard-kill visible to the restart circuit.
- Read-only closed-DB `schema_migrations` inspection, not `user_version`, reflects the actual repository migration source.
- Separate lifecycle reports with business readiness unavailable; no direct unmerged MAC-01 dependency.

The installed tunnel binary version, its supported configuration/health schema, exact target macOS build, staged artifact digests and real account UID/GID are not supplied. They are mandatory deployment/test-tunnel inputs. They are not invented, hardcoded from previous logs, or blockers to pure tests. Native SDK ownership and launchctl parsing behavior must be exercised by Task 8; a mock cannot establish them.

## 6. Execution and deployment gates

**Written plan gate:** review this plan, then use the preserved native sequential method. Start Task 1 with failing configuration/plist tests. No live account or administrative access is needed for that start.

**Code gate:** each task has an observed failing assertion, minimal implementation, passing task/root suite, and a recorded commit. Intermediate RED commits may exist only on a clearly Draft feature branch; final head must not substitute an earlier GREEN run. Missing-module failures alone are not counted as full behavioral TDD proof.

**Native gate:** actual arm64 ownership, plist, process and disposable launchd tests must run. If they are blocked, report the exact tests and keep native acceptance incomplete rather than redesigning security around a false pass.

**User-device gate:** operator supplies the verified sealed bundle/config/digests and resolves `gram-agent` account/ports. The user explicitly approves local administrative apply; no FileVault/login/TCC/network settings are changed. Core-only deployment is the default. Restricted real test transport needs its own authorization/compatibility input. Live HAAR work remains outside MAC-02.

**Merge gate:** independent privileged-boundary review and final CI/read-back. No merge authorization is implied by plan execution. Existing PRs #135/#136/#137 remain separate; use no automatic merge to satisfy a dependency.

## 7. Evidence record template and limitations

The implementation runbook must record these fields without secrets or private paths:

```json
{
  "increment": "MAC-02",
  "mode": "LAB_ONLY",
  "implementationHead": null,
  "reviewedSpecCommit": "3b66075d9ef4cf2d7e87416547ea807b43ec856e",
  "unitAndRoot": "NOT_RUN",
  "nativeHostedMac": "NOT_RUN",
  "independentReview": "NOT_PERFORMED",
  "userMacApply": "NOT_RUN",
  "userMacRebootLogout": "NOT_RUN",
  "realTestTunnel": "NOT_RUN",
  "businessOperations": "OUT_OF_SCOPE"
}
```

Null implementation identity here is an explicit not-yet-executed state, not a value to pass into production. Document validation can check this plan's headings, links, JSON/YAML syntax, task contracts and coverage mapping. It cannot prove the embedded code, a future native helper, lifecycle safety or real deployment works. No product-code test was executed in preparing this plan.

## 8. Sources and verification scope

**Requested source:** the MAC-02 written design at the exact commit/blob in the header, supplied in the conversation and confirmed against the connected GitHub copy. Its LAB_ONLY framing, 12 requirements, 17 acceptance rows and numeric limits are preserved.

**Repository reads used in this planning pass:**
- Branch refs and PR #136 state through GitHub, before writing.
- `packages/observability/src/health-service.ts` at main `fdf5dda…`, blob `6c2a8d0c28f9844c31486f28d03ce5c6839a052f`.
- `packages/persistence/src/migrator.ts` at the same main, blob `71c0c0894d82cbe4414cbe8f6ea3488a759328fb`.
- Root `package.json`, blob `6922f15846164f1d9c8e1b5a928829adff2f107f`, and repository tree for exact paths.
- Parent design's source observations about main core/MCP/tunnel are carried as pinned design evidence, not a claim that the production runtime has changed.

**External verification, separate from design decisions:**
- Node24 filesystem docs support descriptor/stat/no-follow building blocks and warn against precheck-then-open races. They do not establish the proposed complete privileged path design: https://r2.nodejs.org/docs/latest-v24.x/api/fs.html
- Apple's archived launchd guide supports fixed plist arguments, daemon/user-session separation and launchd-managed lifecycle. Detailed target SDK/manpage/cleanup acceptance remains a test gate: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- OpenAI's tunnel guide is a provider reference, not proof of an installed Mac binary/schema: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

This planning pass writes only Markdown on `docs/macos-operations-agent-design`. It does not install dependencies on the user's Mac, build a native helper, create a lifecycle feature branch, modify implementation PR #137, request a credential, or run a business operation.
