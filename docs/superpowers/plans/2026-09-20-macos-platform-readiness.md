# MAC-01 Platform Detection and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a read-only, executable platform diagnostic and a fail-closed readiness evaluator that distinguish supported execution targets from unavailable operational capabilities without changing the Windows coding flow.

**Architecture:** Add a self-contained `@gram/platform` package, discovered by the existing pnpm/Vitest workspace globs. Separate pure platform selection, pure readiness evaluation, local host-fact collection, and a secret-free diagnostic CLI. This increment implements no browser, Keychain, service installer, business write, or task scheduler; missing observations remain unknown instead of being inferred from process existence.

**Tech Stack:** The repository's Node `>=24 <25`, pnpm `10.34.5`, TypeScript `^6.0.0`, Vitest `^5.0.0`, Node built-ins, existing ESLint conventions, and a separate macOS arm64 CI workflow. Reuse existing lockfile resolutions; introduce no production dependencies or paid AI API.

**Spec:** `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md`, specifically sections 2–6, 8, 11–15, and the first increment in section 17. Read the parent working design and `docs/operations/2026-09-20-macos-integration-checkpoint.md` before this plan.

**Plan state:** READY FOR USER REVIEW; not executed. The user accepted proceeding from the written design checkpoint to implementation planning. This does not approve this newly written plan, claim that the broader draft's security gates are resolved, or authorize installation, live credentials, merges, or product-code execution.

## Global Constraints

- "Apple Silicon, always-on dedicated Mac. Intel compatibility is outside the initial target."
- "dedicated local non-admin `gram-agent` account"; this diagnostic does not create or audit that account.
- "Do not move existing `systemd/` or `scripts/bootstrap-wsl.sh` in the first Mac change."
- "Do not silently cherry-pick the unmerged M2 implementation."
- "Keep existing coding Task states unchanged until an additive lifecycle design/migration is reviewed."
- "Without an active reasoning client, only already-authorized deterministic local workflows may continue."
- "No additional paid AI API dependency is introduced by this design."
- Preserve localhost-only MCP and OpenAI `tunnel-client`; no new listener or remote transport is added here.
- Preserve secret-free Git/SQLite/log/MCP boundaries; diagnostic JSON must not include usernames, home paths, environment values, credentials, cookies, or arbitrary error text.
- Preserve coding UUIDv7 identity, atomic sequence, Repo Lock, protected-branch policy, remote-confirm/release ordering, and lock-free PR/CI observation. MAC-01 does not modify those modules.
- Readiness is **not authorization**, executor isolation, proof of authentication, or a public security API. It must not execute operations or replace Policy Engine checks.

## Review Focus

1. **Unsupported or ambiguous hosts:** x64 Node on an Apple Silicon Mac, WSL1-like releases, ordinary Linux, malformed versions; never silently call them validated Mac/WSL2 runtimes. Task 1 pins these cases.
2. **Stale or invalid evidence:** missing probes, NaN timestamps, future timestamps, expired evidence and unknown states; never become READY. Task 2 pins these cases.
3. **Identity/context changes:** evidence from a previous reboot, GUI/account context or browser provider; do not reuse Aside authentication for Playwright. Task 2 pins context and provider separation.
4. **Secret-bearing failures and misleading success:** environment values, unexpected host fields and exception text must not reach JSON; successful diagnostic collection does not mean shopping-mall automation works. Task 3 pins this distinction.
5. **Unexecuted tests and Windows regressions:** an empty suite must fail, the root runner must collect the new package, and the implementation diff must not touch the M2 or WSL runtime files. Task 4 pins collection/configuration and requires diff review.

---

## 1. Repository Baseline and Change Budget

Inspected on 2026-09-20:

