Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this self-check without elevation; it must not install helpers'
}
$installer = Join-Path $PSScriptRoot 'install-windows-owner-workspace.ps1'
$tokens = $null; $errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gram-installer-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$pins = @{
    Profile = 'core'
    ReleaseSha = 'a' * 40; OwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    FilesystemSource = Join-Path $fixture 'filesystem.exe'; FilesystemSha256 = 'a' * 64
    ConsentSource = Join-Path $fixture 'consent.exe'; ConsentSha256 = 'b' * 64
    ValidateOnly = $true
}
$script:checks = 0
function Denied([scriptblock]$Action, [string]$ExpectedMessage = '') {
    $denied = $false
    try { & $Action | Out-Null } catch {
        if ($ExpectedMessage -and $_.Exception.Message -notlike $ExpectedMessage) { throw }
        $denied = $true
    }
    if (-not $denied) { throw 'Expected fail-closed rejection' }
    $script:checks++
}
try {
    $contract = Get-Command $installer
    foreach ($set in $contract.ParameterSets) {
        $required = @($set.Parameters | Where-Object IsMandatory | ForEach-Object Name | Sort-Object)
        $expected = @('Profile', 'ReleaseSha', 'OwnerSid')
        if ($set.Name -eq 'Core') { $expected += @('FilesystemSource', 'FilesystemSha256', 'ConsentSource', 'ConsentSha256') }
        elseif ($set.Name -eq 'Viewer') { $expected += @('ViewerSource', 'ViewerSha256') }
        else { throw 'Only Core and Viewer parameter sets are allowed' }
        if (($required -join ',') -cne (($expected | Sort-Object) -join ',')) { throw 'Profile and all selected artifact arguments must be mandatory' }
        $script:checks++
    }
    if ($contract.ParameterSets.Count -ne 2) { throw 'Exactly two fixed installer profiles are required' }
    . $installer @pins
    $core = Assert-InstallArguments
    if ($core.directory -cne "C:\Program Files\Gram\owner-workspace\$ReleaseSha" -or
        ($core.names -join ',') -cne 'gram-workspace.exe,gram-owner-consent.exe') { throw 'Core must contain only filesystem and consent' }
    $script:checks++
    foreach ($required in @('FilesystemSource', 'FilesystemSha256', 'ConsentSource', 'ConsentSha256')) {
        $saved = Get-Variable -Name $required -ValueOnly
        Set-Variable -Name $required -Value ''
        Denied { Assert-InstallArguments }
        Set-Variable -Name $required -Value $saved
    }
    $ViewerSource = Join-Path $fixture 'viewer.exe'; Denied { Assert-InstallArguments }; $ViewerSource = ''
    $ViewerSha256 = 'c' * 64; Denied { Assert-InstallArguments }; $ViewerSha256 = ''
    $viewerPins = @{
        Profile = 'viewer'; ReleaseSha = $ReleaseSha; OwnerSid = $OwnerSid; ValidateOnly = $true
        ViewerSource = Join-Path $fixture 'viewer.exe'; ViewerSha256 = 'c' * 64
    }
    Denied { & $installer @pins -ViewerSource $viewerPins.ViewerSource -ViewerSha256 $viewerPins.ViewerSha256 }
    Denied { & $installer @pins -ViewerSource '' -ViewerSha256 '' }
    Denied { & $installer @viewerPins -FilesystemSource $pins.FilesystemSource -FilesystemSha256 $pins.FilesystemSha256 }
    $invalidPins = $viewerPins.Clone(); $invalidPins.Profile = 'all'
    Denied { & $installer @invalidPins }
    $invalidPins.Profile = 'core'; Denied { & $installer @invalidPins }
    . $installer @viewerPins
    $viewer = Assert-InstallArguments
    if ($viewer.directory -cne "C:\Program Files\Gram\protected-viewer\$ReleaseSha" -or
        ($viewer.names -join ',') -cne 'gram-protected-viewer.exe' -or $viewer.directory -ceq $core.directory) {
        throw 'Viewer must have its own fixed immutable version destination, including at the same release SHA'
    }
    $script:checks++
    foreach ($required in @('ViewerSource', 'ViewerSha256')) {
        $saved = Get-Variable -Name $required -ValueOnly
        Set-Variable -Name $required -Value ''
        Denied { Assert-InstallArguments }
        Set-Variable -Name $required -Value $saved
    }
    foreach ($forbidden in @('FilesystemSource', 'FilesystemSha256', 'ConsentSource', 'ConsentSha256')) {
        Set-Variable -Name $forbidden -Value $pins[$forbidden]
        Denied { Assert-InstallArguments }
        Set-Variable -Name $forbidden -Value ''
    }
    Denied { Invoke-HelperInstall } # Viewer source absent; no core source or destination needed.
    [IO.File]::WriteAllText($ViewerSource, 'fixture')
    Denied { Invoke-HelperInstall } # Viewer digest mismatch, before destination access.
    $ViewerSha256 = (Get-FileHash -LiteralPath $ViewerSource -Algorithm SHA256).Hash.ToLowerInvariant()
    $ValidateOnly = $false
    Denied { Invoke-HelperInstall } 'Installation requires an already approved elevated owner session*'
    . $installer @pins
    # Exercise the installer's real creation expression with an unelevated test owner.
    $ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
    $creation = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$output'
    }, $true))
    if ($creation.Count -ne 1) { throw 'Expected one installer file creation expression' }
    $creationAcl = [Security.AccessControl.FileSecurity]::new()
    $creationAcl.SetAccessRuleProtection($true, $false)
    $creationAcl.SetOwner([Security.Principal.SecurityIdentifier]::new($OwnerSid))
    $creationAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($OwnerSid), 'FullControl', 'Allow'))
    $target = Join-Path $fixture 'atomic-creation.exe'
    $create = [scriptblock]::Create($creation[0].Right.Extent.Text.Replace('(New-HelperAcl $false)', '$creationAcl'))
    $output = & $create
    try {
        $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
        $actualAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target
        if ($actualAcl.GetSecurityDescriptorSddlForm($sections) -cne $creationAcl.GetSecurityDescriptorSddlForm($sections)) {
            throw 'File must have its explicit protected ACL while the creation handle is still open'
        }
        $script:checks++
    } finally { $output.Dispose() }
    $null = Assert-InstallArguments
    $script:checks++
    $original = $ReleaseSha; $ReleaseSha = '../bad'; Denied { Assert-InstallArguments }; $ReleaseSha = $original
    $original = $OwnerSid; $OwnerSid = 'S-1-5-21-1-2-3-4'; Denied { Assert-InstallArguments }; $OwnerSid = $original
    $original = $FilesystemSha256; $FilesystemSha256 = 'G' * 64; Denied { Assert-InstallArguments }; $FilesystemSha256 = $original
    $original = $FilesystemSource
    foreach ($bad in @('relative.exe', '\\server\share\a.exe', 'C:\a\..\b.exe', 'C:\a.exe:stream', 'C:\a.\b.exe', $ConsentSource)) {
        $FilesystemSource = $bad; Denied { Assert-InstallArguments }
    }
    $FilesystemSource = $original
    Denied { Invoke-HelperInstall } # Missing source, before any destination mutation.
    foreach ($path in @($FilesystemSource, $ConsentSource)) { [IO.File]::WriteAllText($path, 'fixture') }
    Denied { Invoke-HelperInstall } # Wrong digest, before any destination mutation.
    $savedFilesystemDigest = $FilesystemSha256; $savedConsentDigest = $ConsentSha256
    $FilesystemSha256 = (Get-FileHash -LiteralPath $FilesystemSource -Algorithm SHA256).Hash.ToLowerInvariant()
    $ConsentSha256 = (Get-FileHash -LiteralPath $ConsentSource -Algorithm SHA256).Hash.ToLowerInvariant()
    $ValidateOnly = $false
    Denied { Invoke-HelperInstall } 'Installation requires an already approved elevated owner session*'
    $ValidateOnly = $true; $FilesystemSha256 = $savedFilesystemDigest; $ConsentSha256 = $savedConsentDigest
    Assert-ProtectedAcl 'C:\' $false
    Assert-ProtectedAcl 'C:\Program Files' $false
    $script:checks += 2
    Denied { [GramInstallHandle]::Open($FilesystemSource, $true).Dispose() }
    Denied { [GramInstallHandle]::Open($fixture, $false).Dispose() }
    $handle = [GramInstallHandle]::Open($FilesystemSource, $false)
    try {
        Denied { [IO.File]::WriteAllText($FilesystemSource, 'changed') }
        Denied { [IO.File]::Move($FilesystemSource, ($FilesystemSource + '.moved')) }
    } finally { $handle.Dispose() }
    $hardlink = Join-Path $fixture 'hardlink.exe'
    $null = New-Item -ItemType HardLink -Path $hardlink -Target $FilesystemSource
    Denied { [GramInstallHandle]::Open($FilesystemSource, $false).Dispose() }
    Remove-Item -LiteralPath $hardlink
    $junction = Join-Path $fixture 'junction'
    $null = New-Item -ItemType Junction -Path $junction -Target $fixture
    Denied { [GramInstallHandle]::Open($junction, $true).Dispose() }
    Denied { [GramInstallHandle]::Open((Join-Path $junction 'filesystem.exe'), $false).Dispose() }
    # Remove the junction itself; never recurse through a reparse-point fixture.
    [IO.Directory]::Delete($junction)
    function Get-Acl { param([string]$LiteralPath) return $script:fixtureAcl }
    $script:fixtureAcl = New-HelperAcl $false
    Assert-ProtectedAcl $FilesystemSource $true
    $script:checks++
    $script:fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($OwnerSid), 'WriteData', 'Allow'))
    Denied { Assert-ProtectedAcl $FilesystemSource $true }
    $script:fixtureAcl = New-HelperAcl $false
    $script:fixtureAcl.SetOwner([Security.Principal.SecurityIdentifier]::new($OwnerSid))
    Denied { Assert-ProtectedAcl $FilesystemSource $false }
    $script:fixtureAcl = New-HelperAcl $false
    $script:fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'WriteAttributes', 'Allow'))
    Denied { Assert-ProtectedAcl $FilesystemSource $false }
    $script:fixtureAcl = New-HelperAcl $false
    $script:fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'DeleteSubdirectoriesAndFiles', 'Allow'))
    Denied { Assert-ProtectedAcl $FilesystemSource $false }
    Write-Output "PASS: $script:checks installer validation checks; no elevation or installation performed"
} finally {
    # Every fixture path is confined to this freshly generated directory.
    if ([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
        $junctionPath = Join-Path $fixture 'junction'
        if (Test-Path -LiteralPath $junctionPath) {
            if (((Get-Item -LiteralPath $junctionPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                throw 'Unexpected nonjunction fixture; refusing recursive cleanup'
            }
            [IO.Directory]::Delete($junctionPath)
        }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
