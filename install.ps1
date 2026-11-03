# One-time setup on each PC: lets WatchParty run updater-host.bat when you click
# "Update" in the sidebar. Registers it for Chrome and Edge, for this user only
# (no administrator rights needed). Run it again if you move the folder.
$ErrorActionPreference = 'Stop'
$ExtensionId = 'ihgpccnlgfgmnobkbocegjffgghkklio'
$HostName = 'com.watchparty.updater'
$Here = $PSScriptRoot
$HostJson = Join-Path $Here "$HostName.json"

$manifest = [ordered]@{
  name            = $HostName
  description     = 'WatchParty updater'
  path            = (Join-Path $Here 'updater-host.bat')
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
# UTF-8 without BOM, so folders with accents (e.g. folders named with accents) work.
[IO.File]::WriteAllText($HostJson, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

foreach ($browser in @('Software\Google\Chrome', 'Software\Microsoft\Edge')) {
  $key = "HKCU:\$browser\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $HostJson
}

Write-Host ''
Write-Host 'WatchParty updater installed for Chrome and Edge.'
Write-Host 'From now on, use the Update button in the WatchParty sidebar.'
Write-Host ''
