// Fixed PowerShell 5.1 programs. Only these constants become -EncodedCommand.
// Clipboard text uses raw byte streams, never PowerShell source or pipeline objects.
export const READ_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
  if ($text.Length -gt 1048576 -or $text.IndexOf([char]0) -ge 0) { exit 1 }
  if ($utf8.GetByteCount($text) -gt 1048576) { exit 1 }
  $bytes = $utf8.GetBytes($text)
  $output = [Console]::OpenStandardOutput()
  $output.Write($bytes, 0, $bytes.Length)
  $output.Flush()
  exit 0
} catch {
  exit 1
}
`;

export const WRITE_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $inputStream = [Console]::OpenStandardInput()
  $bytes = New-Object byte[] 1048577
  $total = 0
  while ($total -le 1048576) {
    $count = $inputStream.Read($bytes, $total, 1048577 - $total)
    if ($count -eq 0) { break }
    $total += $count
    if ($total -gt 1048576) { exit 1 }
  }
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $text = $utf8.GetString($bytes, 0, $total)
  if ($text.IndexOf([char]0) -ge 0) { exit 1 }
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  if ($text.Length -eq 0) {
    [System.Windows.Forms.Clipboard]::Clear()
  } else {
    [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  }
  exit 0
} catch {
  exit 1
}
`;
