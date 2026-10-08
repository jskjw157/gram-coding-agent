# Windows Open / Reveal preparation — #100

This implementation is stacked on PR #205 at
`4419dc8a6222d2b62a3c1cb68c01c6c545e83026`, on branch
`feat/m4-windows-open-reveal-prep`. Its PR base is
`feat/m4-windows-path-prep`. All changes stay inside this package.

**Keep #100 OPEN: MCP `windows_open` / `windows_reveal` are not registered.
Keep this PR Draft/unmerged; do not merge into M2/main before #77 completes.**
This preparation does not complete Windows native acceptance, M4, or #77.

## Public operations

| API | Accepted target | Result |
| --- | --- | --- |
| `WindowsOpenService.openPath(windowsPath)` | An absolute Windows drive/UNC path resolving to an existing directory | Request Explorer to browse the resolved directory. |
| `WindowsOpenService.openUrl(url)` | A bounded, explicit HTTP/HTTPS URL | Submit the normalized URL to Explorer's registered HTTP(S) handler. |
| `WindowsRevealService.revealPath(windowsPath)` | An absolute Windows drive/UNC filesystem path | Request selection using the fixed `/select,` switch; do not open the selected file's association. |

Each method returns `Promise<void>`. A resolved promise means the launcher
exited successfully; it does not establish which window appeared, whether the
file was selected, whether a target exists for reveal, or whether a page loaded.
Path operations accept **Windows paths**, with no OS guessing or implicit
conversion of Linux strings. Compose the existing #99 converter:

```ts
import {
  WindowsOpenService,
  WindowsPathService,
  WindowsRevealService,
} from '@gram/windows-integration';

const paths = new WindowsPathService();
const open = new WindowsOpenService();
const reveal = new WindowsRevealService();

await open.openPath(await paths.toWindows(process.cwd()));
await reveal.revealPath(await paths.toWindows(process.cwd() + '/README.md'));
await open.openUrl('https://example.com/');
```

### Directory-only opening

Windows file-association opening can launch executables, scripts, shortcuts or
registered handlers. Fixing the first executable to `explorer.exe` does not
make arbitrary file opening safe. This preparation therefore **does not provide
arbitrary file-association open**, even for apparently benign extensions.

The default runner implements `OPEN_PATH` by validating the Windows input,
converting with `toLinux`, resolving with `realpath`, requiring
`stat().isDirectory()`, converting the resolved directory with `toWindows`,
and validating that final result again. It adds a terminal directory separator
and checks the final length. Regular files and symlinks resolving to files are
rejected before Explorer starts. An executable/script/shortcut can be selected
through `revealPath` without requesting its default open verb.

These checks do not create filesystem authorization or isolate an adversarial
same-user process. Replacing a directory after the metadata check remains a
pathname race. A trailing separator conveys directory intent; it is not a
proven native security guarantee. Trusted workspace guards and native review
remain integration gates. Stronger folder-only guarantees need a separately
reviewed fixed native folder API.

## Fixed execution boundary

```ts
type FixedWindowsOperation =
  | { readonly kind: 'OPEN_PATH'; readonly windowsPath: string }
  | { readonly kind: 'REVEAL_PATH'; readonly windowsPath: string }
  | { readonly kind: 'OPEN_URL'; readonly url: string };
```

`FixedWindowsRunner.run` revalidates the union at runtime. Only an exact
two-field ordinary or null-prototype data record is accepted. Unknown fields,
wrong kinds/targets, symbol fields, accessors and inherited custom prototypes
are rejected before side effects. Validated primitive fields are copied before
awaiting anything, so later request mutation cannot change the operation.

The executable is always `explorer.exe` from the trusted Linux/WSL process
`PATH`. The converter remains system `wslpath`. No executable, script, flags,
environment, working directory or verb can be selected in operation data.
No CMD, PowerShell, generic process API, new privileges, credentials,
application orchestration or policy grants are introduced.

| Operation | Fixed argv |
| --- | --- |
| Directory open | `[validatedResolvedDirectoryWithTrailingBackslash]` |
| Reveal | `['/select,', validatedWindowsPath]` |
| HTTP(S) open | `[normalizedHttpUrl]` |

