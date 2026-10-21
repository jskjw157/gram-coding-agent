# Owner-authorized local workspace — Issue 228

This expands PR #227; it does not replace multi-root access with a single read-only project. The owner authorized implementation, reviewed merges and a safely verified operational upgrade. Existing v0.1.0, Tasks, worktrees and evidence remain untouched until deployment gates pass.

## Authority boundaries

- Only trusted local configuration adds Windows drives and WSL roots. Remote callers select a configured root and a relative path. Hidden names and unknown extensions are not grounds for denial.
- Controller state, credentials, executable code, native helpers, tunnel configuration and installation authority are protected, including ancestors, aliases and hardlinks. Ordinary project credentials receive masked previews; raw disclosure uses a separate local owner-presence ceremony and protected local display, never an MCP response.
- Credential authorization binds one operation, root/file identities, destination, preimage and intended change. It expires, is consumed once, and does not survive restart. Existing remotely callable approval tools cannot grant this authority.
- Typed filesystem authority is distinct from developer command authority. No request specifies an executable, shell, environment, native helper path or privilege. Existing M5 process isolation remains mandatory for project commands.

## Filesystem implementation

A strict bounded facade owns root resolution, content screening, opaque versions for sensitive content, operation serialization, private recovery records and metadata-only audits. Text and binary operations screen complete content before pagination or encoding. Search has explicit continuation and resource bounds. Directory operations and cross-filesystem transfers report their actual semantics; a multi-phase transfer cannot claim atomicity.

Path traversal must reject symlink/junction/reparse escapes, alternate data streams and multiply linked files. All mutations retain recoverable preimages. Optimistic version checks do not imply kernel compare-and-swap against an uncooperative external writer. Conflicts preserve captured versions and report recovery requirements; no automatic rollback may overwrite another writer.

The backend must prove containment on the actual filesystem. On this host the unchanged Landlock entry permits ext4 operations and denies moved-parent reopen/create, but rejects even positive DrvFs operations. It also retains authority through already-open writable descriptors. Therefore it cannot be advertised as a working Windows backend. A fixed typed Windows handle backend must independently prove ancestor pinning, reparse/hardlink denial and no-replace rename. A WSL backend must use a proven confinement boundary. Unsupported cases fail closed rather than falling back to unrestricted Node filesystem operations.

Native worker code and imports must be installed with trusted immutable provenance. A read-only bind of an owner-writable checkout is insufficient. Request/result IPC is bounded and contains no raw credential exports. Recovery storage is private and authenticated; backups must not follow pre-existing symlinks.

## Developer workflow

Git inspection and registration validate actual root and repository metadata. Development operations expose only named repository scripts (`lint`, `test`, `build`, bounded foreground `dev`). A dedicated persisted `LOCAL_COMMAND` workflow owns a genuine Task, workspace, Repo Lock and command run. Its scoped completion rule must not weaken coding Task publication/CI requirements, and the ordinary coding scheduler must not dispatch it. Missing scripts and failed commands remain failures.

## Verification and deployment gates

Use behavioral RED then GREEN for each change, full root/unit/E2E/security/native CI, independent code/security review, and harmless Windows/WSL probes. The real mc-web project is read-only during validation. Before upgrade: online database backups and restore checks, exact Task/Lock/process snapshot, no active work, preserved worktrees and rollback evidence. After upgrade: exact source/dist/runtime identity, healthy MCP/tunnel, controller credential denial and fixture recovery tests. Actual ChatGPT tool discovery and calls are separate acceptance gates from server tools/list. Do not claim deployed or close #228 from code or CI alone.

## Current evidence

Baseline PR #227: `1723856d8baaddebbf9fb08c005c87be26bc3c25`; main: `85c7c6c6f7ff00868160ef195180b98405159b8c`. Independent diagnostic probes are retained under `C:\source\gram-agent-diagnostics\issue228\security-discovery`. No production changes were required for those probes. Native owner presence is available on this Windows host, but availability is not an approved operation or a completed human ceremony.
