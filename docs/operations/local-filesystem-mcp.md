# Owner-authorized Windows/WSL filesystem MCP

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
