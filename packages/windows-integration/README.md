# Windows path conversion preparation — #99

`@gram/windows-integration` implements the path-conversion portion of M4 Task 1.
It is prepared against M2 commit `d886ce3b98520e4c594e8da73b14e0bed7dbac3e`.
**MCP `windows_path` is not registered. Keep #99 OPEN and this PR Draft/unmerged;
do not merge into main or M2 before #77 is complete.**

## API

```ts
import { WindowsPathService } from '@gram/windows-integration';

const paths = new WindowsPathService();
const windowsPath = await paths.toWindows(process.cwd());
const linuxPath = await paths.toLinux(windowsPath);
```

The default runner executes the system-installed `wslpath` from the Linux/WSL
process's `PATH`. It passes exactly `['-w', linuxPath]` or `['-u', windowsPath]`
to `node:child_process.execFile`, with `shell: false`, UTF-8 output, a five-second
timeout, `SIGKILL` on timeout, and a 64 KiB limit on each output stream.
The executable and execution settings are fixed internally. No fallback drive,
mount-root, distribution, or username mapping exists.

For trusted application composition and tests, inject a `WindowsPathRunner`:

```ts
import { WindowsPathService, type WindowsPathRunner } from '@gram/windows-integration';

const runner: WindowsPathRunner = {
  async run({ executable, args }) {
    // Delegate this fixed request to a trusted adapter, or inspect it in a test.
    // executable has type 'wslpath'; args is readonly ['-w' | '-u', string].
    void executable;
    void args;
    return '/fixture/converted\n';
  },
};

const paths = new WindowsPathService(runner);
```

The injected runner is trusted configuration, not request data or an MCP
argument. It owns its execution deadlines and resource limits; the default
runner's bounds do not wrap an injected implementation. This package exposes no
generic process runner, PowerShell/CMD API, or executable/flag selection method.
It performs no policy grants, task orchestration, logging, or credential access.

## Input and result contract

| Input                                                             | Behavior                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Non-string, empty, or whitespace-only value                       | Reject before execution.                                                                                                        |
| More than 8192 UTF-16 code units                                  | Reject before execution; exactly 8192 is allowed.                                                                               |
| NUL, CR, LF, or unpaired UTF-16 surrogate                         | Reject before execution. This API accepts single-line Unicode paths.                                                            |
| A string beginning with `-`                                       | Reject before execution, so path data cannot become a converter option. Use `./-name` or `.\-name` for such relative filenames. |
| Spaces, Korean, emoji, single/double quotes, shell metacharacters | Preserve as literal data in one argv element.                                                                                   |
| Relative path                                                     | Delegate unchanged; the installed converter and process working directory determine its meaning.                                |
| Drive path, UNC, WSL share, or custom mount                       | Delegate to `wslpath`; no handwritten conversion or fixed drive/distro/user.                                                    |

No shell quoting or escaping is added. This service does not implement full
filesystem syntax validation, check existence, grant filesystem access, or
guarantee a lexical round trip. The installed converter determines supported
path syntax, mappings, canonicalization, and symlink behavior. Passing a
special-character fixture does not prove that a Windows filesystem accepts that
filename.

Results must satisfy the same string/length/Unicode/single-line bounds after
removing **at most one** terminal LF or CRLF. Already-unframed runner output is
also accepted. All other leading/trailing spaces are preserved; conversion
output is never trimmed. A valid returned relative filename may begin with `-`
because it is result data, not an option being executed.

All public failures are `WindowsPathError` with fixed, non-sensitive messages:

| Code                | Meaning                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `INVALID_PATH`      | Input failed the boundary checks.                                                                        |
| `INVALID_OUTPUT`    | A successful runner returned an invalid path result.                                                     |
| `CONVERSION_FAILED` | Runner threw/rejected, including a missing converter, nonzero exit, signal, timeout, or output overflow. |

Raw process errors, command arguments, stdout/stderr, and error causes are not
attached to public errors. No administrator permission or credentials are needed.

## Package verification

The package has **no dependency or devDependency declarations**. It uses the
repository's existing TypeScript, Vitest, ESLint, and Node types. After the
integration owner has prepared the workspace dependencies:

```bash
corepack pnpm --filter @gram/windows-integration test
corepack pnpm --filter @gram/windows-integration typecheck
corepack pnpm --filter @gram/windows-integration lint
corepack pnpm --filter @gram/windows-integration build
```

The package-local Vitest config is discovered by the existing root glob. The
package build emits production source only; a separate typecheck covers tests.

Executed during preparation on Linux / Node 24.19.0 / pnpm 10.34.5:

- Conversion contract: **9 RED → 9 GREEN**.
- Input/result boundary increment: **47 RED / 23 passing → 70 GREEN**.
- Default process increment: **8 RED / 70 passing → 78 GREEN**.
- Final package suite: **78 tests in 2 files**; lint, production/test typecheck,
  and build passed.
- The 70 service cases use injected fake runners. The 8 process cases run real
  Linux child processes using a temporary test-only executable named `wslpath`.
  They exercise literal argv, both directions, absent executable, nonzero exit,
  signal, stdout/stderr overflow, and a hung child that ignores SIGTERM.
- The process fixture is **not Microsoft `wslpath`** and is never installed into
  the host toolchain. These tests do not establish actual WSL conversion.
- Real system `wslpath` conversion and target Windows/WSL acceptance: **NOT_RUN**
  in this environment because the converter and target Windows runtime are absent.

The Draft PR records final root regression checks, the submitted commit, and
the actual GitHub CI result separately. A root CI success does not establish
MCP registration or native Windows acceptance.

### Target Windows/WSL smoke check — NOT_RUN here

From the repository root, inside the intended WSL distribution with Node and
`wslpath` installed, build the package and run:

```bash
corepack pnpm --filter @gram/windows-integration build
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { WindowsPathService } from './packages/windows-integration/dist/index.js';

const service = new WindowsPathService();
const source = await realpath(process.cwd());
const windows = await service.toWindows(source);
const roundTrip = await service.toLinux(windows);
assert.equal(await realpath(roundTrip), source);
console.log('PASS: native wslpath existing-directory round trip');
JS
```

Also repeat with existing approved fixture paths containing spaces, Korean,
apostrophes, and a mounted Windows drive when available. Choose fixtures valid
for the target filesystem; do not treat fake-runner strings as native fixtures.
Record the Node/WSL versions, actual command, results, and any failed paths.

## Exact follow-up integration boundary

1. **`packages/mcp/`:** register `windows_path` with a strict object containing
   only `path` and `target: 'windows' | 'linux'`. Apply the same boundary checks
   and reject unknown `command`, `script`, `executable`, and `args` properties.
2. **`apps/agent/` and existing #47 composition:** add the consumer dependency and
   service wiring without replacing or weakening task identity, policy, and
   audit handling in `PathMapper` / `PolicyWslPathRunner`. Any shared refactor
   belongs to the integration owner. Use trusted runtime runner/PATH settings,
   never task-supplied execution configuration.
3. **Policy and security integration:** classify only the constrained typed
   operation as ALLOW, and exercise the real MCP boundary plus regressions that
   raw PowerShell/CMD/arbitrary Windows execution remains approval-gated.
4. **Root lockfile:** reconcile the empty importer
   `packages/windows-integration: {}` and any later consumer dependency entries.
   In an isolated fixture, pnpm 10.34.5 accepted a no-dependency workspace with
   `--frozen-lockfile` but normalized this empty importer into the lockfile.
   This PR deliberately leaves the shared lockfile unchanged to avoid the #77
   lane. Standalone package tests used already-prepared external workspace
   tooling, without running an install in the implementation checkout.
5. **Integrated verification:** perform a fresh frozen install and all required
   root/MCP/security checks on the integrated tree; record the actual native
   Windows/WSL smoke results. Existing root globs already discover this package,
   so this PR changes no root test or workspace configuration.
6. **Completion gates:** keep #99 OPEN until actual MCP registration is complete;
   keep the PR Draft/unmerged until #77 is complete and integration/native
   acceptance has been reviewed. This preparation does not complete M4 or #77.

Reference: `docs/superpowers/plans/2026-09-15-m4-windows-integration-ux.md`, Task 1;
`docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`, sections 13, 18, 22.