| Reference | State |
|---|---|
| `main` | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` |
| Windows PR #135 | Draft/unmerged, `feat/m2-vertical-slice` at `c7fc805511bd777059d93c6a8360596a934919dc` |
| Mac PR #136 before this plan | Draft/unmerged, `docs/macos-operations-agent-design` at `9fdc212ad9dc6c3c8204a5c65d1dbff47ddea219` |
| Root `vitest.config.mts` | Collects `packages/*/vitest.config.ts`; `passWithNoTests: true` |
| Root `pnpm-workspace.yaml` | Discovers `apps/*` and `packages/*` |
| Current CI | `.github/workflows/ci.yml`, Ubuntu, full repository checks |

These are pinned planning facts, not a guarantee that the refs remain unchanged. Refresh them before execution.

**Allowed product-code diff:** `packages/platform/**`, new `.github/workflows/macos-platform.yml`, generated new-importer changes in `pnpm-lock.yaml`, and `docs/operations/macos-platform-readiness.md`.

**Do not edit:** `apps/agent/**`, `packages/task-engine/**`, `packages/workspace/**`, `packages/persistence/**`, `packages/policy/**`, `packages/mcp/**`, `packages/shell/**`, `packages/git/**`, root build/test configuration, existing WSL/systemd scripts, original Windows specs/plans, or the #1–#130 backlog manifest.

If the existing checkout already has a `packages/platform` directory or these APIs, stop and reconcile the plan against it. Do not overwrite it with this plan's examples.

### Branch and execution preflight — only after plan review

Use a separate worktree and a short-lived branch named `feat/macos-platform-readiness`. Do not create it on the active Windows worktree. This branch name is a proposal, not a branch created during planning.

```bash
git fetch origin
# Run from an authorized clean clone; do not reset or clean an existing checkout.
git status --short
git worktree list
git ls-remote --heads origin main feat/m2-vertical-slice docs/macos-operations-agent-design
# Record the observed main SHA as MAC01_BASE_SHA in the execution evidence.
git worktree add -b feat/macos-platform-readiness ../gram-macos-platform-readiness origin/main
cd ../gram-macos-platform-readiness
pnpm --version
node --version
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Record the written spec/plan commit as a separate documentation reference when it is not yet on main. Do not merge the documentation PR or the Windows PR just to start this independent package. The main-based implementation must use exactly the reviewed plan and spec. No protected-branch push or force update is authorized.

A pre-existing baseline test failure is evidence to report and isolate, not permission to repair unrelated Windows code.

## 2. File Map and Responsibilities

```text
packages/platform/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    contracts.ts             public, data-only host/probe/result contracts
    detect.ts                pure host classification and Node-major validation
    detect.test.ts
    readiness.ts             pure bounded-age/context-bound evaluation
    readiness.test.ts
    host-facts.ts            Node process/os facts only; no commands or secrets
    diagnostic.ts            safe report and command-line dispatch
    diagnostic.test.ts
    cli.ts                   tiny explicit entry point
    index.ts                 library exports; must not import the CLI
    architecture.test.ts     forbidden dependency/config collection checks
.github/workflows/macos-platform.yml
  # Additive focused Linux/Mac checks; existing root CI remains intact.
docs/operations/macos-platform-readiness.md
  # CLI usage, exit meanings and real-machine acceptance evidence format.
```

### Proposed contract decisions for this increment

- `macos-arm64`, `linux-wsl`, and `unsupported` are **platform-selection results**, not TaskStatus values.
- WSL selection is a kernel-release hint only. It does not prove WSL2 version, PID1/systemd, a usable user account or absence of containerization. Those checks belong to MAC-02/real WSL acceptance.
- macOS `darwin/x64` is rejected as `MACOS_ARM64_REQUIRED`; this includes an x64 Node binary under translation. Do not claim the physical machine is Intel merely from `process.arch`.
- Probe time-to-live is a **new proposed default of 30,000 ms**, not an existing repository setting. Exactly 30,000 ms is still valid; 30,001 ms is stale. Any future timestamp is unknown.
- An opaque `contextId` scopes the entire snapshot to one locally owned runtime/session/account context. Later trusted collectors must replace it after restart, account change, provider replacement or loss of session ownership. This increment does not implement authenticated IPC or accept probe claims from MCP, files, argv or stdin.
- Provider and account readiness use different keys for Aside and Playwright. Browser availability does not establish the identity or validity of a website account.
- Existing authenticated browser reads do not require a fresh Keychain unlock when no secret use is needed. A user-credential-dependent API request does require GUI session and user-vault readiness. Actual reauthentication is outside MAC-01.

---

### Task 1: Add a Collectable Package and Pure Platform Detection

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/contracts.ts`, `src/detect.ts`, `src/detect.test.ts`, and `src/index.ts` under `packages/platform`; update only the new importer in `pnpm-lock.yaml`.

**Interfaces:**
- Consumes: `HostFacts` from a caller; no process access in `detectPlatform`.
- Produces: `detectPlatform(facts: HostFacts): PlatformDetection` and the types in `contracts.ts` below.

- [ ] **Step 1: Add package/test configuration and the failing detector tests.** Configuration is part of this feature's test cycle, not a separate deliverable.

`packages/platform/package.json`:

```json
{
  "name": "@gram/platform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "diagnose": "node dist/cli.js --json"
  },
  "devDependencies": { "typescript": "^6.0.0", "vitest": "^5.0.0" }
}
```

`packages/platform/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/platform/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'platform',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
});
```

`packages/platform/src/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectPlatform } from './detect.js';

const mac = { platform: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: '24.1.0' };

describe('platform detection', () => {
  it('selects native arm64 macOS without claiming operational readiness', () => {
    expect(detectPlatform(mac)).toEqual({
      kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET',
    });
  });
  it('requires an arm64 Node binary on macOS, including translated x64 Node', () => {
    expect(detectPlatform({ ...mac, arch: 'x64' })).toEqual({
      kind: 'unsupported', compatible: false, reason: 'MACOS_ARM64_REQUIRED',
    });
  });
  it('selects only an explicit WSL2-like kernel hint, not ordinary Linux or WSL1', () => {
    const linux = { ...mac, platform: 'linux', arch: 'x64' };
    expect(detectPlatform({ ...linux, release: '6.6.87.2-microsoft-standard-WSL2' }).kind)
      .toBe('linux-wsl');
    for (const release of ['6.8.0-generic', '4.4.0-19041-Microsoft', '']) {
      expect(detectPlatform({ ...linux, release }).compatible).toBe(false);
    }
  });
  it.each(['23.11.0', '25.0.0', 'garbage', '24', '', '24.1.0-rc.1'])(
    'rejects unsupported or malformed Node version %s', (nodeVersion) => {
      expect(detectPlatform({ ...mac, nodeVersion }).reason).toBe('NODE_24_REQUIRED');
    },
  );
  it('rejects Windows-native and unknown platforms without selecting a default adapter', () => {
    for (const platform of ['win32', 'freebsd', '']) {
      expect(detectPlatform({ ...mac, platform }).reason).toBe('UNSUPPORTED_PLATFORM');
    }
  });
});
```

- [ ] **Step 2: Resolve the new workspace importer and record RED.** Preserve existing versions and reject unrelated lockfile churn.

```bash
pnpm install --lockfile-only
git diff -- pnpm-lock.yaml
pnpm install --frozen-lockfile
pnpm --filter @gram/platform test -- src/detect.test.ts
```

Expected: the targeted test fails because `./detect.js` has not been implemented. A package-manager, network or missing-test failure is not the feature's RED evidence.

- [ ] **Step 3: Add the contracts and minimal detector.**

`packages/platform/src/contracts.ts`:

```ts
export interface HostFacts {
  platform: string;
  arch: string;
  release: string;
  nodeVersion: string;
}
export interface PlatformDetection {
  kind: 'macos-arm64' | 'linux-wsl' | 'unsupported';
  compatible: boolean;
  reason: 'SUPPORTED_TARGET' | 'NODE_24_REQUIRED' | 'MACOS_ARM64_REQUIRED' | 'UNSUPPORTED_PLATFORM';
}
export const probeKeys = [
  'CORE', 'ISOLATION', 'SERVICE_AUTH', 'GUI_SESSION', 'USER_VAULT',
  'ASIDE', 'ASIDE_ACCOUNT', 'PLAYWRIGHT', 'PLAYWRIGHT_ACCOUNT', 'SCREEN_RECORDING',
] as const;
export type ProbeKey = (typeof probeKeys)[number];
export interface Observation {
  state: 'READY' | 'BLOCKED' | 'UNKNOWN';
  observedAtMs: number;
  contextId: string;
}
export interface ReadinessSnapshot {
  host: PlatformDetection;
  contextId: string;
  probes: Partial<Record<ProbeKey, Observation>>;
}
export type WorkRequest =
  | { kind: 'API_READ'; auth: 'NONE' | 'SERVICE' | 'USER' }
  | { kind: 'BROWSER_READ'; provider: 'ASIDE' | 'PLAYWRIGHT' }
  | { kind: 'SCREEN_CAPTURE' };
export type BlockerReason =
  | 'UNSUPPORTED_HOST' | 'INVALID_REQUEST' | 'INVALID_CLOCK' | 'INVALID_CONTEXT'
  | 'MISSING' | 'CONTEXT_CHANGED' | 'INVALID_TIME' | 'FUTURE' | 'STALE' | 'BLOCKED' | 'UNKNOWN';
export interface Blocker { probe: ProbeKey | 'HOST' | 'REQUEST' | 'CLOCK' | 'CONTEXT'; reason: BlockerReason }
export interface ReadinessResult {
  status: 'READY' | 'BLOCKED' | 'UNKNOWN' | 'UNSUPPORTED';
  blockers: Blocker[];
}
```

`packages/platform/src/detect.ts`:

```ts
import type { HostFacts, PlatformDetection } from './contracts.js';

export function detectPlatform(facts: HostFacts): PlatformDetection {
  if (!/^24\.\d+\.\d+$/.test(facts.nodeVersion)) {
    return { kind: 'unsupported', compatible: false, reason: 'NODE_24_REQUIRED' };
  }
  if (facts.platform === 'darwin') {
    return facts.arch === 'arm64'
      ? { kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET' }
      : { kind: 'unsupported', compatible: false, reason: 'MACOS_ARM64_REQUIRED' };
  }
  if (facts.platform === 'linux' && /microsoft-standard.*wsl2/i.test(facts.release)) {
    return { kind: 'linux-wsl', compatible: true, reason: 'SUPPORTED_TARGET' };
  }
  return { kind: 'unsupported', compatible: false, reason: 'UNSUPPORTED_PLATFORM' };
}
```

`packages/platform/src/index.ts`:

```ts
export * from './contracts.js';
export * from './detect.js';
```

- [ ] **Step 4: Record GREEN and type/build evidence.**

```bash
pnpm --filter @gram/platform test -- src/detect.test.ts
pnpm --filter @gram/platform lint
pnpm --filter @gram/platform typecheck
pnpm --filter @gram/platform build
```

Expected: all detector tests pass; no new runtime import or command is introduced. Root `tsconfig.base.json` remains unchanged.

- [ ] **Step 5: Commit only this deliverable.**

```bash
git add packages/platform pnpm-lock.yaml
git commit -m "feat(platform): add explicit Mac and WSL target detection"
```

---

### Task 2: Add Context-Bound, Fail-Closed Readiness Evaluation

**Files:** Create `packages/platform/src/readiness.ts`, `readiness.test.ts`; append its export to `index.ts`.

**Interfaces:**
- Consumes: `ReadinessSnapshot`, `WorkRequest`, and the caller's time in milliseconds.
- Produces: `evaluateReadiness(snapshot: ReadinessSnapshot, request: WorkRequest, nowMs: number): ReadinessResult`; `MAX_PROBE_AGE_MS = 30_000`.
- This is an internal pure function. No MCP tool accepts fabricated observations and no live operation is allowed because this function returns READY.

- [ ] **Step 1: Add the following tests before the evaluator exists.**

`packages/platform/src/readiness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { probeKeys, type ProbeKey, type ReadinessSnapshot, type WorkRequest } from './contracts.js';
import { evaluateReadiness } from './readiness.js';

function snapshot(): ReadinessSnapshot {
  const probes: ReadinessSnapshot['probes'] = {};
  for (const key of probeKeys) {
    probes[key] = { state: 'READY', observedAtMs: 100_000, contextId: 'runtime-session-account-1' };
  }
  return {
    host: { kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET' },
    contextId: 'runtime-session-account-1',
    probes,
  };
}
const api: WorkRequest = { kind: 'API_READ', auth: 'SERVICE' };
const browser: WorkRequest = { kind: 'BROWSER_READ', provider: 'ASIDE' };

describe('readiness evidence', () => {
  it('allows eligible API readiness when the GUI and user vault are absent', () => {
    const s = snapshot();
    delete s.probes.GUI_SESSION;
    delete s.probes.USER_VAULT;
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('UNKNOWN');
    expect(evaluateReadiness(s, { kind: 'API_READ', auth: 'USER' }, 100_000).status)
      .toBe('UNKNOWN');
  });
  it.each(['CORE', 'ISOLATION', 'SERVICE_AUTH'] satisfies ProbeKey[])(
    'does not allow missing %s', (key) => {
      const s = snapshot();
      delete s.probes[key];
      expect(evaluateReadiness(s, api, 100_000).blockers).toContainEqual({ probe: key, reason: 'MISSING' });
    },
  );
  it('fails closed when evidence is stale, future, invalid or in another context', () => {
    for (const [observedAtMs, contextId, reason] of [
      [69_999, 'runtime-session-account-1', 'STALE'],
      [100_001, 'runtime-session-account-1', 'FUTURE'],
      [Number.NaN, 'runtime-session-account-1', 'INVALID_TIME'],
      [100_000, 'previous-boot', 'CONTEXT_CHANGED'],
    ] as const) {
      const s = snapshot();
      s.probes.CORE = { state: 'READY', observedAtMs, contextId };
      expect(evaluateReadiness(s, api, 100_000).status).toBe('UNKNOWN');
      expect(evaluateReadiness(s, api, 100_000).blockers).toContainEqual({ probe: 'CORE', reason });
    }
    const s = snapshot();
    s.probes.CORE = { state: 'READY', observedAtMs: 70_000, contextId: s.contextId };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
  });
  it('separates an unavailable capability from unknown evidence', () => {
    const s = snapshot();
    s.probes.GUI_SESSION = { state: 'BLOCKED', observedAtMs: 100_000, contextId: s.contextId };
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('BLOCKED');
    s.probes.GUI_SESSION.state = 'UNKNOWN';
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('UNKNOWN');
  });
  it('never substitutes Aside account evidence for Playwright', () => {
    const s = snapshot();
    delete s.probes.PLAYWRIGHT_ACCOUNT;
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('READY');
    expect(evaluateReadiness(s, { kind: 'BROWSER_READ', provider: 'PLAYWRIGHT' }, 100_000).blockers)
      .toContainEqual({ probe: 'PLAYWRIGHT_ACCOUNT', reason: 'MISSING' });
  });
  it('does not require user-vault access for an already-authenticated browser read', () => {
    const s = snapshot();
    delete s.probes.USER_VAULT;
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('READY');
  });
  it('requires screen permission for capture without demanding unrelated permissions', () => {
    const s = snapshot();
    delete s.probes.SCREEN_RECORDING;
    expect(evaluateReadiness(s, { kind: 'SCREEN_CAPTURE' }, 100_000).blockers)
      .toContainEqual({ probe: 'SCREEN_RECORDING', reason: 'MISSING' });
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
  });
  it('rejects inconsistent host data and invalid request/time/context', () => {
    const s = snapshot();
    s.host = { kind: 'unsupported', compatible: true, reason: 'SUPPORTED_TARGET' };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('UNSUPPORTED');
    expect(evaluateReadiness(snapshot(), { kind: 'SEND_PAYMENT' } as unknown as WorkRequest, 100_000).status)
      .toBe('BLOCKED');
    expect(evaluateReadiness(snapshot(), api, Number.NaN).status).toBe('UNKNOWN');
    const empty = snapshot();
    empty.contextId = '';
    expect(evaluateReadiness(empty, api, 100_000).status).toBe('UNKNOWN');
  });
  it('treats invalid probe states and mismatched request fields as unavailable', () => {
    const s = snapshot();
    s.probes.CORE = {
      state: 'UNRECOGNIZED' as 'UNKNOWN', observedAtMs: 100_000, contextId: s.contextId,
    };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('UNKNOWN');
    for (const request of [
      { kind: 'API_READ', auth: 'UNRECOGNIZED' },
      { kind: 'BROWSER_READ', provider: 'UNRECOGNIZED' },
    ]) {
      expect(evaluateReadiness(snapshot(), request as unknown as WorkRequest, 100_000).status).toBe('BLOCKED');
    }
  });
  it('does not mutate the input or expose unexpected fields in its result', () => {
    const s = snapshot();
    const before = structuredClone(s);
    Object.assign(s, { password: 'FAKE_SENTINEL_DO_NOT_RETURN' });
    const result = evaluateReadiness(s, api, 100_000);
    expect(result).toEqual({ status: 'READY', blockers: [] });
    expect(JSON.stringify(result)).not.toContain('FAKE_SENTINEL');
    expect(s.probes).toEqual(before.probes);
  });
});
```

- [ ] **Step 2: Record targeted RED.**

```bash
pnpm --filter @gram/platform test -- src/readiness.test.ts
```

Expected: missing evaluator import/function, not an unrelated configuration failure.

- [ ] **Step 3: Implement explicit requirements, stable blocker ordering, and fixed-code results.**

`packages/platform/src/readiness.ts`:

```ts
import type {
  Blocker, Observation, ProbeKey, ReadinessResult, ReadinessSnapshot, WorkRequest,
} from './contracts.js';

export const MAX_PROBE_AGE_MS = 30_000;

function requirements(request: WorkRequest): ProbeKey[] | null {
  const base: ProbeKey[] = ['CORE', 'ISOLATION'];
  switch (request.kind) {
    case 'API_READ':
      if (request.auth === 'NONE') return base;
      if (request.auth === 'SERVICE') return [...base, 'SERVICE_AUTH'];
      if (request.auth === 'USER') return [...base, 'GUI_SESSION', 'USER_VAULT'];
      return null;
    case 'BROWSER_READ':
      if (request.provider === 'ASIDE') return [...base, 'GUI_SESSION', 'ASIDE', 'ASIDE_ACCOUNT'];
      if (request.provider === 'PLAYWRIGHT') return [...base, 'GUI_SESSION', 'PLAYWRIGHT', 'PLAYWRIGHT_ACCOUNT'];
      return null;
    case 'SCREEN_CAPTURE':
      return [...base, 'GUI_SESSION', 'SCREEN_RECORDING'];
    default:
      return null;
  }
}

function check(
  probe: ProbeKey, observation: Observation | undefined, contextId: string, nowMs: number,
): Blocker | null {
  const fail = (reason: Blocker['reason']): Blocker => ({ probe, reason });
  if (!observation) return fail('MISSING');
  if (observation.contextId !== contextId) return fail('CONTEXT_CHANGED');
  if (!Number.isFinite(observation.observedAtMs) || observation.observedAtMs < 0) return fail('INVALID_TIME');
  if (observation.observedAtMs > nowMs) return fail('FUTURE');
  if (nowMs - observation.observedAtMs > MAX_PROBE_AGE_MS) return fail('STALE');
  if (observation.state === 'BLOCKED') return fail('BLOCKED');
  if (observation.state !== 'READY') return fail('UNKNOWN');
  return null;
}

export function evaluateReadiness(
  snapshot: ReadinessSnapshot, request: WorkRequest, nowMs: number,
): ReadinessResult {
  if (!snapshot.host.compatible || snapshot.host.reason !== 'SUPPORTED_TARGET'
    || !['macos-arm64', 'linux-wsl'].includes(snapshot.host.kind)) {
    return { status: 'UNSUPPORTED', blockers: [{ probe: 'HOST', reason: 'UNSUPPORTED_HOST' }] };
  }
  const needed = requirements(request);
  if (needed === null) return { status: 'BLOCKED', blockers: [{ probe: 'REQUEST', reason: 'INVALID_REQUEST' }] };
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return { status: 'UNKNOWN', blockers: [{ probe: 'CLOCK', reason: 'INVALID_CLOCK' }] };
  }
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(snapshot.contextId)) {
    return { status: 'UNKNOWN', blockers: [{ probe: 'CONTEXT', reason: 'INVALID_CONTEXT' }] };
  }
  const blockers = needed.flatMap((key) => {
    const blocker = check(key, snapshot.probes[key], snapshot.contextId, nowMs);
    return blocker ? [blocker] : [];
  });
  const status = blockers.some((b) => b.reason === 'BLOCKED')
    ? 'BLOCKED' : blockers.length > 0 ? 'UNKNOWN' : 'READY';
  return { status, blockers };
}
```

Append to `packages/platform/src/index.ts`:

```ts
export * from './readiness.js';
```

The later authenticated collector, not untrusted remote text, will own context IDs and observations. These TypeScript contracts are not runtime validation of arbitrary JSON; do not expose them as an IPC/MCP boundary without a separate strict schema.

- [ ] **Step 4: Record GREEN and verify the combined package.**

```bash
pnpm --filter @gram/platform test
pnpm --filter @gram/platform lint
pnpm --filter @gram/platform typecheck
pnpm --filter @gram/platform build
```

Expected: deterministic results on any test OS. No real credentials, browser profiles, system commands or account operations are used.

- [ ] **Step 5: Commit.**

```bash
git add packages/platform/src/readiness.ts packages/platform/src/readiness.test.ts packages/platform/src/index.ts
git commit -m "feat(platform): evaluate scoped readiness without optimistic defaults"
```

---

### Task 3: Ship a Read-Only Local Diagnostic CLI

**Files:** Create `host-facts.ts`, `diagnostic.ts`, `diagnostic.test.ts`, `cli.ts` under `packages/platform/src`; append library exports to `index.ts`.

**Interfaces:**
- `readHostFacts(): HostFacts`: Node process and OS release only.
- `makeDiagnostic(facts: HostFacts): DiagnosticReport`: returns fixed schema version 1, platform classification, and three readiness results using no invented observations.
- `runDiagnostic(args: readonly string[], ports: DiagnosticPorts): number`: injected host facts and output sinks, exit codes 0/2/64/70.
- The CLI supports exactly `--json`. It is not connected to MCP or the installed agent in this increment.

- [ ] **Step 1: Add tests for output meaning, invalid arguments and secret-bearing failures.**

`packages/platform/src/diagnostic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeDiagnostic, runDiagnostic } from './diagnostic.js';

const facts = { platform: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: '24.1.0' };

describe('diagnostic CLI', () => {
  it('reports a compatible platform but unknown live operational readiness', () => {
    const report = makeDiagnostic(facts);
    expect(report.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.platform.kind).toBe('macos-arm64');
    expect(Object.values(report.capabilities).map((v) => v.status))
      .toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(report.liveProbesCollected).toBe(false);
  });
  it('omits extra facts, paths and secrets rather than serializing input objects', () => {
    const input = { ...facts, home: '/private/FAKE_PRIVATE_PATH', password: 'FAKE_SENTINEL_DO_NOT_RETURN' };
    expect(JSON.stringify(makeDiagnostic(input))).not.toMatch(/FAKE_|password|nodeVersion|release/);
  });
  it('returns 0 for diagnostic collection, not operational readiness', () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(runDiagnostic(['--json'], {
      read: () => facts, writeOut: (v) => out.push(v), writeError: (v) => err.push(v),
    })).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).capabilities.apiRead.status).toBe('UNKNOWN');
    expect(err).toEqual([]);
  });
  it('returns 2 for an unsupported execution target and still emits parseable JSON', () => {
    const out: string[] = [];
    expect(runDiagnostic(['--json'], {
      read: () => ({ ...facts, arch: 'x64' }), writeOut: (v) => out.push(v), writeError: () => undefined,
    })).toBe(2);
    expect(JSON.parse(out[0]!).platform.compatible).toBe(false);
  });
  it('rejects unsupported arguments before any probe', () => {
    const invalidArgs = [[], ['--json', '--install'], ['--login'], ['--secrets'], ['--json', '--json']];
    for (const args of invalidArgs) {
      const out: string[] = [];
      let reads = 0;
      const code = runDiagnostic(args, {
        read: () => { reads += 1; return facts; },
        writeOut: (v) => out.push(v), writeError: () => undefined,
      });
      expect(code).toBe(64);
      expect(reads).toBe(0);
      expect(out).toEqual([]);
    }
  });
  it('emits only a fixed code for exceptions, never the raw exception message', () => {
    const err: string[] = [];
    const code = runDiagnostic(['--json'], {
      read: () => { throw new Error('FAKE_SENTINEL_DO_NOT_RETURN'); },
      writeOut: () => undefined, writeError: (v) => err.push(v),
    });
    expect(code).toBe(70);
    expect(err).toEqual(['DIAGNOSTIC_FAILED\n']);
  });
});
```

- [ ] **Step 2: Record targeted RED.**

```bash
pnpm --filter @gram/platform test -- src/diagnostic.test.ts
```

Expected: missing diagnostic module, not a timeout or zero-test success.

- [ ] **Step 3: Add the host-fact provider, report builder and entry point.**

`packages/platform/src/host-facts.ts`:

```ts
import process from 'node:process';
import { release } from 'node:os';
import type { HostFacts } from './contracts.js';

export function readHostFacts(): HostFacts {
  return { platform: process.platform, arch: process.arch, release: release(), nodeVersion: process.versions.node };
}
```

`packages/platform/src/diagnostic.ts`:

```ts
import type { HostFacts, PlatformDetection, ReadinessResult, ReadinessSnapshot } from './contracts.js';
import { detectPlatform } from './detect.js';
import { evaluateReadiness } from './readiness.js';

export interface DiagnosticReport {
  schemaVersion: 1;
  mode: 'DIAGNOSTIC_ONLY';
  liveProbesCollected: false;
  platform: PlatformDetection;
  capabilities: { apiRead: ReadinessResult; asideRead: ReadinessResult; screenCapture: ReadinessResult };
}
export interface DiagnosticPorts {
  read(): HostFacts;
  writeOut(text: string): void;
  writeError(text: string): void;
}
export function makeDiagnostic(facts: HostFacts): DiagnosticReport {
  const platform = detectPlatform(facts);
  const snapshot: ReadinessSnapshot = { host: platform, contextId: 'diagnostic-only', probes: {} };
  return {
    schemaVersion: 1, mode: 'DIAGNOSTIC_ONLY', liveProbesCollected: false, platform,
    capabilities: {
      apiRead: evaluateReadiness(snapshot, { kind: 'API_READ', auth: 'SERVICE' }, 0),
      asideRead: evaluateReadiness(snapshot, { kind: 'BROWSER_READ', provider: 'ASIDE' }, 0),
      screenCapture: evaluateReadiness(snapshot, { kind: 'SCREEN_CAPTURE' }, 0),
    },
  };
}
export function runDiagnostic(args: readonly string[], ports: DiagnosticPorts): number {
  if (args.length !== 1 || args[0] !== '--json') {
    ports.writeError('USAGE: gram-platform --json\n');
    return 64;
  }
  try {
    const report = makeDiagnostic(ports.read());
    ports.writeOut(`${JSON.stringify(report)}\n`);
    return report.platform.compatible ? 0 : 2;
  } catch {
    ports.writeError('DIAGNOSTIC_FAILED\n');
    return 70;
  }
}
```

`packages/platform/src/cli.ts`:

```ts
import process from 'node:process';
import { runDiagnostic } from './diagnostic.js';
import { readHostFacts } from './host-facts.js';

process.exitCode = runDiagnostic(process.argv.slice(2), {
  read: readHostFacts,
  writeOut: (text) => { process.stdout.write(text); },
  writeError: (text) => { process.stderr.write(text); },
});
```

Append to `packages/platform/src/index.ts`; do not export/import `cli.ts`:

```ts
export * from './host-facts.js';
export * from './diagnostic.js';
```

- [ ] **Step 4: Record GREEN and run the real built CLI.**

```bash
pnpm --filter @gram/platform test
pnpm --filter @gram/platform lint
pnpm --filter @gram/platform typecheck
pnpm --filter @gram/platform build
# On a native arm64 Mac/Node24 this returns 0, with UNKNOWN capabilities.
# On ordinary Linux this intentionally returns 2. Capture it rather than calling it a Mac failure.
node packages/platform/dist/cli.js --json
```

The CLI never opens Keychain, checks a password, launches a browser or installs a service. `liveProbesCollected: false` is intentional. Do not change it to true to make a readiness dashboard appear green.

- [ ] **Step 5: Commit.**

```bash
git add packages/platform/src
git commit -m "feat(platform): add secret-free local readiness diagnostic"
```

---

### Task 4: Enforce Collection Boundaries and Add Focused Native-Mac CI

**Files:** Create `packages/platform/src/architecture.test.ts`, `.github/workflows/macos-platform.yml`, and `docs/operations/macos-platform-readiness.md`. Do not change `.github/workflows/ci.yml` or root Vitest configuration.

**Interfaces:**
- Consumes: the public package and compiled `dist/cli.js` from Tasks 1–3.
- Produces: an additive `macos-platform` CI check and documented diagnostic acceptance. It proves package behavior on the selected runner; it does not prove launchd/Keychain/GUI operation on the user's Mac.

- [ ] **Step 1: Add collection/dependency tests before creating the new workflow and operations document.**

`packages/platform/src/architecture.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceDir = fileURLToPath(new URL('.', import.meta.url));
const root = new URL('../../../', import.meta.url);

describe('platform integration boundaries', () => {
  it('keeps production code free from execution, filesystem, network and secret-provider dependencies', () => {
    const allowed = new Set(['node:process', 'node:os']);
    for (const name of readdirSync(sourceDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const text = readFileSync(new URL(name, import.meta.url), 'utf8');
      const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const value = node.moduleSpecifier.text;
          expect(value.startsWith('./') || allowed.has(value), `${name}: ${value}`).toBe(true);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new Error(`Dynamic import not permitted in ${name}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(text).not.toMatch(/process\s*\.\s*env|process\s*\[\s*['"]env/);
    }
  });
  it('is collected by root tests and fails if its own test collection is empty', () => {
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    const rootConfig = readFileSync(new URL('vitest.config.mts', root), 'utf8');
    expect(rootConfig).toContain('packages/*/vitest.config.ts');
    expect(config).toMatch(/passWithNoTests:\s*false/);
    expect(config).toContain("name: 'platform'");
  });
  it('includes a native Mac workflow and an honest diagnostic runbook', () => {
    const workflow = readFileSync(new URL('.github/workflows/macos-platform.yml', root), 'utf8');
    const runbook = readFileSync(new URL('docs/operations/macos-platform-readiness.md', root), 'utf8');
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('pnpm --filter @gram/platform test');
    expect(workflow).not.toContain('pull_request_target');
    expect(runbook).toContain('DIAGNOSTIC_ONLY');
    expect(runbook).toContain('NOT_RUN');
  });
});
```

Resolve `root` relative to the test file carefully: from `packages/platform/src/architecture.test.ts`, the repository root is `../../../`. Do not use a machine-specific absolute repository path.

This static import guard is a regression aid, not a sandbox or comprehensive exfiltration defense. Real executor isolation remains an explicit later gate.

- [ ] **Step 2: Record RED due to the missing workflow/runbook.**

```bash
pnpm --filter @gram/platform test -- src/architecture.test.ts
```

Expected: missing `.github/workflows/macos-platform.yml` or missing operations document; dependency and collection assertions should already pass.

- [ ] **Step 3: Add the focused workflow without disabling current CI.**

`.github/workflows/macos-platform.yml`:

```yaml
name: macos-platform
on:
  pull_request:
    paths:
      - 'packages/platform/**'
      - '.github/workflows/macos-platform.yml'
      - 'pnpm-lock.yaml'
      - 'package.json'
      - 'pnpm-workspace.yaml'
      - 'tsconfig.base.json'
      - 'vitest.config.mts'
      - 'eslint.config.mjs'
      - 'docs/operations/macos-platform-readiness.md'
  push:
    branches: [main]
    paths:
      - 'packages/platform/**'
      - '.github/workflows/macos-platform.yml'
      - 'pnpm-lock.yaml'
      - 'package.json'
      - 'pnpm-workspace.yaml'
      - 'tsconfig.base.json'
      - 'vitest.config.mts'
      - 'eslint.config.mjs'
      - 'docs/operations/macos-platform-readiness.md'
