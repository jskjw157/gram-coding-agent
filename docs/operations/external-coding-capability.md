# External coding rendezvous

The normal authenticated MCP route now exposes `coding_step_get`, `coding_step_read`, `coding_step_submit`, and `coding_step_fail`. No model SDK or second credential is introduced. All tools require the existing tunnel/internal-secret authentication. Task/step UUIDs identify work; they do not authenticate a controller. There is one authenticated controller trust domain, not a multi-tenant owner authorization scheme.

## Controller flow

1. Submit a task with the existing `task_create` tool. Once the runtime has acquired its repository lease and created a workspace, poll `coding_step_get` with its task UUID.
2. For INSTRUCTIONS, consume the actual root AGENTS.md content (or the explicit absence marker) and submit the task UUID, step UUID, phase INSTRUCTIONS, and exact supplied digest. Never invent a digest for a different instruction snapshot. Nested instructions remain the controller's responsibility; use task-scoped reads before editing the corresponding source.
3. For ANALYZE, use `coding_step_read` with the current task UUID, step UUID and a canonical relative path to inspect ordinary source. Submit phase ANALYZE, a nonempty summary and unique intended source file paths. Analysis paths confer no publication approval.
4. For MODIFY, submit phase MODIFY and one or more patches. Each patch contains `path`, `expectedSha256` (the hash from a current read, or null for a new file), and complete replacement `content`. Paths must be in the accepted analysis. Empty or unchanged mutations are rejected. All paths and old-content hashes are checked before any write. This is not a filesystem transaction: an IO failure halfway through a batch can leave partial edits and requires inspection.
5. The runtime runs its existing verification/publication flow. Accepted coding output is not verification evidence. `coding_step_fail` explicitly fails the current wait without releasing an unconfirmed-push lock.

## Reconnect and failure

Re-read the pending step after a controller connection interruption. Its UUID stays stable within the running process until it is consumed, failed, or expires (30 minutes by default). A valid result is consumed once; repeating a submission cannot write twice. On submission errors inspect `coding_step_get` before deciding what to do. Correctable validation errors leave the same step pending; mutation failures terminate it and cannot be automatically retried.

Shutdown rejects pending waits before draining the scheduler. Process restart marks any durable PENDING/APPLYING rows INTERRUPTED and never replays their mutations. Use existing explicit task/lock/workspace recovery after inspecting the working tree; restart is not automatic resume. Repository locks remain held until the established confirmed-push or explicit recovery flow permits release. The independent heartbeat continues while the process awaits a controller.

## Deliberate limits

Reads/writes reject symlinks, hardlinked files, all hidden path segments (including Git/configuration stores), named credential/key paths, binary/oversized content, and recognizable secrets. Files are limited to 256 KiB; batches to 100 paths. This is an application boundary, not OS isolation against a malicious same-user process. Only exact file replacement is exposed, not shell commands or arbitrary Git operations. The command approval gap #151 remains fail-closed.

This implementation is a fixture-verified capability foundation. Production verification plan/run/reviewer registration and snapshot-aware repair remain separate integration work. #159 and #77 live acceptance must not be declared complete from unit/fixture success; Windows/WSL and real authenticated controller execution have not been performed.
