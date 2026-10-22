# Owner-authorized Windows/WSL filesystem MCP

## Current native runtime

The starter instructions below are historical. Current production composition
**rejects** `GRAM_AGENT_LOCAL_FS_ROOTS_JSON` and
`GRAM_AGENT_READONLY_PROJECT_ROOT`; do not deploy either legacy environment value.
The feature remains off unless trusted local configuration enables it.

The service setting is `GRAM_AGENT_OWNER_WORKSPACE_CONFIG`, pointing to a
canonical root-owned JSON file with protected ancestors. Its strict schema is
[`OwnerWorkspaceConfig`](../../apps/agent/src/owner-workspace-runtime.ts).
Configuration includes named Windows/WSL roots, actual helper paths and SHA-256
pins, native owner/viewer SID pins, private same-volume recovery vault paths and
measured identities. Do not guess these values or let a remote request set them.
See the [activation gates](issue-228-activation-gates-20261022.md) and
[protected helper installer](../../scripts/windows-owner-workspace-install.md).
An environment variable alone does not provision trusted artifacts or ACLs.

The authorized partial core profile omits `windows.viewer`. Normal filesystem,
Git and policy-based development tools remain available; `local_fs_reveal` is
denied with no raw-content fallback. Windows Hello consent remains required for
credential writes, binary export and destructive operations. A missing or blocked
consent helper cannot be replaced by a remote approval. The optional protected
viewer and its actual Windows admission remain open Issue 228 requirements.

After a verified deployment and external catalog refresh, the native runtime
exposes these typed operations:

| Tools | Contract |
| --- | --- |
| `local_fs_roots`, `local_fs_convert_path` | Discover configured capabilities and convert validated relative paths. |
| `local_fs_list`, `local_fs_stat`, `local_fs_read`, `local_fs_search` | Hidden/config names allowed; bounded pagination/search and whole-content credential screening. |
| `local_fs_write`, `local_fs_patch`, `local_fs_mkdir`, `local_fs_copy`, `local_fs_move` | Version-bound replacement; mkdir/copy/move do not overwrite destinations; journal/recovery evidence. |
| `local_fs_trash`, `local_fs_restore` | Trash requires destructive consent; restore checks bound recovery/version and sensitive/directory consent. No permanent-delete tool. |
| `local_fs_read_binary`, `local_fs_write_binary` | Bounded complete base64 bytes; export always requires fresh native consent, as do opaque/sensitive writes. |
| `local_fs_reveal` | Fresh Windows Hello and local protected viewer; no raw credential text in MCP. |
| `local_repo_register`, `local_git_status`, `local_git_diff`, `local_git_log`, `local_dev_run` | Origin-validated registration, isolated bounded Git reads and real named isolated Task commands. |
| `task_get`, `task_list`, `task_logs`, `task_result` | Durable Task/evidence reads. |

For a configured root named `windows-c`, mc-web read-only requests are:

```json
{"root":"windows-c","path":"source/mc-web","offset":0,"limit":100}
{"root":"windows-c","path":"source/mc-web/src/main.tsx","startLine":1,"maxLines":120}
```

Use the **actual root ID returned by `local_fs_roots`**, not an assumed name.
Versioned operations use the returned opaque `version` as `expectedVersion`, not
a public SHA-256. Write/write_binary to an absent file use `expectedVersion: null`;
copy/move use the source version, and mkdir omits that field. Restore uses null
for an absent destination or its current version when replacement is supported.
Preserve `requestId` on retry and
inspect the returned state: `DENIED` and `NEEDS_RECONCILIATION` are not successful
effects. Never blindly retry an unresolved operation or clear its quarantine.
The recovery receipt supplies the `recoveryId` for restore.

Ordinary reads cap file content at 1 MiB and responses at 200 lines/32,000
characters; text/binary writes cap new content at 256 KiB. Binary read is an
explicitly approved complete bounded snapshot, not an unimplemented streaming
promise. Sensitive/binary metadata does not expose a public content hash.
Git capture and named-command limitations are documented in the
[development evidence](issue-228-development-evidence-20261021.md): oversized or
unsupported captures fail closed, commands use a clean committed base, external
network/dependency installation is unavailable, and foreground `dev` is bounded.

