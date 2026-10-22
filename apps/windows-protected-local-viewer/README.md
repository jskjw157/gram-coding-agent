# Protected local viewer

Build with `build.cmd <absolute-output.exe>` using installed Visual Studio C++
tools and the Windows SDK. Supply the resulting canonical path, SHA256 and owner
SID only through trusted agent composition. The helper and all its ancestors
must have installation ACLs preventing workspace/untrusted replacement. The
TypeScript hash check does not atomically bind CreateProcess to a file handle.

The fixed stdin-only `view` protocol accepts at most 256 KiB of nonempty strict
UTF-8 text. It verifies the SHA256 of the exact decoded bytes, expiry and current
Windows process owner SID before requesting Windows Hello for its own visible
window. It paints inert text only after Windows Hello returns Verified. The
window has no edit control, clipboard action, file output or content-bearing
caption. Windows 11 capture exclusion is required and queried before and after
Windows Hello; unsupported or failed exclusion denies disclosure. These APIs do not
prevent photographs or capture through unsupported mechanisms.

The only responses are content-free DENIED, UNAVAILABLE or DISPLAYED statuses.
DISPLAYED means the approved snapshot was rendered locally, not that anyone
read it. The window closes on cancellation or expiry. The agent caller must check
controller-secret exclusions and current file identity/content before calling
the viewer. No raw content belongs in an MCP response or log.

`test-protocol.ps1 -HelperPath <absolute-output.exe>` exercises malformed-input
and digest/action denials only. It cannot reach Windows Hello. Mocked TypeScript
tests exercise transport validation; neither test set proves actual owner
presence, display behavior or capture exclusion. Those require a separately
coordinated interactive owner test on the target Windows installation.
