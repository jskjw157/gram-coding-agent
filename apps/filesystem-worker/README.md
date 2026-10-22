# Typed ext4 filesystem worker

Build with `sh apps/filesystem-worker/build.sh /absolute/build-directory` in
Linux. The two outputs are `gram-owner-fs-entry` and `gram-owner-fs-native`;
the fixed JavaScript entrypoint is `worker.mjs`. The entry profile only starts
`/run/gram-owner-fs/runtime/bin/node /usr/local/libexec/gram-owner-fs-worker.mjs ROOT VAULT`
with trusted canonical root and private vault paths as fixed worker arguments.
Requests are bounded JSON for list/stat/read/treeStat/write/move/mkdir/trash/restore.
No executable, environment or helper path comes from the request.

The launcher must supply an isolated mount/PID/network namespace, the verified
runtime, immutable trusted helper artifacts, the selected ext4 root at its
original path, and private owner-only recovery at `/run/gram-owner-fs/home/recovery`.
The recovery directory must be empty for a replacement request. The worker does
not install itself or prove launcher provenance. Native tests use temporary
artifacts and make no changes to installed binaries or services.

`protectedPaths` deny reads and mutations; `protectedMutationPaths` deny only
mutations. They are relative to the selected root. The trusted launcher must
translate its configured protected host paths and enforce host-state isolation.
Replies use `NO_CHANGE` for a denied request before mutation and
`OUTCOME_UNKNOWN` after a mutation may have started. The controller must
quarantine unknown outcomes until reconciliation; process exit and elapsed
time do not certify quiescence.

Replacement uses a same-directory exchange, captures the actual displaced
entry through an open descriptor, then copies its bytes, owner/group-compatible
permissions and supported xattrs into private recovery. A private, fsynced mapping
records a random vault entry and its identities before a no-overwrite rename
moves the actual displaced inode into the original-path vault. Successful writes
leave no reserved preimage in the business directory. Failure preserves available
evidence and returns `OUTCOME_UNKNOWN`; the worker never performs a racy pathname
unlink or rollback. Moves use `renameat2(RENAME_NOREPLACE)`. Permissions that cannot be
reproduced fail closed before destination replacement. In particular, an ACL
containing user IDs unmapped in the outer user namespace cannot be copied.

Directory versions hash bounded, ordered trees including identities, file bytes,
permissions and supported xattrs. Symlinks and multiply linked files in trees
are denied. Trash and restore use no-overwrite renames to the trusted original
vault path on the same ext4 volume, preserving complete directory trees and
their metadata. The vault identity and owner-only permissions are checked on
every request. A vault bind alias would reintroduce cross-mount `EXDEV` and is
not used. Full tree snapshots are bounded to 10,000 entries, 60 levels and 16 MiB
of file content, with the ordinary 1 MiB per-file limit.

## Original-path containment and concurrent writers

The selected root must not be bind-mounted as a new mount root. A real
deterministic host-rename probe showed that this layout retains authority to
create through an open directory descriptor after its directory moves outside
the selected root. The fixed transport instead preserves the original ancestor
chain with a filesystem-root mount and applies Landlock to the original selected
directory. Actual probes verify that opening/creating through a moved directory
descriptor is then denied. Private `/run` and `/proc` mounts protect runtime,
recovery, and process state. Protected controller paths are masked in place.
Before launch, actual kernel mount information must show a governing mount
whose source is the filesystem root, with no nested mounts under the selected
root. A slash source root alone does not prove the original path: whole-filesystem
bind aliases also report slash. Mount IDs, device numbers and source roots bind
main-volume selections to the canonical slash mount; additional volumes require
one unique device/root mount instance. Duplicate additional-volume roots,
whole-filesystem aliases and nested mounts are denied. Native tests verify denial
using real whole-filesystem, file and directory binds in private namespaces.

An already-open writable file descriptor retains Linux's ordinary write
authority. An external writer can also keep a descriptor after replacement.
Capture-and-validate is not atomic compare-and-swap against such writers; failed
capture or validation preserves evidence and returns `OUTCOME_UNKNOWN`.
DrvFs is rejected; it is not a fallback path.

Run the actual native suite as an unprivileged Linux owner on ext4:

```
python3 tests/security/filesystem-worker-native.test.py /var/lib/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified
```

The suite compiles both profiles with warnings as errors and compares the ordinary
binary against the pinned historical M5 source compiled with identical tools.
The separate installed-host digest is recorded in the historical fixture provenance.
