# Bounded native reads for local Git

The owner requested a complete repair after PR240's capture-only timing pass failed exact-build live Git validation. Existing owner-workspace and M5 boundaries remain mandatory. This amends performance composition, not filesystem authority or disclosure policy.

## Design

Keep private snapshots and fixed network-free Git execution. Status/diff still capture admitted worktree files. Log/head/tracked/identity capture only Git metadata: their fixed commands consume no working-tree contents. Metadata-only capture does not prove a clean working tree and cannot authorize command execution.

The controller coalesces concurrent native stat/read/readGitChunk calls only when root, protectedPaths, protectedMutationPaths and operation are exactly equal. A single readBatch helper envelope holds ordered strict items, not executables or caller policy. Limits are 16 stat items, two ordinary reads, eight 256-KiB Git chunks. List requests and all mutations retain their original single-request route. Bound the controller queue to 256 requests and four concurrent read frames. A single request may retain its original protocol.

Before each native process, revalidate the exact helper descriptor/digest and file metadata; do not cache integrity by TTL. Existing five-second native watchdog, six-second transport watchdog and input/output bounds remain. Batch stdout is at most 4 MiB. Native validates every child schema and the whole batch before any item, rejects nesting/mixed operations/overrides/mutations, then invokes the existing contained native operation for each item. Any failure denies the entire batch without partial response. Every resolved item still passes original client shape/root/file identity validation. No raw bytes enter new logs or MCP responses.

Windows snapshot reads carry an internal paired projectPath/expectedProjectIdentity guard. Native checks a segmentwise case-insensitive prefix and the exact selected project's directory identity while its existing non-delete-shared ancestor handle is held; root/equal-project requests retain a corresponding root or extra leaf pin. Guards cannot be attached to mutations/treeStat or supplied through MCP operation fields. Every native listing/stat/read/chunk carries the guard. The controller retains held WSL project-identity pre/post observations and initial/final native project observations, replacing redundant standalone project-stat processes with stronger per-operation held-handle checks. POSIX behavior is unchanged.

Snapshot source verification, private directories, symlink/hardlink/reparse/alternate rejection, byte/count/depth limits and failure draining remain. Queued controller promises settle on success/failure without duplicate completion; no failed frame is retried automatically.

Read-only diff capture has a separate 8-MiB combined output bound because real multi-file diffs can exceed the original 1-MiB cap. Application Git, config parsing, status and log remain bounded at 1 MiB. The private namespace stays network-free and read-only. Screen the complete captured transcript before the existing 32-KiB MCP preview; a credential beyond 1 MiB must mask the whole preview. Output overflow still terminates and reaps the isolated process.

## Operational gate

Build and test the real helper under current Windows application policy. Install only through existing protected installation and exact pin update; no SAC bypass, generic command API, secret changes, force cleanup or Task/Lock recovery. Preserve current service until exact candidate, CI, independent review, real mc-web reads, restore-verified backup and copied-state startup pass. Main merge is outside this fix. Publish measured Git/API timing and any remaining limitation honestly.
