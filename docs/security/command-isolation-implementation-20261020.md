# Offline Linux command credential boundary

This implementation addresses the same-UID credential-file acquisition reproduced
by PR #208. It is an alternative to the **proposed**, unimplemented distinct-UID
broker in [the preparatory design](command-isolation-design.md). It does not
declare full M5, ISO-01, or Windows-host containment accepted.

Ordinary verification always uses `LinuxIsolatedProcessSpawner`. Request category
does not select privileged execution. Admission binds the registered workspace,
Task, current held lease, SQLite owner and private file-lock identity; the same
generation is checked immediately before launch and every 50 ms during execution.
Revocation kills the private PID namespace before the operation settles. This is
bounded revocation observation, not atomic ISO-06 fencing.

The caller creates mandatory user, PID, mount, network, IPC, UTS and cgroup
namespaces, private proc/dev/scratch, no capabilities and an empty inherited
environment. It exposes the task workspace and public Linux system/runtime trees;
controller home, host proc, `/mnt/c`, `/init`, WSL sockets and Windows-backed
`/usr/lib/wsl` mounts are absent or masked. A nonprivileged native entry closes
inherited descriptors, requires Landlock ABI 7, installs filesystem/IPC scope
rules and a default-deny seccomp profile. Unsupported setup fails closed.

All socket families, including VSOCK, are denied; AF_UNIX socketpair remains for
Node child stdio. Network-dependent tests and dependency installation are outside
this offline profile. Dependencies must already exist in the task workspace.
The mandatory suite demonstrates genuine npm and pnpm/TypeScript operation.

Workspace directories receive no execution grant. Admitted Node CLI files are
bounded private snapshots mounted read-only through retained descriptors. Only
these private inodes receive file-level execution. pnpm shell stubs are mapped
through direct package registrations to generated Node wrappers and separate
nonexecuting source snapshots. No original workspace/shared-store inode receives
EXEC. Shared-alias mutation, copied ELF/PE, unregistered shell, excessive files,
escaping links, namespace lifetime and authorization loss are regression cases.

Application Git is a separate typed capability. Registered paths and repository
metadata are verified; arbitrary flags, alternate objects, hooks, filters,
helpers, includes and redirecting configuration are rejected or disabled.
Only admitted fixed GitHub HTTPS operations acquire a `FileSecretProvider`
lease. Authentication is supplied through a scoped environment-backed Git
configuration, never argv or remote URLs. Output is redacted. The supervisor
retains the lease until the owned process group and Git pipes are quiescent;
inspection/termination failure quarantines the pending operation with a fixed
one-time diagnostic. Review reads use this same guarded transport with strict
UTF-8, 256 KiB and 10-second bounds. Production has no raw review fallback.

## Runtime provenance and installation

The runtime is fixed at Node **24.21.0** and pnpm **10.34.5**. The trusted installer
consumes only pinned official artifact bytes, reconstructs a curated tree, rejects
unsafe archive entries/unexpected native payloads, normalizes ownership/modes,
and publishes atomically without replacing an existing installation. Four exact
Windows-only pnpm vendor artifacts are excluded from the Linux profile.

- [Node checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt): Linux x64 archive SHA256
  `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`.
- [pnpm package metadata](https://registry.npmjs.org/pnpm/10.34.5): exact SHA512
  integrity is pinned in the installer and runtime contract.
- Canonical tree: **3705 entries**, SHA256
  `2e89512825a43334ef6e73a62bd71b777b029042eecbca361d9c7a62df6ebc61`.
- Runtime: `/opt/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified`.

The controller independently rechecks the exact receipt and full tree against
these constants, including the official Node executable matching the running
agent. A self-generated receipt or a root-owned copy of user-writable NVM files
is insufficient. Prototype NVM-derived installations are not admitted.
Use a frozen reviewed root-owned installer with isolated Python; never execute
a mutable task/worktree script as root. Runtime upgrades require a new verified
tree and fresh service activation, not in-place modification.

The host user/root/kernel, trusted runtime installation, and public system
packages remain trusted. This boundary does not protect an already compromised
controller or host root. Landlock does not mediate every metadata operation;
read-only mounts and descriptor pinning are part of the boundary. Workload exec
resets dumpability; no claim of permanent `PR_SET_DUMPABLE=0` is made.

## Required verification

Root required CI explicitly runs `pnpm test:security`, including the original
six assertions, production profile cases, native syscall/build probes and
verified-artifact installer tests. Security TypeScript and lint are also collected.
CI pins Node 24.21.0 and Ubuntu 26.04 and measures the actual Landlock ABI without
skipping unsupported hosts. No AppArmor/global user-namespace policy is disabled.

The actual Windows/WSL gate is separate: `pnpm test:security:wsl`. It proves a
working outside Windows command, then denies the copied image inside the worker;
an independent Windows process checks the resulting synthetic files. This
targeted bridge test is not comprehensive Windows-host containment.
