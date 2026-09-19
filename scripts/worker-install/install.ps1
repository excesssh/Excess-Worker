# EXCESS supplier worker installer for Windows x64, served at <exchange>/downloads/install.ps1. In PowerShell:
#
#   irm __EXCESS_ORIGIN__/downloads/install.ps1 | iex
#
# It downloads the published worker named in latest-win-x64.txt, checks its SHA-256, unpacks it under
# %LOCALAPPDATA%\EXCESS\app\<version> and puts an excess-worker command in %LOCALAPPDATA%\EXCESS\bin, which it adds
# to your user PATH. No administrator rights, no services, nothing runs in the background. Running it again installs
# the newest published version beside the old one and switches to it. $env:EXCESS_ORIGIN overrides the exchange.
# Works in Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-ExcessWorker {
  $origin = if ($env:EXCESS_ORIGIN) { $env:EXCESS_ORIGIN } else { '__EXCESS_ORIGIN__' }
  $origin = $origin.TrimEnd('/')
  if (-not $origin.StartsWith('https://')) { throw 'EXCESS_ORIGIN must be an https:// address.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'The EXCESS worker needs 64-bit Windows.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # One line: <archive> <sha256> <bytes> <version> <folder inside the archive>
  $pointer = (Invoke-WebRequest -UseBasicParsing "$origin/downloads/latest-win-x64.txt").Content
  if ($pointer -is [byte[]]) { $pointer = [Text.Encoding]::UTF8.GetString($pointer) }
  $parts = $pointer.Trim() -split '\s+'
  if ($parts.Count -ne 5) { throw 'Unexpected contents in latest-win-x64.txt.' }
  $archive, $sum, $bytes, $version, $folder = $parts
  if ($archive -notmatch '^excess-worker-[A-Za-z0-9._-]+-win-x64\.zip$') { throw "Unexpected archive name: $archive" }
  if ($sum -notmatch '^[0-9a-f]{64}$') { throw "Unexpected checksum: $sum" }
  if ($bytes -notmatch '^[0-9]{1,12}$') { throw "Unexpected size: $bytes" }
  if ($version -notmatch '^[A-Za-z0-9._+-]{1,64}$') { throw "Unexpected version: $version" }
  if ($folder -notmatch '^excess-worker-[A-Za-z0-9._-]+-win-x64$') { throw "Unexpected folder: $folder" }

  $root = Join-Path $env:LOCALAPPDATA 'EXCESS'
  $apps = Join-Path $root 'app'
  $bin = Join-Path $root 'bin'
  $work = Join-Path ([IO.Path]::GetTempPath()) ('excess-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Write-Host ("Downloading the EXCESS worker {0} ({1} MB) from {2}" -f $version, [math]::Round([int64]$bytes / 1MB), $origin)
    $zip = Join-Path $work $archive
    Invoke-WebRequest -UseBasicParsing "$origin/downloads/$archive" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant() -ne $sum) { throw 'Checksum mismatch; nothing was installed.' }
    Expand-Archive -Path $zip -DestinationPath $work -Force
    $unpacked = Join-Path $work $folder
    if (-not (Test-Path (Join-Path $unpacked 'excess-worker.cmd'))) { throw "The archive does not contain $folder\excess-worker.cmd." }

    New-Item -ItemType Directory -Force -Path $apps, $bin | Out-Null
    $target = Join-Path $apps $version
    if (Test-Path $target) {
      try { Remove-Item -Recurse -Force $target }
      catch { throw "The EXCESS worker $version is already installed and in use. Stop it (excess-worker stop-now) and run this again." }
    }
    Move-Item $unpacked $target
    $shim = "@echo off`r`n`"$target\excess-worker.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    [IO.File]::WriteAllText((Join-Path $bin 'excess-worker.cmd'), $shim, [Text.Encoding]::ASCII)
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }

  # Read and write the raw registry value so entries such as %USERPROFILE%\bin stay unexpanded.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($raw -split ';' | Where-Object { $_ })
    if ($entries -notcontains $bin) {
      $key.SetValue('Path', (($entries + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # Setting and clearing a variable through .NET broadcasts the change, so new terminals see the new PATH.
      [Environment]::SetEnvironmentVariable('EXCESS_INSTALL_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('EXCESS_INSTALL_REFRESH', $null, 'User')
      Write-Host "Added $bin to your user PATH; open a new terminal to use it."
    }
  } finally { $key.Close() }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }

  Write-Host "Installed the EXCESS worker $version in $target"
  Write-Host 'This build is not code-signed yet, so Windows may show a warning the first time it runs.'
  Write-Host ''
  Write-Host 'Next: excess-worker guide'
  Write-Host "It shows your next step at any time: choosing a model, pairing with $origin, setting a price and running."
  Write-Host "Walkthrough: $origin/supply"
}

Install-ExcessWorker
