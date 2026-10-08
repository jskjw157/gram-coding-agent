# Windows clipboard preparation — #101

This package implements the adapter portion of M4 Task 3 on top of #207 at
`41dbe1938fe6164840c81bc565e7830b4f57e1e9`. Only `packages/windows-integration/`
changes. The existing #99 conversion and #100 Open/Reveal boundaries are retained.

**MCP `windows_clipboard_read` / `windows_clipboard_write` are not registered.
Typed ALLOW wiring is not implemented. Keep #101 OPEN and this stacked PR
Draft/unmerged; do not merge into main/M2 before #77 completes.**

## Public service and trusted composition

```ts
import { SecretRedactor } from '@gram/secrets';
import { WindowsClipboardService, type WindowsClipboardOptions } from '@gram/windows-integration';

// Host composition example, not an MCP registration or secret-loading API.
function configureClipboard(registeredSecrets: readonly string[], audit: WindowsClipboardOptions['audit']) {
  return new WindowsClipboardService({
    redactor: new SecretRedactor(registeredSecrets),
    registeredSecrets,
    audit,
  });
}
```

The service exposes:

```ts
readText(): Promise<{ readonly text: string; readonly redacted: boolean }>;
writeText(text: string): Promise<void>;
```

The actual existing `SecretRedactor` is reused through its `redact(text): string`
port. The package does not copy its implementation, import application
orchestration, or add a dependency declaration that would require changing the
shared lockfile. Tests import the existing `packages/secrets/src/redactor.ts`
source directly; only the package's no-emit test TypeScript root is widened.
Production build output contains only this package's production sources.

The redactor, complete registration snapshot, audit sink, and optional
`ClipboardRunner` are **trusted host configuration**, never tool arguments.
There is no optional identity redactor. The registration list and method bindings
are snapshotted at construction and stored in JavaScript private fields.
The host must construct a new configured service when credential registrations
change. The current application bootstrap's registration of only its internal
MCP secret is not a complete credential inventory.

The optional runner is an in-memory test/host port with only
`readText(): Promise<Uint8Array>` and `writeText(utf8: Uint8Array): Promise<void>`.
Its bytes are private transport data. Only the service's validated read result
may cross the external response boundary. Injected implementations own their
deadlines and side effects; the default child's timeout does not bound arbitrary
redactor, runner, or audit code.

## Text and size contract

| Case                                                                      | Behavior                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Maximum payload                                                           | **1,048,576 UTF-8 bytes**, inclusive, on both read and write. The final redacted response has the same limit.      |
| Empty read / no Unicode text format                                       | Return `{ text: '', redacted: false }`. No image, file list, RTF or HTML is returned or converted by this adapter. |
| Empty write                                                               | Clear the clipboard, including its other formats.                                                                  |
| Nonempty write                                                            | Set only Unicode text, replacing the previous clipboard contents. Return `void`, never an echo.                    |
| Whitespace, LF/CRLF, Korean, emoji, quotes, backticks, shell-like strings | Preserve as text data. Do not trim, split lines, normalize Unicode, or evaluate content.                           |
| Leading U+FEFF / valid U+FFFD                                             | Preserve as actual characters.                                                                                     |
| NUL, unpaired UTF-16 surrogate, non-string write                          | Reject. NUL is incompatible with the native NUL-terminated Unicode clipboard format.                               |
| Invalid, overlong, truncated or non-UTF-8 process bytes                   | Reject using fatal UTF-8 decoding; never silently insert replacement characters.                                   |
| Oversized input/output or redaction expansion                             | Reject; never truncate a potentially secret-bearing response.                                                      |

ASCII, Korean and emoji boundary tests distinguish UTF-8 byte size from string
length. Audit `characterCount` is separately defined as **UTF-16 code units**.
Writes may contain secrets: they are intentionally written as supplied. They are
not returned, logged, or included in audit data.

## Verifiable secret handling

Before reading the clipboard, the service verifies a required redactor and
registration configuration with small marker/token probes and registered-value
checks. The registration snapshot allows at most 256 entries and 64 KiB of
combined UTF-8 secret values. Empty, malformed, NUL-containing, and
replacement-marker-conflicting registrations fail closed. Such conflicts can
make the existing redactor non-idempotent or amplify intermediate replacements.

