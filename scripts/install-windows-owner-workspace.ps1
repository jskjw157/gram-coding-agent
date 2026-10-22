# Run only from a reviewed, elevated Windows PowerShell 5.1 session of OwnerSid.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseSha,
    [Parameter(Mandatory)][string]$OwnerSid,
    [Parameter(Mandatory)][string]$FilesystemSource,
    [Parameter(Mandatory)][string]$FilesystemSha256,
    [Parameter(Mandatory)][string]$ConsentSource,
    [Parameter(Mandatory)][string]$ConsentSha256,
    [Parameter(Mandatory)][string]$ViewerSource,
    [Parameter(Mandatory)][string]$ViewerSha256,
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-InstallArguments {
    if ($ReleaseSha -cnotmatch '^[a-f0-9]{40}$') { throw 'An exact lowercase release SHA is required' }
    if ($OwnerSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or
        $OwnerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Owner SID must match the installing Windows user' }
    $sources = @($FilesystemSource, $ConsentSource, $ViewerSource)
    foreach ($source in $sources) {
        if ($source -cnotmatch '^[A-Z]:\\[^/:*?"<>|\p{Cc}]+$') { throw 'Only canonical local source paths are allowed' }
        if ([IO.Path]::GetFullPath($source) -cne $source -or $source -cnotmatch '\.exe$' -or
            @($source.Substring(3).Split('\') | Where-Object { $_ -match '[. ]$' }).Count) { throw 'Source path is not canonical' }
    }
    if (@($sources | Select-Object -Unique).Count -ne 3) { throw 'Three distinct sources are required' }
    foreach ($digest in @($FilesystemSha256, $ConsentSha256, $ViewerSha256)) {
        if ($digest -cnotmatch '^[a-f0-9]{64}$') { throw 'An exact lowercase SHA256 is required for each helper' }
    }
}

# Handles deny delete sharing; file handles also deny writes throughout hash/copy.
if (-not ('GramInstallHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class GramInstallHandle {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder p, uint length, uint flags);
    public static SafeFileHandle Open(string path, bool directory) {
        var h = CreateFile(path, directory ? 0U : 0x80000000U, directory ? 3U : 1U, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        try {
            Info i; var p = new StringBuilder(32768);
            uint n = GetFinalPathNameByHandle(h, p, (uint)p.Capacity, 0);
            if (h.IsInvalid || !GetFileInformationByHandle(h, out i) || n == 0 || n >= p.Capacity ||
                (i.Attributes & 0x400) != 0 || ((i.Attributes & 0x10) != 0) != directory ||
                (!directory && (i.Links != 1 || i.SizeHigh != 0 || i.SizeLow == 0 || i.SizeLow > 16777216)) ||
                !String.Equals(p.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Noncanonical, reparse, hardlinked or invalid native path: " + path);
            return h;
        } catch { h.Dispose(); throw; }
    }
}
'@
}

$admin = 'S-1-5-32-544'
$system = 'S-1-5-18'
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
function New-HelperAcl([bool]$Directory) {
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($admin))
    $inherit = [Security.AccessControl.InheritanceFlags]::None
    if ($Directory) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    foreach ($sid in @($system, $admin, $OwnerSid)) {
        $rights = [Security.AccessControl.FileSystemRights]::FullControl
        if ($sid -eq $OwnerSid) { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), $rights, $inherit,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    return $acl
}
function Assert-ProtectedAcl([string]$Path, [bool]$Exact) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trusted = @($system, $admin)
    if (-not $Exact) { $trusted += $trustedInstaller }
    if ($owner -notin $trusted) { throw "Untrusted path owner: $Path" }
    # Directory creation on C:\ is harmless; deleting a child or changing its ACL is not.
    $danger = [Security.AccessControl.FileSystemRights]'WriteData, WriteAttributes, WriteExtendedAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and
            (($rule.FileSystemRights -band $danger) -ne 0 -or ([int]$rule.FileSystemRights -band 0x50000000) -ne 0)) {
            throw "Untrusted replacement authority: $Path"
        }
    }
    if ($Exact) {
        $expected = New-HelperAcl ((Get-Item -LiteralPath $Path -Force).PSIsContainer)
        $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
        if ($acl.GetSecurityDescriptorSddlForm($sections) -cne $expected.GetSecurityDescriptorSddlForm($sections)) {
            throw "Helper ACL differs from SYSTEM/admin full and owner read/execute: $Path"
        }
    }
}

function Invoke-HelperInstall {
    Assert-InstallArguments
    $destination = "C:\Program Files\Gram\owner-workspace\$ReleaseSha"
    $sources = @($FilesystemSource, $ConsentSource, $ViewerSource)
    $names = @('gram-workspace.exe', 'gram-owner-consent.exe', 'gram-protected-viewer.exe')
    $digests = @($FilesystemSha256, $ConsentSha256, $ViewerSha256)
    $signatures = @()
    $handles = [Collections.Generic.List[IDisposable]]::new()
    $streams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        # Lock each source ancestor before resolving its next component.
        foreach ($source in $sources) {
            $cursor = $source.Substring(0, 3)
            $handles.Add([GramInstallHandle]::Open($cursor, $true))
            foreach ($part in $source.Substring(3).Split('\')) {
                $cursor = Join-Path $cursor $part
                $directory = $cursor -cne $source
                $handle = [GramInstallHandle]::Open($cursor, $directory)
                if ($directory) { $handles.Add($handle) }
                else { $streams.Add([IO.FileStream]::new($handle, [IO.FileAccess]::Read)) }
            }
        }
        for ($i = 0; $i -lt 3; $i++) {
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hash.ComputeHash($streams[$i])).Replace('-', '').ToLowerInvariant() }
            finally { $hash.Dispose() }
            if ($actual -cne $digests[$i]) { throw "Source digest mismatch: $($names[$i])" }
            $signatures += [string](Get-AuthenticodeSignature -LiteralPath $sources[$i]).Status
            $streams[$i].Position = 0
        }
        if (-not $ValidateOnly) {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Installation requires an already approved elevated owner session; this script never elevates itself'
            }
        }
        $cursor = 'C:\'
        $handles.Add([GramInstallHandle]::Open($cursor, $true))
        Assert-ProtectedAcl $cursor $false
        foreach ($part in @('Program Files', 'Gram', 'owner-workspace', $ReleaseSha)) {
            $cursor = Join-Path $cursor $part
            $exact = $part -ne 'Program Files'
            if (-not (Test-Path -LiteralPath $cursor)) {
                if ($ValidateOnly) { throw "Installation absent: $cursor" }
                if (-not $exact) { throw 'The standard Program Files directory must exist' }
                ([IO.DirectoryInfo]::new($cursor)).Create((New-HelperAcl $true))
            }
            $handles.Add([GramInstallHandle]::Open($cursor, $true))
            Assert-ProtectedAcl $cursor $exact
        }
        if (-not $ValidateOnly -and @(Get-ChildItem -LiteralPath $destination -Force).Count) {
            throw 'Version directory is not empty; immutable releases are never overwritten or repaired'
        }
        for ($i = 0; $i -lt 3; $i++) {
            $target = Join-Path $destination $names[$i]
            if (-not $ValidateOnly) {
                $output = [IO.FileStream]::new($target, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write,
                    [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (New-HelperAcl $false))
                try { $streams[$i].CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
            }
            $installed = [IO.FileStream]::new([GramInstallHandle]::Open($target, $false), [IO.FileAccess]::Read)
            $handles.Add($installed)
            Assert-ProtectedAcl $target $true
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hash.ComputeHash($installed)).Replace('-', '').ToLowerInvariant() }
            finally { $hash.Dispose() }
            if ($actual -cne $digests[$i]) { throw 'Installed helper digest mismatch' }
        }
        if (@(Get-ChildItem -LiteralPath $destination -Force).Count -ne 3) { throw 'Unexpected version directory contents' }
        [pscustomobject]@{
            releaseSha = $ReleaseSha; directory = $destination; expectedOwnerSid = $OwnerSid; validated = $true
            helpers = @(for ($i = 0; $i -lt 3; $i++) {
                [pscustomobject]@{ name = $names[$i]; sha256 = $digests[$i]; authenticodeStatus = $signatures[$i] }
            })
        }
    } finally {
        foreach ($stream in $streams) { $stream.Dispose() }
        for ($i = $handles.Count - 1; $i -ge 0; $i--) { $handles[$i].Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-HelperInstall }
