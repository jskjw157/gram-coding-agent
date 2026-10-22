# Reviewed Windows helper installation

This is a prepared installation artifact, not an installed or activated release.
Run the self-check without elevation:

```powershell
powershell -NoProfile -File scripts/test-windows-owner-workspace-install.ps1
```

The installer accepts exactly three locally built helper artifacts, with explicit
absolute paths and lowercase SHA256 pins, and a reviewed 40-character source
commit SHA. Build them with the existing workspace/consent build scripts and the
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
  -ReleaseSha '<reviewed lowercase 40hex commit>' `
  -OwnerSid '<current owner SID>' `
  -FilesystemSource 'C:\reviewed-artifacts\gram-workspace.exe' -FilesystemSha256 '<64hex>' `
  -ConsentSource 'C:\reviewed-artifacts\gram-owner-consent.exe' -ConsentSha256 '<64hex>' `
  -ViewerSource 'C:\reviewed-artifacts\gram-protected-viewer.exe' -ViewerSha256 '<64hex>'
```

The fixed destination is `C:\Program Files\Gram\owner-workspace\<ReleaseSha>`.
Its only files are `gram-workspace.exe`, `gram-owner-consent.exe`, and
`gram-protected-viewer.exe`. Every Gram directory and file has a protected exact
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
`-ValidateOnly` also verifies the three original sources and records their signature status.
Partial failure leaves a protected incomplete version for explicit administrator
review; it does not delete evidence or activate a partial release.

## Operational gates

As of 2026-10-22, the freshly built unsigned viewer was denied by Windows
Application Control (CodeIntegrity events 3077/3033, policy
`0283ac0f-fff1-49ae-ada1-8a933130cad6`). Installation must not proceed while this
known operational blocker remains. The event identifies the built-in
`VerifiedAndReputableDesktop` Smart App Control policy; its generic enterprise
signing-level message does not establish a custom enterprise policy. A valid
signature alone does not prove admission under every active policy. Obtain an
artifact signed through an existing authorized publicly trusted signing service,
verify its source/build provenance and final digest, then test actual admission,
owner-mediated launches and viewer behavior. Do not rename an artifact, use an
old binary, create a new trust key, or disable policy as a workaround.

Installation must be verified in an approved elevated session before claiming
ACL provisioning works. Automated non-elevated checks cover rejection and handle
behavior, not successful Program Files installation. Local Administrators/SYSTEM
remain trusted and can modify installed versions; this protects the ordinary
non-elevated agent token from hash-to-launch replacement, not a compromised OS or
administrator. Runtime paths/pins must be configured separately after review.

Recovery vaults require separate user-private directories on each supported
volume, with identity pins and the native helper's recovery checks. Do not grant
the agent write access to the helper tree to accommodate vault storage. This
installer creates no vault, credentials, privilege grants, or generic command API.