permissions:
  contents: read
concurrency:
  group: macos-platform-${{ github.ref }}
  cancel-in-progress: true
jobs:
  platform:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @gram/platform lint
      - run: pnpm --filter @gram/platform typecheck
      - run: pnpm --filter @gram/platform test
      - run: pnpm --filter @gram/platform build
      - name: Verify native macOS arm64 execution
        if: runner.os == 'macOS'
        run: node -e "if(process.platform!=='darwin'||process.arch!=='arm64') process.exit(1)"
      - name: Collect Mac diagnostic, not a live-operation acceptance
        if: runner.os == 'macOS'
        run: |
          node packages/platform/dist/cli.js --json > platform-diagnostic.json
          node --input-type=module -e '
            import {readFileSync} from "node:fs";
            const r=JSON.parse(readFileSync("platform-diagnostic.json","utf8"));
            if(r.mode!=="DIAGNOSTIC_ONLY" || r.liveProbesCollected!==false ||
               r.platform.kind!=="macos-arm64" ||
               Object.values(r.capabilities).some(v=>v.status!=="UNKNOWN")) process.exit(1);
          '
```

`macos-15` is chosen explicitly instead of a moving `macos-latest`; Node architecture is also asserted. GitHub's hosted-runner documentation currently lists `macos-15` as arm64. Hosted Mac runners are **not** proof of the proposed non-admin account because GitHub documents elevated privileges on its hosted environment. Do not put real store credentials or the user's signed production helper on a test runner.

Private-repository Actions usage can consume included minutes or billed usage. Do not change billing settings or select a paid larger runner; this workflow is a proposal requiring plan approval and stays within standard runner configuration.

- [ ] **Step 4: Add the exact operations-document content below and fill only observed execution evidence when available.**

`docs/operations/macos-platform-readiness.md`:

```markdown
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
- Native arm64 Mac package diagnostic: NOT_RUN
- User's dedicated non-admin account validation: NOT_RUN
- User's launchd core/tunnel recovery: NOT_RUN
- User Keychain/broker and TCC checks: NOT_RUN
- Real store/browser workflow: NOT_RUN

