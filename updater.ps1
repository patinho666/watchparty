# Downloads the latest WatchParty from GitHub and replaces the files in this
# folder, keeping your config.js. Runs two ways:
#  - double-click update.bat (shows progress in a window);
#  - the "Update" button in the sidebar (via updater-host.bat, after install.bat).
param([switch]$NativeHost)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # faster downloads, and nothing extra printed
$Here = $PSScriptRoot
$Source = Get-Content (Join-Path $Here 'update-source.json') -Raw | ConvertFrom-Json

function Update-WatchParty {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $tmp = Join-Path $env:TEMP ('watchparty-update-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'watchparty.zip'
    $url = "https://github.com/$($Source.repo)/archive/refs/heads/$($Source.branch).zip"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem -Path $tmp -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
    if (-not $src) { throw 'The download does not contain manifest.json.' }
    # Mirror the new version into this folder; keep config.js and this PC's updater registration.
    $null = robocopy $src.FullName $Here /MIR /XF config.js com.watchparty.updater.json /XD .git /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Copying the files failed (robocopy code $LASTEXITCODE)." }
    return (Get-Content (Join-Path $Here 'manifest.json') -Raw | ConvertFrom-Json).version
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# Chrome/Edge native messaging: 4-byte length, then UTF-8 JSON, both ways.
function Read-NativeMessage {
  $in = [Console]::OpenStandardInput()
  $len = New-Object byte[] 4
  if ($in.Read($len, 0, 4) -lt 4) { return $null }
  $size = [BitConverter]::ToInt32($len, 0)
  $buf = New-Object byte[] $size
  $off = 0
  while ($off -lt $size) { $n = $in.Read($buf, $off, $size - $off); if ($n -le 0) { break }; $off += $n }
  return ([Text.Encoding]::UTF8.GetString($buf, 0, $off) | ConvertFrom-Json)
}
function Write-NativeMessage($obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  $out = [Console]::OpenStandardOutput()
  $out.Write([BitConverter]::GetBytes($bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

if ($NativeHost) {
  try {
    $msg = Read-NativeMessage
    if ($msg -and $msg.cmd -eq 'ping') {
      Write-NativeMessage @{ ok = $true; installed = $true }
    } else {
      $version = Update-WatchParty
      Write-NativeMessage @{ ok = $true; version = $version }
    }
  } catch {
    Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
  }
  exit
}

Write-Host 'Updating WatchParty...'
try {
  $version = Update-WatchParty
  Write-Host "Done: WatchParty $version. The extension restarts by itself within a minute;"
  Write-Host 'then refresh any Netflix, Disney+ or Prime Video tabs.'
} catch {
  Write-Host "The update failed: $($_.Exception.Message)"
}
Write-Host ''
Read-Host 'Press Enter to close'