Calls use `execFile` with `shell: false`, UTF-8, a 5-second child-process
timeout, `SIGKILL` and 64 KiB per output stream. No quote characters are
manually embedded around arguments. The separate reveal switch avoids WSL
quoting the whole switch-plus-spaced-path as one argument. Linux fixtures
cannot prove Windows interop serialization or Explorer's parsing.

There are no retries. Missing executables, nonzero exits including exit 1,
signals, timeout and output overflow fail closed. A failure can follow a
partial native handoff; it is not proof that no window opened. Filesystem
metadata operations and injected dependencies do not have the child's
5-second cancellation guarantee.

Services accept a trusted `WindowsOperationRunner` for tests/application
composition. `FixedWindowsRunner` optionally accepts the converter's
`toLinux`/`toWindows` port. Constructor dependencies and process `PATH`
are deployment configuration, never MCP/request data. A custom runner owns
equivalent validation, directory restrictions, deadlines and error handling.
No generic executor injection port is exported.

## Target validation

Strings are limited to 8192 UTF-16 code units and reject empty/blank values,
controls, NUL and lone surrogates. Paths preserve valid Unicode, spaces,
Korean, emoji, apostrophes, semicolons, ampersands, dollar signs and other
non-ambiguous filename data. Drive, server, distribution and username values
are never hardcoded.

Explorer paths must be fully drive-rooted or complete UNC paths with a share.
The stricter Explorer boundary rejects:

- Relative, drive-relative, root-relative, forward-slash and option-like paths.
- URI/shell/NT/device namespaces and CLSID-suffixed namespace components.
- Double quotes, commas, percent expansion syntax, Windows-reserved filename
  characters and alternate-data-stream colons.
- Empty/repeated components, `.` / `..`, trailing component spaces/dots and
  reserved DOS device names, including superscript COM/LPT numbers.

Commas are intentionally unsupported even when legal in a filename because
Explorer has comma-separated switch syntax. Unsupported paths are not silently
rewritten or sent to a shell fallback. #99 conversion validation is unchanged;
a valid conversion result can still be rejected for Explorer use.

URLs require explicit case-insensitive `http://` or `https://`, a parsed
hostname and no credentials. Raw whitespace, double quotes, commas and
backslashes are rejected. The serialized URL is checked again for length and
Explorer delimiters: host normalization can turn `%2C`, a fullwidth comma or
`%22` into a literal comma/quote. Percent-encoded path/query data stays encoded
and is never interpreted as code. Prohibited protocols include `file:`,
`javascript:`, `shell:`, `ms-settings:` and every custom scheme.

## Errors

Public `WindowsIntegrationError` failures have fixed messages and one code:

| Code | Meaning |
| --- | --- |
| `INVALID_OPERATION` | The runner request did not match the strict fixed union. |
| `INVALID_PATH` | Input or converted output failed the path boundary. |
| `INVALID_URL` | Input or serialized URL failed the HTTP(S)/Explorer boundary. |
| `NOT_DIRECTORY` | The resolved target is not a directory. |
| `OPERATION_FAILED` | Conversion, filesystem inspection or process execution failed. |

Raw errors, argv, paths, URL queries, stdout/stderr and causes are not attached.
Services recreate recognized fixed errors instead of forwarding private fields
attached by an injected dependency. Error inspection is guarded and accepts
only one recognized own data-property code; accessors and reflective failures
fall back to a fresh `OPERATION_FAILED`.

## Verification performed in preparation

Linux / Node 24.19.0 / pinned pnpm 10.34.5, with prepared workspace dependencies
and no shared root lockfile change:

- Service contract: **109 RED / 78 passing → 187 GREEN**.
- Fixed-runner contract: **122 RED / 188 passing → 310 GREEN**.
- Real Linux process fixtures: **11 additional passing cases**.
- Normalized URL delimiter regressions: **3 RED / 321 passing → 324 GREEN**.
- Independent review regressions: **5 RED / 324 passing → 329 GREEN**;
  duplicate drive-root separators and unusual injected error objects reject.
  The reflective-failure test now asserts its throwing trap was reached.
- Package total: **329 tests / 6 files**, retaining all #99 tests. New cases:
  89 Open-service, 27 Reveal-service, 124 fixed-runner, 11 process-fixture tests.

