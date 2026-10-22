# Fixed synchronous test harness; never imported by the agent or installer.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$test = Join-Path $PSScriptRoot 'test-windows-owner-workspace-install.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    & $test
    exit 0
}

# Restrict the synchronous test thread's real file-access token. This is not
# child-process isolation: new processes would retain the process token.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GramInstallerTestToken {
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing,uint flags,
        uint disable,IntPtr sids,uint delete,IntPtr privileges,uint restrict,IntPtr restrictions,out IntPtr token);
    public static IntPtr RestrictedOwnToken() {
        IntPtr original=IntPtr.Zero, restricted;
        try {
            if (!OpenProcessToken(GetCurrentProcess(),0xE,out original)) throw new Win32Exception();
            // DISABLE_MAX_PRIVILEGE | LUA_TOKEN; never SANDBOX_INERT.
            if (!CreateRestrictedToken(original,0x5,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw new Win32Exception();
            return restricted;
        } finally { if(original!=IntPtr.Zero) CloseHandle(original); }
    }
}
'@
$guard = Join-Path ([IO.Path]::GetTempPath()) ('gram-installer-token-' + [guid]::NewGuid().ToString('N'))
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
        'ContainerInherit, ObjectInherit', 'None', 'Allow'))
}
([IO.DirectoryInfo]::new($guard)).Create($acl)
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
if ((Get-Acl -LiteralPath $guard).GetSecurityDescriptorSddlForm($sections) -cne $acl.GetSecurityDescriptorSddlForm($sections)) {
    throw 'Canary requires exact protected SYSTEM/Admin-only ACL'
}
[IO.File]::WriteAllText((Join-Path $guard 'before'), 'synthetic')
$token = [GramInstallerTestToken]::RestrictedOwnToken()
$context = $null
$thread = [GramInstallerTestToken]::GetCurrentThreadId()
function Assert-RestrictedFileAccess {
    if ([GramInstallerTestToken]::GetCurrentThreadId() -ne $thread) { throw 'Test thread changed' }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent($true)
    try {
        if ($null -eq $current -or ([Security.Principal.WindowsPrincipal]::new($current)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Actual restricted thread identity required'
        }
    } finally { if ($null -ne $current) { $current.Dispose() } }
    $denied = $false
    try { [IO.File]::WriteAllText((Join-Path $guard 'denied'), 'must-not-write') }
    catch [UnauthorizedAccessException] { $denied = $true }
    if (-not $denied) { throw 'Windows did not deny restricted-thread file access' }
}
try {
    $context = [Security.Principal.WindowsIdentity]::Impersonate($token)
    Assert-RestrictedFileAccess
    & $test
    Assert-RestrictedFileAccess
} finally {
    try { if ($null -ne $context) { $context.Undo(); $context.Dispose() } }
    finally { if (-not [GramInstallerTestToken]::CloseHandle($token)) { throw 'Token close failed' } }
}
$restored = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if ([GramInstallerTestToken]::GetCurrentThreadId() -ne $thread -or
        -not ([Security.Principal.WindowsPrincipal]::new($restored)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Original thread identity was not restored'
    }
} finally { $restored.Dispose() }
[IO.File]::WriteAllText((Join-Path $guard 'after'), 'synthetic')
Write-Output 'PASS: real restricted-thread access denial before/after fixed installer checks; original identity restored'
