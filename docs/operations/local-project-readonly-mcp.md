# Opt-in local source inspection through Gram MCP

**Historical prototype, superseded by Issue 228.** The current agent rejects
`GRAM_AGENT_READONLY_PROJECT_ROOT`; do not enable the legacy drop-in below.
Use the [current multi-root native runtime guide](local-filesystem-mcp.md) and
[activation gates](issue-228-activation-gates-20261022.md). The following preserves
the earlier prototype contract, not the current deployment procedure.

This feature registers exactly two read-only tools only when a trusted Agent service
configuration explicitly sets an existing, canonical, one-project directory.

For the owner's requested Windows directory:

    C:\source\mc-web

the WSL root is normally:

    /mnt/c/source/mc-web

A **root-owned** systemd drop-in can set the following service-only value after the
administrator has checked the actual directory, its owner, and the target service:

    [Service]
    Environment="GRAM_AGENT_READONLY_PROJECT_ROOT=/mnt/c/source/mc-web"

Do not place the setting in public client requests, repo files, or chat-visible
credential configurations. Do not change global environment or make the MCP
listener public. The default remains **off** when this variable is unset.

Exposed tools after a reviewed deployment and an updated MCP catalog:

- local_project_list({ "path": "." }): at most 120 visible source directories/files
- local_project_list({ "path": "src" }): immediate children of src
- local_project_read({ "path": "src/App.tsx", "startLine": 1, "maxLines": 120 }): bounded UTF-8 lines

No arbitrary root or absolute paths may be provided by the caller. No shell
execution, file writes, task creation, repository mutation lock or Git operations
are available through these tools. Dotfiles and hidden directories (including
.git and .env), node_modules, build output, sensitive names, non-source extensions,
hardlinks, symbolic links and traversal paths are denied or omitted. Parent
directories are opened by descriptor using O_NOFOLLOW and /proc/self/fd.
The reader rejects suspicious credentials, patterns covered by SecretRedactor,
binary/non-UTF-8 files and files larger than 256 KiB. Read responses are capped
to 200 lines and 32,000 characters. The connector does not return full host paths.

These bounds reduce accidental exposure but cannot guarantee detection of
unknown secret formats in permitted source files. Enable the opt-in only on a
project the owner explicitly authorizes to share with ChatGPT. The folder
listing itself may reveal confidential source names.

Before enabling in production:

1. Confirm the target is the actual directory on Windows and WSL; validate
   DrvFs symlinks, Windows junction/reparse points, ancestor races, directory
   descriptors and /proc/self/fd with real WSL probes.
2. Run all repository CI gates and independent security review; preserve evidence.
3. Confirm no active Task/Repo Lock; take validated online backups of the Agent
   and observer SQLite databases. Preserve all existing Task/worktree evidence.
4. Install the root-owned opt-in service drop-in, validate systemd properties,
   source/dist manifests and rollback inputs. Use normal guarded tunnel/Agent
   stop/start with PID/starttime/cgroup verification, no SIGKILL.
5. Confirm actual ChatGPT MCP tools/list includes two *additional* read-only tools;
   test listing src and reading a harmless UTF-8 source file under mc-web. Verify
   traversal and secret-file reads fail and no mutations occur.
6. If the new app tool schema remains cached in ChatGPT, reconnect/refresh the
   Gram connector. Do not claim the feature is live until its tools are visible
   through an actual external tool call.

No change to Windows folder contents is required. Never solve missing permissions
by running the controller as root or broadening access to other project roots.