A GitHub-hosted Mac job validates this package, not those production checks.
```

- [ ] **Step 5: Record GREEN, root collection, regression and diff evidence.**

```bash
pnpm --filter @gram/platform test
pnpm --filter @gram/platform lint
pnpm --filter @gram/platform typecheck
pnpm --filter @gram/platform build
pnpm exec vitest run --project platform
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
# MAC01_BASE_SHA is the exact observed base recorded during preflight.
git diff --name-only "$MAC01_BASE_SHA"
```

Expected: platform tests appear in the root runner; no empty test suite passes; root checks pass on the development host or failures are accurately reported. The name-only diff must match the allowed change budget. Do not discard a failure by excluding a Windows test or widening existing root settings.

Run the focused Mac job and the unchanged root CI on the implementation PR's exact head. If the hosted Mac job cannot run because of capacity or account limits, record BLOCKED, not PASS. Target-user Mac readiness remains NOT_RUN until tested there.

- [ ] **Step 6: Commit the final deliverable and publish only through a feature PR.**

```bash
git add packages/platform/src/architecture.test.ts .github/workflows/macos-platform.yml docs/operations/macos-platform-readiness.md
git commit -m "test(platform): verify native Mac readiness and preserve WSL boundaries"
# Review diff and scan for secrets before publishing.
git diff --check "$MAC01_BASE_SHA" HEAD
# Push only the feature branch after local verification.
git push -u origin feat/macos-platform-readiness
git ls-remote --heads origin feat/macos-platform-readiness
```

Confirm remote SHA equals local HEAD, then create a separate Draft implementation PR to main. Record both required CI outcomes against that exact SHA. Do not modify, mark ready or merge PR #135; do not merge the new PR as a side effect.

---

## 3. Acceptance Matrix and Later-Phase Separation

| Requirement | Test/acceptance owner | MAC-01 meaning |
|---|---|---|
| Explicit platform selection; no browser-user-agent inference | Task 1 | Implemented and unit-tested |
| x64 Node rejected on macOS; Node24 enforced | Task 1 + Task 4 native assertion | Binary compatibility, not hardware purchase advice |
| Missing/stale/future/context-mismatched probes fail closed | Task 2 | Pure internal evaluator |
| API readiness independent from unrelated GUI/vault state | Task 2 | Only the requested capability's observations matter |
| Aside/Playwright account evidence is not interchangeable | Task 2 | No actual login or provider bridge |
| No secret values, raw errors or operational side effects in CLI | Task 3 + static guard in Task 4 | Fixed diagnostic schema |
| New tests collected; unchanged Windows/M2 contracts | Task 4 + base diff review | Additive compatibility work |
| Real launchd install, FileVault recovery, live Keychain, TCC | MAC-02/MAC-04 | Outside this implementation plan; NOT_RUN |
| Operations task lifecycle, resource leases, durable scheduling | MAC-03 | Outside this implementation plan; depends on shared M2/M3 |
| HAAR product workflow and live business approvals | MAC-05 | Outside this implementation plan; no live writes here |

The parent design describes an entire operations product. This plan deliberately covers only its independent first increment. It does not claim to implement the remaining sections by defining a type or mocking a probe. The delivery index identifies those separate workstreams and their entry/exit gates.

## 4. Self-Review and Handoff

Before implementation, a reviewer should be able to reject any of the four deliverables independently. Review the typed interfaces, 30-second evidence default, supported diagnostic target rules, scope of unknown live probes, exact file budget, and native-runner choice.

Plan-writing checks: required headings, all five Review Focus cases assigned, test/implementation interfaces aligned, balanced fenced blocks, JSON/YAML syntax, no merge markers or real credentials, and no product-code changes in the documentation PR. These checks are not execution of the embedded tests.

Recommended execution method: **native, one task at a time in a separate worktree**. The tasks share small contracts and the increment contains no live credentials or store writes. Independent subagent review is an optional execution capability, not presumed available in this chat. If no independent reviewer is available, disclose that and retain the Draft review gate.

Review this written plan and select its execution method before product implementation. The first implementation action after approval is Task 1's failing detector tests, not macOS installation or account login.

## 5. Source Notes

Repository facts were read from the pinned main/spec heads above, not inferred from a public project with the same name:
- `package.json`, `pnpm-workspace.yaml`, `vitest.config.mts`, `tsconfig.base.json`.
- `packages/observability/package.json` and `vitest.config.ts` for existing conventions.
- `.github/workflows/ci.yml` and PR metadata #135/#136.

External verification, checked 2026-09-20:
- Node process platform/architecture describe the Node binary's execution target, not a complete machine inventory: https://nodejs.org/docs/latest-v24.x/api/process.html#processarch
- GitHub standard runner labels, architecture, private-repository usage and hosted-runner privileges: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- The rest of the readiness contract, time-to-live, command/exit schema, capability scope and increment boundaries are design proposals in this plan, not vendor behavior claims.
