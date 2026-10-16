# Native Mac local installation boundary

The user requested earlier installation on their Mac. Installation preparation
is authorized; the persistent account, service and local-key changes listed
below are awaiting one explicit scoped approval. Administrator authentication
must be entered directly in the macOS authentication UI, never in chat or logs.
Main merge and remote account/trust/enrollment/tunnel setup are separate actions.

## Target and preflight

Native macOS 26.2 / arm64. Read-only preflight observed no HAAR/GramAgent root,
Gram launchd plists, registered Core/Tunnel jobs, disabled overrides or
`gram-agent` account. Ports 3847 and 3848 were both free. `/Library`,
`/Library/LaunchDaemons` and `/Library/Application Support` were root-owned
and not group/world writable. Noninteractive sudo returned AUTH_REQUIRED.
These observations must be repeated immediately before any privileged write.

The previous tested bundle at source `d41a20c` has release digest
`a2d303dc5cf783f6fcdc42582471ad7e3530c0c12a132ec3cb0a53a8153674e6`;
all 2,184 manifest entries and its HEAD lockfile were rechecked without changes.
The completion-freshness correction below supersedes it as the installation
candidate. Install only the final approved source SHA's sealed bundle after
its hash, complete inventory, reviewed lockfile and current-SHA checks pass.

## Exact minimum privileged scope

- Create only the missing local `gram-agent` non-admin service account, with an
  unused UID, primary group staff, hidden UI entry, `/var/empty` home,
  `/usr/bin/false` shell and password login disabled. No admin, SSH, SecureToken
  or FileVault grant is part of this step.
- Create `/Library/Application Support/HAAR/GramAgent` and its reviewed release,
  `bootstrap/bin/file-acl`, `config`, `run`, `state`, `secrets` and `logs` paths.
  Executables/configuration are root-owned and non-writable by the service user.
  Runtime directories belong to `gram-agent`, mode 0700. The ACL helper is a
  mode-0755 metadata reader, without setuid or ACL-changing functionality.
- Generate a fresh 256-bit loopback MCP authentication key locally. Store it
  only in `secrets/mcp-internal-secret`, owner `gram-agent`, mode 0600. Never
  print its bytes or place them in command arguments, Git, SQLite, logs or MCP
  responses. This key is separate from any external-account credential.
- Use the fixed native operator's reviewed preview/apply/start flow to create
  `/Library/LaunchDaemons/com.haar.gram-agent.core.plist`, owner root, mode 0644.
  It runs as `gram-agent`, with RunAtLoad/KeepAlive and fixed executable paths.
  Its persistence includes restart after a crash and startup after reboot.
- Bind Core only to 127.0.0.1:3847. Keep tunnel disabled, with no tunnel plist,
  no 3848 listener, no remote exposure and only the `agent_health` tool surface.

Do not alter existing installations/accounts/plists or unrelated HAAR data.
An unexpected existing target, occupied/unknown port, unsafe path, mismatched
release or unknown service state is a stop condition, not permission to delete
or override it. Preserve partial-install evidence and report the failed phase;
do not blindly retry mutations or run the disposable CI cleanup on this Mac.

## Execution and evidence

After the scoped approval, the reviewed fixed installation command can be run
using AppleScript `do shell script ... with administrator privileges` to open
the native macOS authentication dialog. The user enters their password there.
Authentication cancellation/denial is a stop; do not collect the password or
substitute a broad passwordless sudo configuration.

Record the approved SHA/release digest, exact phase and sanitized operator
result; assert the committed manifest/plist modes, native owned health and
local health endpoint. A missing/incorrect MCP key must still be denied.
Report local installation/running separately from remote-account connection.
LAB_ONLY and businessReadiness UNAVAILABLE remain the truthful output even
when Core is locally healthy. Reboot/logout acceptance is a separate test.

## Removal and rollback

This is a fresh installation: there is no prior installed version to restore.
The native operator can stop the verified Core and remove only manifest-owned
matching plists. Normal uninstall preserves state/database, key, logs,
releases and the service account; a fixed-label launchd override can also remain.
Purging these retained resources requires a separate explicit scope.
The public native version/database rollback port is currently unavailable;
do not promise a previous-version rollback or modify/copy databases as a shortcut.

## Completion-freshness correction

Independent review reproduced status that was 29,999 ms old when read, then
30,001 ms old after the final asynchronous registration guard, while native
ownership remained valid. The native internal healthy predicate had accepted it.
The diagnostic projection already revalidated freshness, but the service and
running-control predicates did not. The observer now applies the unchanged
`currentStatus` rules after every asynchronous guard completes. Evidence at
30,000 ms or from the future after a clock rollback remains unavailable.
New synthetic observer regressions exercise this exact factory and real record
stores without touching the OS. This is a preexisting lifecycle edge, not a
platform-package regression. Final-head validation is recorded on PR #218.
