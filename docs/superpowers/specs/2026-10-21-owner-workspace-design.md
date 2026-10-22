# Owner-authorized local workspace — Issue 228

This expands PR #227; it does not replace multi-root access with a single read-only project. The owner authorized implementation, reviewed merges and a safely verified operational upgrade. The current working tree is an implementation candidate, not a verified release or deployed replacement for v0.1.0.

## Authority and disclosure amendment

Only trusted local configuration adds Windows drives and WSL roots. Remote callers select a configured root and relative path. Hidden names and unknown extensions are not grounds for denial. Agent-private state and credentials remain denied for reads and exports, including aliases and hardlinks; owner consent cannot override that boundary. Installation authority, code, helpers and configuration have additional mutation protections. A mutation-only protection does not itself forbid ordinary source inspection.

The three disclosure paths are distinct:

- Normal text reads and search screen complete bounded content before pagination. Sensitive versions use opaque HMACs rather than public content hashes. Screening is a preview filter, not proof that every unknown credential can be identified.
- `protected-reveal` requests fresh native Windows Hello verification and displays the exact approved snapshot in a fixed local viewer. Its MCP result contains only display status and `localOnly: true`. The viewer has no clipboard/export action, body logging or content-bearing caption, and requires capture-exclusion affinity `0x11`, queried before and after Windows Hello. Unsupported or failed exclusion denies disclosure; there is no monitor-only fallback. That API does not prevent every capture mechanism or photographs. Viewing is bounded to 256 KiB of nonempty UTF-8 without NUL.
- **Binary-export amendment:** `binary-export` is separate raw-disclosure authority. After fresh Windows Hello verification bound to the exact operation, root/file identities and content version, plus a live identity/byte recheck, binary read may return the complete selected bytes as base64 to remote ChatGPT. The native prompt explicitly warns that the snapshot may contain credentials or private content. A normal read, remote approval or previous local-viewer grant cannot authorize it. The ordinary file-content bound is 1 MiB; Agent-private data remains ineligible.

This supersedes the earlier blanket statement that raw project bytes never enter an MCP response. Explicitly approved project binary export is the narrow exception. Credential-write, destructive-operation and export grants bind one operation and its relevant identities, destination, preimage and intended change. They expire, are consumed once and do not survive restart. Remote approval tools cannot mint native owner-presence authority.

Requests cannot choose an executable, shell, environment, helper path or privilege. Filesystem authority and isolated developer-command authority remain separate. Source contracts are in [the core](../../../apps/agent/src/owner-workspace-core.ts), [consent](../../../apps/agent/src/local-owner-consent.ts), [native consent helper](../../../apps/windows-owner-consent-helper/main.cpp) and [viewer contract](../../../apps/windows-protected-local-viewer/README.md).

## Filesystem and recovery amendment

The facade owns bounded reads/search, screening, opaque versions and metadata-only auditing. Its owner-only `owner-workspace.sqlite` journal is separate from the main database and migrations. Unresolved mutations remain quarantined for reconciliation; timeout, restart or a lost response do not authorize blind retry. Request replay returns recorded metadata rather than repeating an effect or prompt.

Windows operations use the fixed handle helper, configured root pins, reparse/hardlink checks and no-replace rename. Current mutations require supported native TxF capability and fail closed when unavailable. There is no unrestricted fallback, and support on one volume does not establish support on another.

The POSIX backend supports configured ext4 roots through pinned root-owned artifacts, namespaces and Landlock. It preserves the selected directory's actual ancestor chain rather than making that directory a new bind-mount root. Its mountinfo guard rejects selected bind aliases, nested mounts and ambiguous additional-volume aliases, including whole-filesystem aliases reporting source root `/`. DrvFs is rejected by this backend and must use the Windows backend.

POSIX replacement captures and validates the actual displaced inode, fsyncs capture evidence and a mapping, then moves that inode by no-replace rename into an identity-pinned, owner-only vault at its original path on the same filesystem. Successful replacement leaves no reserved preimage in the business directory. Controller recovery envelopes are authenticated and encrypted. Native original inodes and directory trees are protected by private vault permissions; they are not claimed to be ciphertext merely because the controller envelope is encrypted.

Already-open writable descriptors retain Linux's normal authority. External writers may change bytes after validation. Capture-and-validate is not universal compare-and-swap: failure preserves evidence and reports an unresolved outcome instead of unlinking a raced pathname or rolling back over another writer. Unsupported permission/xattr reproduction fails closed.

Directory versions describe bounded captured trees, not globally atomic or frozen directory state. The POSIX tree bound is 10,000 entries, 60 levels and 16 MiB of file content, with the ordinary per-file bound. `snapshotOnly` exposes the limitation. Supported move/trash/restore operations preserve their no-overwrite/vault semantics without claiming universal directory-content CAS or cross-filesystem atomicity. See [the worker contract](../../../apps/filesystem-worker/README.md).

## Admission and developer workflow amendment

One process-wide FIFO reservation coordinates filesystem effects and repository-lease acquisition across owner-runtime instances. After acquisition, persisted active repositories/workspaces continue to deny overlapping filesystem mutations. Every native dispatch receives freshly observed mutation protections so native path/identity enforcement can resolve current aliases and Windows spellings. This combines in-process admission with durable active-scope checks; it is not a distributed lock for arbitrary external writers. Read-only project inspection remains available under an active command lease.

Git status/diff/log use fixed trusted reads with admitted metadata/configuration, disabled hooks/helpers/ext-diff/textconv and bounded capture. Registration validates parsed HTTPS GitHub origin against repository API metadata and checks current Tasks/locks immediately before persistence. Unsupported worktree-pointer layouts fail closed. Root/private-path guards surround project callbacks; those observations do not make arbitrary callback filesystem access atomic.

Named `lint`, `test`, `build` and foreground `dev` use a persisted `LOCAL_COMMAND` Task, genuine Repo Lock, separate worktree and real command-run evidence. Only validated npm/pnpm script declarations are dispatched. The base must be clean, without untracked files or hidden index flags; submodules are unsupported. Commands execute the checked committed HEAD, with checks repeated under the lease. Dirty working-tree changes are not silently included or ignored.

M5 isolation remains mandatory: external network is blocked and foreground execution is bounded. Base `node_modules` is not copied or mounted, and dependencies are not installed over the network. Commands needing absent dependencies may fail. `dev` creates neither a public server nor a long-lived background service. Output is screened before persistence and response. Failures/timeouts remain failures; no verification, publication or CI pass is manufactured. Scoped completion checks persisted evidence without weakening the coding Task graph, and the coding scheduler excludes `LOCAL_COMMAND`.

## Remaining gates

Require fresh full lint/typecheck/unit/E2E/security/build/native checks on the exact candidate, independent review and exact-head GitHub CI after edits settle. Historical CI4316 and previous clean-checkout results do not prove the current dirty tree.

Actual Windows Hello approval/cancellation, viewer rendering/capture behavior, external ChatGPT discovery/calls and deployed production composition remain unverified for this candidate. Before upgrade, verify online backups/restoration, live Tasks/locks/processes, no active work, retained worktrees and rollback evidence. Deploy exact reviewed source/dist/runtime identities through the guarded procedure, then verify health, fixture recovery and private-path denial. Do not close #228 from code or historical CI alone.

Historical references remain PR #227 `1723856d8baaddebbf9fb08c005c87be26bc3c25` and recorded production main `85c7c6c6f7ff00868160ef195180b98405159b8c`. Diagnostics remain under `C:\source\gram-agent-diagnostics\issue228\security-discovery`. Reported Windows owner-presence availability is not a completed human ceremony.
