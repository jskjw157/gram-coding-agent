# Native entry for the offline Linux command profile

`build.sh /absolute/new/output` compiles `entry.c` with the system C compiler;
no native library dependency or binary is committed. Run on Linux x86_64 with
Landlock ABI 7 or newer. Unsupported ABI, rule installation, descriptor closure,
seccomp installation, or exec errors stop with status 125. There is no fallback.

Contract:

```
gram-sandbox-entry CANONICAL_WORKSPACE CANONICAL_NODE_VERSION_ROOT [--script IMMUTABLE_NODE_ENTRY]... -- CANONICAL_EXECUTABLE [args...]
```

The trusted caller must already have created the minimal bubblewrap mount,
user, PID, network, IPC, UTS and cgroup namespaces, a new session, private proc,
and a minimal device tree. This helper is not privileged and does not create
those namespaces. It accepts a canonical executable beneath the Node runtime
root or a direct canonical `/usr/bin` executable. The trusted caller owns
runtime selection and validates immutable mount sources; argv is not an
untrusted broker protocol.

The helper applies Landlock to filesystem reads/writes/exec, IPC scope, and
all filesystem access bits known to ABI 7. Directory-wide execution rights are
limited to immutable `/usr`, `/bin`, `/lib`, `/lib64` and the exact Node runtime.
The workspace and `/home/gram-sandbox` receive ordinary file writes without
directory-wide execution rights; the latter is private scratch supplied by the caller.
For admitted package CLIs the controller creates bounded private file snapshots,
binds their descriptors read-only at the original canonical paths, and supplies
`--script` only for snapshots with the exact Node shebang. The entry verifies
the immutable mount, owner, single link and prefix before granting file-only
execution. No original workspace or shared pnpm-store inode receives execution.
Registered pnpm shell stubs are replaced in the namespace with generated Node
wrappers; their original shell text is never executed. Their mapped Node input
is a separate read-only snapshot without an execution grant.
There is deliberately no blanket `/tmp` grant. TMPDIR and npm cache belong
under `/home/gram-sandbox`. `/proc` is readable only because the caller supplies
a private proc mount. `/dev` must contain only the caller's minimal devices.

Seccomp checks native x86_64 architecture, kills x32 calls, and uses an explicit
syscall allowlist with default EPERM. clone3 returns ENOSYS for libc fallback;
clone rejects namespace, ptrace and untraced flags. socket is denied for every
family, including AF_VSOCK; only AF_UNIX socketpair is allowed for Node child
stdio. ioctl is limited to FIONBIO, FIONREAD, TCGETS and TIOCGWINSZ. All inherited
descriptors above 2 are closed before workload exec. The parent must supply
non-secret stdin/stdout/stderr and a sanitized environment including
`OPENSSL_CONF=/dev/null` for this offline Node profile.

## Limits that must not be reported as stronger guarantees

- This is not ISO-01 distinct host UID/GID separation, a root broker, complete
  M5 acceptance, or Windows-host containment.
- PR_SET_DUMPABLE is cleared for the entry itself; ordinary exec resets this
  flag. Do not claim workload dumpability stays zero. The private PID/proc view
  and syscall/IPC restrictions provide the process-access boundary.
- Landlock does not hide metadata or mediate every metadata-changing syscall.
  Read-only immutable/controller mounts in the outer profile are required.
- Executing a workspace ELF through execve is denied. This does not prohibit
  interpreting repository source or mapping bytes into a runtime; seccomp and
  Landlock must remain effective for that code and its descendants.
- The implementation depends on the Linux kernel and immutable runtime. It is
  not protection from a compromised host user/root/kernel or runtime installer.

## Native tests

```
sh apps/execution-sandbox/build.sh /absolute/new/gram-sandbox-entry
GRAM_SANDBOX_ENTRY=/absolute/new/gram-sandbox-entry python3 apps/execution-sandbox/test_boundary.py
```

Tests use only synthetic controller canaries and actual processes/syscalls.
Unset GRAM_SANDBOX_ENTRY to reproduce the unsandboxed negative control.
The tests resolve Node from PATH and require major version 24. Set
GRAM_SANDBOX_NODE only to select an explicit genuine Node 24 executable.
`test_build.py` verifies older-header compilation and atomic no-clobber output.
The owned ABI structure matches Linux UAPI include/uapi/linux/landlock.h;
older build headers do not relax the mandatory runtime ABI 7 check.
The suite verifies direct/descendant/symlink/tmp file denial, workspace ELF
execution denial, ordinary file writes, Node descendants, genuine Bash/npm
lifecycle, all-family network denial, inherited FD closure, native syscall
restrictions, clone3 fallback, x32 rejection, and Unix socketpair compatibility.
These entry-only tests do not replace production bubblewrap integration tests.

The production runtime is installed from fixed official Node 24.21.0 and pnpm
10.34.5 artifacts by `scripts/stage-sandbox-node.py`. The controller independently
checks the exact receipt, full canonical tree digest and 3705 entries before
using it. NVM-derived prototype trees are not admitted. The profile deliberately
has no network; dependencies must already exist in the task workspace. Mandatory
security CI includes real offline pnpm/TypeScript CLI execution and source-alias
mutation tests in addition to the original six provider-backed assertions.
