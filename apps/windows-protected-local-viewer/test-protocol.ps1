param([Parameter(Mandatory=$true)][string]$HelperPath)
$ErrorActionPreference = 'Stop'
# Malformed-input/native denial evidence only. These requests cannot reach Hello.
$cases = @(
    '{}',
    '{"operation":"view","operation":"verify"}',
    '{"operation":"view","contentBase64":"fixture-secret"}',
    '{"operation":"verify"}',
    '{"operation":"view"} trailing'
)
$issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$challenge = @{
    operation = 'view'
    challengeId = 'b6389f58-14fa-4494-bf46-d137b05053c8'
    bindingDigest = ('a' * 64)
    issuedAt = $issuedAt
    expiresAt = $issuedAt + 60000
    expectedOwnerSid = 'S-1-5-21-100-200-300-1001'
    target = @{ action = 'protected-reveal'; rootId = 'fixture'; path = 'fixture.env'; destination = $null }
    contentBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('fixture-only'))
}
# Exact-content digest mismatch is rejected before checking owner availability.
$cases += ($challenge | ConvertTo-Json -Depth 3 -Compress)
$challenge.bindingDigest = '0' * 64
$challenge.target.action = 'binary-export'
$cases += ($challenge | ConvertTo-Json -Depth 3 -Compress)
foreach ($request in $cases) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Resolve-Path -LiteralPath $HelperPath).Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    $process.StandardInput.Write($request)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(5000)) { $process.Kill();throw 'Protocol test timeout' }
    $output = $process.StandardOutput.ReadToEnd().Trim()
    $diagnostics = $process.StandardError.ReadToEnd()
    if ($process.ExitCode -ne 0 -or $output -ne '{"status":"DENIED"}' -or $diagnostics.Length -ne 0) {
        throw 'Protocol denial test failed'
    }
    $process.Dispose()
}
Write-Output "PASS: $($cases.Length) native malformed-input denials; no Hello prompt or owner approval tested"