The Linux executables named `explorer.exe` and `wslpath` in the new process
tests are temporary, test-owned fixtures. They verify literal argv, directory
checking, missing executable/converter, nonzero exit, signal, stdout/stderr
overflow and SIGKILL of a hung child ignoring SIGTERM. They are **not Microsoft
executables** and are never installed into the runtime toolchain.

The Draft PR records whole-repository checks, independent review, submitted
tree and observed GitHub CI. Root CI discovers this package through existing
globs; that does not establish Windows/MCP acceptance.

## Deferred integration and acceptance

1. **MCP owner:** register strict `windows_open` and `windows_reveal` schemas
   in `packages/mcp/`, rejecting unknown execution-related fields. Preserve
   directory-only opening and validate targets before dispatch. Keep #100 OPEN
   until the actual tools are registered.
2. **Application/policy owner:** compose task-scoped filesystem authority,
   existing #47/#99 conversion, trusted runner/PATH and audit handling in
   `apps/agent/`. Record normalized target metadata, never generated command
   text or raw process errors. Verify constrained typed ALLOW and that raw
   PowerShell/CMD/arbitrary Windows executables still require normal approval.
3. **Shared workspace owner:** coordinate #205's empty lockfile importer and
   later consumer dependencies. This PR changes no root configuration,
   dependency declarations or lockfile and runs no install in this checkout.
4. **Security/native owner:** run actual MCP escape/approval tests, filesystem
   authorization/race review and the matrix below. Root `test:security` is
   absent at this base; package tests do not substitute for that later
   cross-package suite.
5. **Release owner:** keep the stacked PR Draft/unmerged; do not merge it or
   #205 into M2/main before #77 completes. Avoid issue auto-close keywords
   while registration/native gates remain open.

### Target Windows/WSL matrix — NOT_RUN here

The target machine, real Explorer, browser and WSL interop are unavailable.
Record actual Windows/WSL/Node versions, process result, observed UI and any
failure for each check before accepting native behavior:

| Native check | Status |
| --- | --- |
| Open an approved existing WSL directory | NOT_RUN |
| Open an approved mounted-drive directory with dynamic mapping | NOT_RUN |
| Reveal an approved file with spaces, Korean, emoji and apostrophes | NOT_RUN |
| Reveal an executable/shortcut fixture without running it | NOT_RUN |
| Submit an approved HTTP/HTTPS URL to the default browser | NOT_RUN |
| Check quoting, trailing separators, UNC paths and Explorer exits | NOT_RUN |
| Reject protocols, option payloads and unsupported comma/quote paths | NOT_RUN |
| Actual MCP registration, audit and raw Windows approval regression | NOT_IMPLEMENTED / NOT_RUN |

For a deliberate smoke run in the target WSL distribution, set three variables
to approved test targets (directory/file are Linux paths), then run:

```bash
corepack pnpm --filter @gram/windows-integration build
node --input-type=module - "$APPROVED_DIRECTORY" "$APPROVED_FILE" "$APPROVED_HTTP_URL" <<'JS'
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import {
  WindowsOpenService,
  WindowsPathService,
  WindowsRevealService,
} from './packages/windows-integration/dist/index.js';

const [directory, file, url] = process.argv.slice(2);
assert(directory && file && url, 'Provide three approved test targets.');
const paths = new WindowsPathService();
await new WindowsOpenService().openPath(await paths.toWindows(await realpath(directory)));
await new WindowsRevealService().revealPath(await paths.toWindows(await realpath(file)));
await new WindowsOpenService().openUrl(url);
console.log('Launcher calls completed; independently verify the exact Windows UI targets.');
JS
```

Do not reinterpret exit 1 as success without target evidence or retry
automatically: a native handoff might already have occurred.

## Design references

- M4 plan, Task 2: `docs/superpowers/plans/2026-09-15-m4-windows-integration-ux.md`.
- Architecture §§13/18/22: `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`.
- [Microsoft WSL FormatCommandLine](https://github.com/microsoft/WSL/blob/master/src/windows/common/interop.cpp).
- [Microsoft Windows naming/namespace rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
- [Microsoft ShellExecuteEx and handlers](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw).
- [Microsoft folder-only Explore API](https://learn.microsoft.com/en-us/windows/win32/shell/ishelldispatch-explore).
- [Microsoft folder/item selection API](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems).