Current source/CI validation is not deployment proof. The target machine's Smart
App Control rejection of the unsigned viewer blocks activation. Existing v0.1.0
and the external old tool catalog remain in use; do not claim the new tools work
externally before actual discovery and calls pass.

## Historical starter instructions — superseded, do not deploy

## Scope

The original local_project_list/local_project_read prototype was single-root and read-only. The owner explicitly requested broad local work. The new local_fs_* tools accept many administrator-configured Windows drive and WSL directory roots; no file extension, dotfile or credential-shaped filename is excluded from listing, status, editing or masked text inspection. Per-root OS permissions still apply and controller state/secrets are protected.

These are typed, authenticated filesystem operations, NOT a generic Windows shell or privilege escalation interface.

## Trusted service configuration

Configure actual existing, canonical Windows drive mounts and WSL roots with a root-owned Agent systemd environment value. Example without real secrets:

    [Service]
    Environment='GRAM_AGENT_LOCAL_FS_ROOTS_JSON={"windows-c":{"path":"/mnt/c","label":"Windows C:","writable":true},"wsl-home":{"path":"/home/jskjw","label":"Ubuntu Home","writable":true}}'

The requested Windows directory C:\source\mc-web is addressed with root windows-c and relative path source/mc-web. Other folders on C: are accessible under that root, and other drives can be added to the trusted root configuration. The remote MCP caller cannot add/change roots.

## Implemented tool surface

- local_fs_roots: list configured root names/capabilities.
- local_fs_list: list paginated files/directories including hidden files.
- local_fs_stat: type, size and SHA256 of bounded files.
- local_fs_read: bounded UTF-8 text/config read; sensitive values masked, filenames permitted.
- local_fs_search: bounded literal recursive text search with masking.
- local_fs_write: create or SHA-verified replace text with private recovery backup.
- local_fs_patch: one unique exact text replacement with expected SHA and backup.
- local_fs_mkdir: create a directory under an authorized writable root.
- local_fs_move, local_fs_copy: SHA-verified file transfer without target overwrite.
- local_fs_trash: recoverable rename, not irreversible deletion.
- task_get, task_list, task_logs, task_result: registered read-only Task state and audit summaries.

Path traversal is rejected. Each directory component is opened via a held FD and O_NOFOLLOW, canonical path and protected paths are checked; no access to controller-managed private state is permitted. File responses are bounded and old content is backed up to restrictive 0700/0600 storage.

## Secret files and advanced capabilities

The owner's .env, credential configuration and hidden files are NOT blocked solely because of a filename. However, normal tool responses mask credential VALUES to prevent accidental leakage into chat or provider logs. Any unmasked secret reveal must use separate explicit, one-time owner authorization with zero secret persistence and cannot read the controller's own credentials. That secure reveal flow is not yet implemented.

Binary streaming/edit, recursive directory movement, complete Git/repository/task command surfaces, explicit audit and human approval for destructive operations remain tracked in Issue #228. This document does not falsely declare them complete.

## Verification required before deployment

1. Complete full project lint/typecheck/unit/E2E/security/build and independent security code review.
2. Run actual WSL/Windows DrvFs, junction/reparse-point, ADS, mount, symlink/hardlink and race regression tests. Do not weaken other M5 protections.
3. Exercise typed tools on a fresh temporary owner-controlled Windows test directory, including masked .env inspection, SHA-CAS edit and recovery. Do not modify the real mc-web directory without an explicit named user task.
4. Before touching services, verify no active Task/Repo Lock, take online backups of both SQLite databases and restore-check them, preserving all historical worktrees and evidence.
5. Install only reviewed root-owned environment override, verified exact source/dist, restart tunnel/Agent with guarded process identity checks and no SIGKILL.
6. Verify actual external ChatGPT MCP catalog includes all expected new tools; tool catalog refresh may be required. Confirm health, backends, contents and denial cases from ChatGPT, not only a local server probe.
7. Never widen the MCP listener to 0.0.0.0, provide arbitrary Windows shell execution, log credential contents, alter original v0.1.0 tag or silently roll back to a less protected build.

Until the Windows/WSL live verification and deployment gate pass, the code exists only in a Draft PR; the running v0.1.0 Agent is unchanged.
