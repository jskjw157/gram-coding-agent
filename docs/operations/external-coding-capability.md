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

This implementation is a fixture-verified capability foundation. Snapshot-aware repair and live controller acceptance remain separate integration work. Production verification plan/run/reviewer registration is described below. #159 and #77 live acceptance must not be declared complete from unit/fixture success; Windows/WSL and real authenticated controller execution have not been performed.

## Production verification review

After MODIFY, the task enters VERIFYING. Gram now creates a fresh plan from the exact registered workspace HEAD and file snapshot. Required commands are the union of every changed path's requirements and must be explicitly declared in the repository profile; a missing/blank declaration is a configuration failure. Commands still use normal policy/approval handling. Any UI-related change currently fails with a browser-evidence-provider error, even if browser capability is declared. Mixed UI changes cannot bypass this refusal.

Poll `verification_review_get` with task UUID. A pending review supplies task/review/workspace/plan/check identity, HEAD, snapshot digest, check name, expiry and candidate paths. Only secret-scan and diff-review are supported in this stage. For each candidate call `verification_review_read` with the full supplied identity and path. It returns a bounded exact before/after view and a digest unique to that review. Read all paths separately for each check; digests from another check or attempt are invalid.

Submit `verification_review_submit` with the same identity, `status: PASS`, acknowledgements containing every `{path,digest}`, and `approvedPaths`. Secret scan requires an empty approved-path list. Diff review requires a nonempty unique subset of the acknowledged candidates. Review means the authenticated controller actually inspects the supplied changes for that named gate; echoing digests is not substantive review. Gram proves the input/evidence binding, not reviewer judgment. A controller can reject with `status: FAIL` and empty acknowledgement/path arrays, or call `verification_review_fail` to abort the wait. No review tool can write files, run arbitrary commands, or supply its own evidence reference.

Review reads refuse hidden/credential paths, symlinks/hardlinks, invalid UTF-8, binary/oversized data and recognizable secrets. Historical absence is proven through successful Git tree inspection. Source Git reads use a separate bounded runner; durable output files contain omission/hash markers only. Ordinary verification command logs retain normal redacted output. No source text or free-text controller response is saved in review rows.

Each accepted review is persisted once, bound to its check and the frozen snapshot. Snapshot equality is checked around every command and review, and again before sealing. Cancellation, lost/replaced leases, workspace changes, replacement plans, process restart, timeout or shutdown cannot create successful review evidence. Existing immutable commit/push guards still verify exact approved content. Repair remains fail-closed; this is fixture-verified integration and does not establish live controller, Windows/WSL or #77 acceptance.