Every actual read is decoded and bounded, passed to the configured redactor, and
independently checked before return:

1. The output is a synchronous primitive string with valid Unicode and the byte
   limit above.
2. No registered exact value remains, including regex punctuation and overlapping
   registrations.
3. No recognized credential shape remains.
4. A second redaction pass is identical to the first.

The existing #19 implementation masks exact registered values, Authorization
Bearer values and its OpenAI/GitHub token families. This boundary also detects
those families without the existing leading-word-boundary blind spot. It
conservatively **rejects** residual Slack-shaped tokens, AWS access-key IDs, JWT
shapes beginning with `eyJ`, and PEM private-key headers when the redactor leaves
them behind. It does not invent a second masking implementation.

An absent, identity, throwing, asynchronous, malformed, oversized, selective or
non-idempotent redactor produces a fixed failure. Rejected native Promises from
an accidentally asynchronous redactor are consumed while its output is still
refused, preventing an unhandled rejection from printing clipboard diagnostics.

These checks do not authenticate arbitrary injected code or discover unknown,
obfuscated or unregistered secrets. Complete and current secret registration and
trusted redactor composition remain the host's responsibility. Common-shape
rejection can reject benign text that resembles a credential.

## Fixed native transport

The internal `FixedClipboardRunner` is not exported by the package barrel.
It has only text read/write operations. Callers cannot choose a process,
executable, argv, script, environment, shell, encoding, or timeout.

The default launch is a direct `node:child_process.spawn` call:

```text
powershell.exe
-NoLogo -NoProfile -NonInteractive -STA -EncodedCommand <internal code constant>
```

The read and write scripts are immutable source constants encoded as UTF-16LE
Base64. Clipboard values never occur in source or argv. Writes send UTF-8 bytes
through stdin; reads receive UTF-8 bytes through a private stdout pipe. These
pipes are in-memory data channels, not captured application logs.

- `shell: false`, all three stdio streams piped, `windowsHide: true`.
- Fixed five-second Node child timeout with `SIGKILL`.
- Read stdout is retained only up to 1 MiB. Any write stdout fails.
- Stderr is never retained or forwarded; any stderr bytes fail the operation.
- Nonzero exit, signal, stream failure, missing executable, overflow or timeout
  fails without retry or fallback. No child diagnostics are attached to errors.
- A small host environment allowlist forwards `PATH`, `WSL_INTEROP`,
  `WSL_DISTRO_NAME`, `SystemRoot` / `SYSTEMROOT`, `WINDIR`, `TEMP` and `TMP`.
  No other Node-worker variables or `WSLENV` are forwarded. The host owns trusted
  executable discovery and Windows-side environment configuration.
- No `-ExecutionPolicy Bypass`, elevation, credentials, raw-shell approval change,
  generic command runner, or policy grant is introduced.

The fixed scripts use `System.Windows.Forms.Clipboard` Unicode text methods and
raw .NET standard streams with strict `UTF8Encoding(false, true)`. Native writes
read at most 1 MiB plus one overflow-detection byte before changing the clipboard.
Native reads check Unicode, NUL and UTF-8 byte size before emitting data. Their
catch blocks exit nonzero without writing the caught exception.

## Audit and failures

Each attempt with an available audit sink emits only this frozen event shape:

```ts
{
  operation: 'READ' | 'WRITE';
  result: 'SUCCESS' | 'FAILURE';
  characterCount: number | null;
}
```

The count is null until valid text is obtained. There is no raw/redacted body,
content hash, process output, script, argv, exception, credential or clipboard
preview. The adapter has no logger and never calls the shell output-capture
component, which persists process output.

A missing audit sink prevents a native operation. A sink failure prevents a read
response and yields `AUDIT_FAILED`. Because completion audit occurs after the
operation, a write may already have changed the clipboard when audit fails.
There is no rollback promise or automatic retry. The same uncertainty applies
to native failures after a partial write.

`WindowsClipboardError` exposes a fixed code/message only:

| Code                | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `INVALID_TEXT`      | Invalid string, Unicode or NUL input.                                                          |
| `INVALID_ENCODING`  | Invalid bytes at the service's trusted runner boundary.                                        |
| `PAYLOAD_TOO_LARGE` | Text exceeds the service byte limit.                                                           |
| `REDACTION_FAILED`  | Safe output configuration or actual redaction could not be verified.                           |
| `AUDIT_FAILED`      | Audit sink unavailable or failed.                                                              |
| `CLIPBOARD_FAILED`  | Runner/native operation failed; native encoding/size failures are also sanitized to this code. |

