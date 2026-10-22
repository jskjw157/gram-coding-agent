# Historical ordinary M5 entry

`m5-entry-85c7c6c.c` is the exact `apps/execution-sandbox/entry.c` blob from
main commit `85c7c6c6f7ff00868160ef195180b98405159b8c`, extracted with `git show`.
Its SHA-256 with LF line endings is
`767bb1f03628f3393d0d3d65701937a320c37f157dc6f0222659039603169323`.

The native suite checks that source digest, then compiles this historical entry
and the current ordinary entry with the same compiler and flags. Their complete
binaries must match. The real metadata-syscall and network denial probes remain
mandatory. This fixture is a historical security baseline, not a generated copy
of the current implementation.

## Separate local installed-artifact evidence

On the WSL Ubuntu host on 2026-10-21, the read-only command
`sha256sum /usr/local/libexec/gram-sandbox-entry` returned
`7b577272194b3333ff8f87ba4959c0e19312308720592966412b1bcc28f547d2`.
No installed artifact was changed. This records the local installed binary;
it is not a portable expected digest for binaries produced by another compiler.
