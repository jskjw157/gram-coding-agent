# Reviewed Windows helper installation

This is a prepared installation artifact, not an installed or activated release.
Run the self-check without elevation:

```powershell
powershell -NoProfile -File scripts/test-windows-owner-workspace-install.ps1
```

Windows CI invokes `test-windows-owner-workspace-install-ci.ps1`. On an elevated
runner it launches only the same fixed self-check with a restricted version of
its own token (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`), then checks the real child's
exit code. The child refuses an administrator token; no elevation check is
mocked or skipped. `SANDBOX_INERT` is never used and application policy stays
enabled. This launcher is a test artifact, not an agent command-execution API.
See Microsoft's [restricted token contract](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken).

The installer requires an explicit `-Profile core` or `-Profile viewer`, with
explicit absolute artifact paths, lowercase SHA256 pins, and a reviewed
40-character source commit SHA. `core` requires exactly the filesystem and
Windows Hello consent artifacts and forbids viewer arguments. `viewer` requires
only the viewer artifact and forbids filesystem/consent arguments. There is no
combined or default profile; previous three-artifact commands must be split.
Build with the existing workspace/consent build scripts and, separately, the
viewer build script. Record the build provenance and hashes outside the installer;
the installer verifies bytes, not whether a binary was compiled from that commit.
Signing changes bytes, so record the final signed artifact digest.

The following is a command template for a separately owner-approved elevated
Windows PowerShell 5.1 session, running as the same Windows user. Replace every
placeholder with reviewed concrete values. The installer never requests UAC,
starts a helper, changes application policy, starts a service, or edits runtime
configuration/databases.

```powershell
.\scripts\install-windows-owner-workspace.ps1 `
  -Profile core `
  -ReleaseSha '<reviewed lowercase 40hex commit>' `
  -OwnerSid '<current owner SID>' `
  -FilesystemSource 'C:\reviewed-artifacts\gram-workspace.exe' -FilesystemSha256 '<64hex>' `
  -ConsentSource 'C:\reviewed-artifacts\gram-owner-consent.exe' -ConsentSha256 '<64hex>'
```

After the viewer passes its separate admission and owner-behavior gates, install
it independently, including at the same release SHA:

```powershell
.\scripts\install-windows-owner-workspace.ps1 `
  -Profile viewer `
  -ReleaseSha '<reviewed lowercase 40hex commit>' `
  -OwnerSid '<current owner SID>' `
  -ViewerSource 'C:\reviewed-artifacts\gram-protected-viewer.exe' -ViewerSha256 '<64hex>'
```

The fixed core destination is `C:\Program Files\Gram\owner-workspace\<ReleaseSha>`;
its only files are `gram-workspace.exe` and `gram-owner-consent.exe`. The fixed
viewer destination is `C:\Program Files\Gram\protected-viewer\<ReleaseSha>`;
its only file is `gram-protected-viewer.exe`. Each profile validates and installs
only its own sources and version directory. Installing the viewer later neither
rewrites nor repairs the core version. Existing combined versions are not migrated
or repaired; use a fresh reviewed release version for core installation.
Every Gram directory and file has a protected exact
DACL: SYSTEM and Administrators FullControl, installing user ReadAndExecute,
owner Administrators. The standard drive/Program Files ancestors must be owned
by SYSTEM, Administrators, or TrustedInstaller and have no effective untrusted
replacement/write authority; inherit-only rules are checked where they apply to
the child. This conservative allow-list can reject customized legitimate ACLs.
The version is never overwritten, repaired, or used as the recovery vault.

The script locks checked canonical ancestors against rename/delete and source
files against write/delete, rejects reparse points and file hardlinks, hashes the
held source streams, records Authenticode status, creates files without
replacement, and verifies destination handles, ACLs and hashes. Run the same
command with `-ValidateOnly` after installation for a read-only repeat check.
`-ValidateOnly` also verifies the selected profile's original sources and records
their signature status; it does not require the other profile to be present.
Partial failure leaves a protected incomplete version for explicit administrator
review; it does not delete evidence or activate a partial release.

## Operational gates

As of 2026-10-22, the freshly built unsigned viewer was denied by Windows
Application Control (CodeIntegrity events 3077/3033, policy
`0283ac0f-fff1-49ae-ada1-8a933130cad6`). Viewer installation and activation must
not proceed while this known operational blocker remains. Core installation can
proceed independently after its own helper admission, owner verification and
deployment gates pass. Keep protected reveal unavailable until the separately
installed viewer passes its gates; do not route it through another disclosure
path. This split changes no Windows application-control policy or runtime
disclosure authority. The event identifies the built-in
`VerifiedAndReputableDesktop` Smart App Control policy; its generic enterprise
signing-level message does not establish a custom enterprise policy. A valid
signature alone does not prove admission under every active policy. Obtain an
artifact signed through an existing authorized publicly trusted signing service,
verify its source/build provenance and final digest, then test actual admission,
owner-mediated launches and viewer behavior. Do not rename an artifact, use an
old binary, create a new trust key, or disable policy as a workaround.

Installation must be verified in an approved elevated session before claiming
ACL provisioning works. Automated non-elevated checks cover rejection and handle
behavior for both profiles, not successful Program Files installation. The check
refuses an elevated token and verifies both profiles reject installation without
elevation after source hashing. Local Administrators/SYSTEM
remain trusted and can modify installed versions; this protects the ordinary
non-elevated agent token from hash-to-launch replacement, not a compromised OS or
administrator. Runtime paths/pins must be configured separately after review.

Recovery vaults require separate user-private directories on each supported
volume, with identity pins and the native helper's recovery checks. Do not grant
the agent write access to the helper tree to accommodate vault storage. This
installer creates no vault, credentials, privilege grants, or generic command API.