No caught `message`, `stack`, `cause`, `stdout` or `stderr` is copied.
Public failures are recreated from internal error identities without inspecting
hostile rejection-object properties.

## Verification and remaining acceptance

Package commands:

```bash
corepack pnpm --filter @gram/windows-integration test
corepack pnpm --filter @gram/windows-integration typecheck
corepack pnpm --filter @gram/windows-integration lint
corepack pnpm --filter @gram/windows-integration build
```

The service suite uses the actual existing SecretRedactor and trusted fake byte
runners. The process suite starts real **Linux fixture programs** named
`powershell.exe`, using only synthetic data. It verifies exact fixed argv, stdin
fidelity, byte boundaries, split multibyte/token data, environment filtering,
parent-output/audit secrecy, errors, overflow, early pipe closure and timeout.
It does **not** execute the PowerShell constants or Microsoft clipboard APIs.
The original #99/#100 tests are retained.

The PR records RED/GREEN commits, independent review, full root
lint/typecheck/test/E2E/build results and actual GitHub CI separately. Existing
policy tests cover approval requirements for raw PowerShell/pwsh/CMD. Passing
them does not establish a registered typed clipboard ALLOW path.

**Windows native / real WSL interop / native script execution: NOT_RUN.**
Target-host acceptance must verify PowerShell 5.1 parsing, STA access, Unicode
text ownership/persistence, empty clearing, multiline/Korean/emoji/BOM fidelity,
1 MiB boundaries, contention, invalid text, native environment and termination.
Run against disposable non-secret clipboard fixtures and record only fixed
status/count evidence. Do not print clipboard values on assertion failure.

`Clipboard.GetText` materializes a native string before the size check, so the
child timeout and output bound are not a native memory quota. Killing the Node
child during WSL interop is not yet proof that every Windows-side operation has
stopped. These are target-host verification limits, not claims of native safety
established by Linux fixture execution.

### Integration owner handoff

1. **MCP:** register strict `windows_clipboard_read` and
   `windows_clipboard_write` schemas. Reject unknown execution/format fields.
   Route external reads only through `WindowsClipboardService`, never through
   the raw-byte runner. Bound UTF-8 bytes, not merely schema string length.
2. **Host/secrets:** supply the existing SecretRedactor, a complete matching
   registration snapshot and a task-scoped metadata-only audit sink. Refresh
   composition when credentials change; never serialize clipboard bodies at the
   MCP ingress, response logging, task evidence or outer audit boundaries.
3. **Policy:** connect typed ALLOW only for these constrained operations, through
   actual MCP dispatch; prove raw PowerShell/CMD/arbitrary executable operations
   still require their existing approvals. No policy files change in this PR.
4. **Workspace:** coordinate consumer dependencies and #205's empty lock importer
   with the shared integration owner. Root settings and lockfile stay unchanged.
   Prepared local dependencies are not a fresh local frozen-install claim.
5. **Acceptance:** run real Windows/WSL and end-to-end MCP security tests. Both are
   **NOT_RUN** in this preparation. Root `test:security` is absent at this base;
   package security regressions do not replace future MCP/policy integration.
6. **Release:** retain #101 OPEN until integration, and retain this PR's stack on
   #207. No #205/#207/M2/main merge is performed before #77 completion.

## Primary API references

- [PowerShell executable options and EncodedCommand](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)
- [Clipboard.GetText](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.gettext?view=netframework-4.8.1),
  [SetText](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.settext?view=netframework-4.8.1)
  and [Clear](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.clear?view=windowsdesktop-10.0)
- [Strict UTF8Encoding](https://learn.microsoft.com/en-us/dotnet/api/system.text.utf8encoding.-ctor?view=netframework-4.8.1)
- [Windows standard clipboard formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)
- [Node TextDecoder BOM and fatal-decoding options](https://nodejs.org/docs/latest-v24.x/api/util.html#new-textdecoderencoding-options)

Repository references: M4 plan Task 3; architecture sections 18, 19 and 22;
`packages/secrets/src/redactor.ts` (#19).
