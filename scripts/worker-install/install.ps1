# Verify and install a local signed worker package for the current Windows x64 user.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ManifestPath,
  [Parameter(Mandatory = $true, Position = 1)][string]$SignaturePath,
  [Parameter(Mandatory = $true, Position = 2)][string]$ArchivePath,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'EXCESS')
)
$ErrorActionPreference = 'Stop'
$maximumManifest = 64KB
$maximumSignature = 10KB
$maximumArchive = 256MB
$maximumTotal = 1GB
$maximumEntry = 128MB
$minimumSequence = 1
$installLock = $null
$publicKey = @'
untrusted comment: Excess Worker release signing key
RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
'@

function Stop-Unsafe([string]$Message) { throw "EXCESS worker install: $Message" }
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-NoReparse([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path); $root = [IO.Path]::GetPathRoot($full); $current = $root
  foreach ($part in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Unsafe 'install path contains a reparse point.' }
    }
  }
}
function Assert-UserWritable([string]$Directory) {
  $probe = Join-Path $Directory ('.excess-write-test-' + [guid]::NewGuid().ToString('N'))
  try { [IO.File]::WriteAllText($probe,''); Remove-Item -LiteralPath $probe -Force }
  catch { Stop-Unsafe 'install location is not writable by this user.' }
}
function Test-Semver([string]$Value) {
  return $Value -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
}
function Compare-Semver([string]$Left,[string]$Right) {
  $a = [regex]::Match($Left,'^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?')
  $b = [regex]::Match($Right,'^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?')
  for ($i=1; $i -le 3; $i++) { $x=[Numerics.BigInteger]::Parse($a.Groups[$i].Value); $y=[Numerics.BigInteger]::Parse($b.Groups[$i].Value); if($x -lt $y){return -1}; if($x -gt $y){return 1} }
  $ap=$a.Groups[4].Value; $bp=$b.Groups[4].Value
  if (-not $ap -and $bp) { return 1 }; if ($ap -and -not $bp) { return -1 }
  if ($ap -eq $bp) { return 0 }
  $aa=$ap.Split('.'); $bb=$bp.Split('.')
  for($i=0;$i -lt [Math]::Min($aa.Length,$bb.Length);$i++) {
    if($aa[$i] -eq $bb[$i]){continue}; $an=$aa[$i] -cmatch '^(0|[1-9][0-9]*)$';$bn=$bb[$i] -cmatch '^(0|[1-9][0-9]*)$'
    if($an -and $bn){$x=[Numerics.BigInteger]::Parse($aa[$i]);$y=[Numerics.BigInteger]::Parse($bb[$i]);if($x -lt $y){return -1};if($x -gt $y){return 1};continue}
    if($an -ne $bn){if($an){return -1}else{return 1}}
    if([string]::CompareOrdinal($aa[$i],$bb[$i]) -lt 0){return -1}else{return 1}
  }
  if($aa.Length -lt $bb.Length){return -1};if($aa.Length -gt $bb.Length){return 1};return 0
}
function Read-BoundedJson([string]$Path,[int]$Limit) {
  $bytes=[IO.File]::ReadAllBytes($Path);if($bytes.Length -gt $Limit){Stop-Unsafe 'JSON input exceeds its size limit.'}
  $text=(New-Object System.Text.UTF8Encoding($false,$true)).GetString($bytes)
  try { return ,($text | ConvertFrom-Json) } catch { Stop-Unsafe 'JSON input is invalid.' }
}
function Get-RelativeName([string]$Name,[string]$Folder) {
  if (-not $Name -or $Name.Length -gt 240 -or $Name.Contains('\') -or $Name.StartsWith('/')) { Stop-Unsafe 'archive path is invalid.' }
  $trimmed=$Name.TrimEnd('/');$parts=$trimmed.Split('/')
  if($parts.Count -lt 2){Stop-Unsafe 'archive path is unsafe.'}
  foreach($part in $parts){if(-not $part -or $part -in @('.','..') -or $part.Contains(':') -or $part -notmatch '^[-A-Za-z0-9._+@]+$' -or $part.EndsWith('.') -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){Stop-Unsafe 'archive path is unsafe.'}}
  if($parts[0] -cne $Folder){Stop-Unsafe 'archive root folder mismatch.'}
  return ($parts | Select-Object -Skip 1) -join '/'
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) { Stop-Unsafe 'Windows x64 only.' }
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Stop-Unsafe 'run as the installing user, not as Administrator.'}
  foreach($path in @($ManifestPath,$SignaturePath,$ArchivePath)) { if(-not (Test-Path -LiteralPath $path -PathType Leaf)){Stop-Unsafe 'manifest, signature, and archive must be local regular files.'}; if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){Stop-Unsafe 'release inputs cannot be reparse points.'} }
  foreach($pair in @(@($ManifestPath,$maximumManifest,'manifest'),@($SignaturePath,$maximumSignature,'signature'),@($ArchivePath,$maximumArchive,'archive'))) {
    $size=(Get-Item -LiteralPath $pair[0]).Length;if($size -lt 1 -or $size -gt $pair[1]){Stop-Unsafe "$($pair[2]) exceeds its size bound."}
  }
  if(-not (Get-Command minisign -ErrorAction SilentlyContinue)){Stop-Unsafe "'minisign' is required."}
  $keyPath=Join-Path ([IO.Path]::GetTempPath()) ('excess-minisign-'+[guid]::NewGuid().ToString('N')+'.pub')
  try {
    [IO.File]::WriteAllText($keyPath,$publicKey+"`n",[Text.Encoding]::ASCII)
    & minisign -Vm $ManifestPath -x $SignaturePath -p $keyPath | Out-Null
    if($LASTEXITCODE -ne 0){Stop-Unsafe 'pinned Minisign signature verification failed.'}
  } finally { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }

  $manifest=Read-BoundedJson $ManifestPath $maximumManifest
  if($manifest.format -ne 1 -or $manifest.product -cne 'Excess Worker' -or $manifest.repository -cne 'https://github.com/excesssh/Excess-Worker'){Stop-Unsafe 'release identity is invalid.'}
  $version=[string]$manifest.version;$commit=[string]$manifest.sourceCommit;$sequence=$manifest.sequence
  if(-not (Test-Semver $version) -or $commit -cnotmatch '^[0-9a-f]{40}$' -or $sequence -is [bool] -or $sequence -isnot [long] -and $sequence -isnot [int] -or $sequence -lt $minimumSequence){Stop-Unsafe 'release version, source, or minimum sequence is invalid.'}
  if(@($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 2 -or @($manifest.files.platform | Select-Object -Unique).Count -ne @($manifest.files).Count -or @($manifest.isolation.PSObject.Properties.Name).Count -ne @($manifest.files).Count -or @($manifest.isolation.PSObject.Properties.Name) -notcontains 'win32-x64'){Stop-Unsafe 'release platform list is invalid.'}
  foreach($field in @('filesystem','network','credentials')) { $value=[string]$manifest.permissions.$field;if(-not $value.Trim() -or $value.Length -gt 512){Stop-Unsafe 'release permission fields are invalid.'} }
  $entry=@($manifest.files | Where-Object {$_.platform -ceq 'win32-x64'}) | Select-Object -First 1
  $expectedName="excess-worker-$version-$($commit.Substring(0,12))-win-x64.zip"
  if(-not $entry -or $entry.file -cne $expectedName -or [IO.Path]::GetFileName($ArchivePath) -cne $expectedName){Stop-Unsafe 'archive name does not match signed release identity.'}
  if($entry.bytes -ne (Get-Item -LiteralPath $ArchivePath).Length -or [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-Sha256 $ArchivePath) -cne $entry.sha256){Stop-Unsafe 'archive size or SHA-256 does not match the signed release.'}
  $manifestDigest=Get-Sha256 $ManifestPath;$folder="excess-worker-$version-win-x64";$appName="$version-$($commit.Substring(0,12))"
  $root=[IO.Path]::GetFullPath($InstallRoot)
  if(-not [IO.Path]::IsPathRooted($InstallRoot) -or $InstallRoot -match '(^|[\\/])\.\.([\\/]|$)'){Stop-Unsafe 'install root must be a normalized absolute path.'}
  Assert-NoReparse $root
  $stateDir=Join-Path $root 'state';$appRoot=Join-Path $root 'app';$binDir=Join-Path $root 'bin';$statePath=Join-Path $stateDir 'release-high-water.json';$lockPath=Join-Path $stateDir 'install.lock';$launcher=Join-Path $binDir 'excess-worker.cmd'
  foreach($dir in @($root,$stateDir,$appRoot,$binDir)){Assert-NoReparse $dir}

  $stageAnchor=$root;while(-not (Test-Path -LiteralPath $stageAnchor -PathType Container)){$parent=[IO.Path]::GetDirectoryName($stageAnchor);if(-not $parent -or $parent -eq $stageAnchor){Stop-Unsafe 'no user-writable install ancestor exists.'};$stageAnchor=$parent}
  Assert-NoReparse $stageAnchor
  Add-Type -AssemblyName System.IO.Compression
  $stream=[IO.File]::OpenRead($ArchivePath);$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read,$false)
  $stageBase=Join-Path $stageAnchor ('.excess-worker-stage-'+[guid]::NewGuid().ToString('N'));$stage=Join-Path $stageBase 'app';$seen=@{};$expectedHashes=@{};$total=[long]0
  try {
    if($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 4096){Stop-Unsafe 'archive entry count exceeds its bound.'}
    foreach($item in $zip.Entries){
      $relative=Get-RelativeName $item.FullName $folder
      $mode=($item.ExternalAttributes -shr 16) -band 0xF000
      if($mode -notin @(0,0x8000)){Stop-Unsafe 'archive links and special entries are not allowed.'}
      if($item.FullName.EndsWith('/')){Stop-Unsafe 'archive directory entries are not supported.'}
      $key=$relative.ToLowerInvariant();if($seen.ContainsKey($key)){Stop-Unsafe 'archive contains duplicate paths.'};$seen[$key]=$true
      if($item.Length -gt $maximumEntry -or $item.Length -lt 0 -or $total+$item.Length -gt $maximumTotal){Stop-Unsafe 'archive expanded size exceeds its bound.'};$total += $item.Length
    }
    if(-not $seen.ContainsKey('manifest.json') -or -not $seen.ContainsKey('excess-worker.cmd') -or -not $seen.ContainsKey('node/node.exe')){Stop-Unsafe 'archive is missing a required package file.'}
    [void][IO.Directory]::CreateDirectory($stage)
    foreach($item in $zip.Entries){
      if($item.FullName.EndsWith('/')){continue};$relative=Get-RelativeName $item.FullName $folder
      $dest=Join-Path $stage ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar));$destFull=[IO.Path]::GetFullPath($dest)
      if(-not $destFull.StartsWith($stage+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){Stop-Unsafe 'archive path escaped staging directory.'}
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destFull));$input=$item.Open();$output=New-Object IO.FileStream($destFull,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$hash=[Security.Cryptography.SHA256]::Create();$count=[long]0
      try { $buffer=New-Object byte[] 65536;while(($read=$input.Read($buffer,0,$buffer.Length)) -gt 0){$count += $read;if($count -gt $maximumEntry -or $count -gt $item.Length){Stop-Unsafe 'archive entry expanded beyond its declared size.'};$output.Write($buffer,0,$read);[void]$hash.TransformBlock($buffer,0,$read,$null,0)};[void]$hash.TransformFinalBlock((New-Object byte[] 0),0,0);if($count -ne $item.Length){Stop-Unsafe 'archive entry size mismatch.'};$expectedHashes[$relative]=([BitConverter]::ToString($hash.Hash)).Replace('-','').ToLowerInvariant() }
      finally {$input.Dispose();$output.Dispose();$hash.Dispose()}
    }
    $sumPath=Join-Path $stage 'SHA256SUMS.txt'
    if(Test-Path -LiteralPath $sumPath){$sumSet=@{};foreach($line in [IO.File]::ReadAllLines($sumPath)){if($line -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9._+@/-]+)$' -or $sumSet.ContainsKey($Matches[2])){Stop-Unsafe 'package checksum list is invalid.'};$sumSet[$Matches[2]]=$Matches[1]};if($sumSet.Count -ne $expectedHashes.Count-1){Stop-Unsafe 'package checksum list does not cover extracted contents.'};foreach($name in $sumSet.Keys){if(-not $expectedHashes.ContainsKey($name) -or $expectedHashes[$name] -cne $sumSet[$name]){Stop-Unsafe 'package checksum list does not match extracted contents.'}}}
    $package=Read-BoundedJson (Join-Path $stage 'manifest.json') 65536
    if($package.product -cne 'EXCESS' -or $package.package -cne 'worker' -or $package.publicDistributionReady -ne $true){Stop-Unsafe 'worker package distribution gate is closed.'}
    if($package.version -cne $version -or $package.releaseSequence -ne $sequence -or $package.sourceCommit -cne $commit -or $package.platform -cne 'win32-x64'){Stop-Unsafe 'worker package source or platform identity mismatch.'}
    foreach($name in $expectedHashes.Keys){$path=Join-Path $stage ($name.Replace('/',[IO.Path]::DirectorySeparatorChar));if((Get-Sha256 $path) -cne $expectedHashes[$name]){Stop-Unsafe 'staged package rehash failed.'}}
    $target=Join-Path $appRoot $appName
    foreach($dir in @($root,$stateDir,$appRoot,$binDir)){if(-not (Test-Path -LiteralPath $dir)){[void][IO.Directory]::CreateDirectory($dir)};Assert-NoReparse $dir}
    Assert-UserWritable $root
    if(Test-Path -LiteralPath $lockPath){if((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){Stop-Unsafe 'install lock is a reparse point.'}}
    $lockDeadline=[DateTime]::UtcNow.AddSeconds(30)
    while($null -eq $installLock){
      try { $installLock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
      catch [IO.IOException] { if([DateTime]::UtcNow -ge $lockDeadline){Stop-Unsafe 'timed out waiting for the install lock.'}; Start-Sleep -Milliseconds 50 }
    }
    if((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){Stop-Unsafe 'install lock is a reparse point.'}
    $current=$null
    if(Test-Path -LiteralPath $statePath){if((Get-Item -LiteralPath $statePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){Stop-Unsafe 'saved release state is a reparse point.'};$current=Read-BoundedJson $statePath 2048
      if($current.sequence -is [bool] -or $current.sequence -isnot [long] -and $current.sequence -isnot [int] -or $current.sequence -lt $minimumSequence -or -not (Test-Semver ([string]$current.version)) -or [string]$current.sourceCommit -cnotmatch '^[0-9a-f]{40}$'){Stop-Unsafe 'saved release state is invalid.'}
      if($current.manifestDigest -and [string]$current.manifestDigest -cnotmatch '^[0-9a-f]{64}$'){Stop-Unsafe 'saved release state is invalid.'}
      if($sequence -lt $current.sequence){Stop-Unsafe 'release sequence rollback rejected.'}
      if($sequence -eq $current.sequence -and ($version -cne $current.version -or $commit -cne $current.sourceCommit -or $current.manifestDigest -and $manifestDigest -cne $current.manifestDigest)){Stop-Unsafe 'release sequence equivocation rejected.'}
      if($sequence -gt $current.sequence -and (Compare-Semver $version ([string]$current.version)) -lt 0){Stop-Unsafe 'release version downgrade rejected.'}
    }
    if(Test-Path -LiteralPath $launcher){if((Get-Item -LiteralPath $launcher -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or -not (Get-Content -LiteralPath $launcher -Raw).Contains('EXCESS WORKER MANAGED LAUNCHER')){Stop-Unsafe 'refusing to replace an unmanaged launcher.'}}
    if(Test-Path -LiteralPath $target){
      Assert-NoReparse $target;$existing=@{};Get-ChildItem -LiteralPath $target -File -Recurse | ForEach-Object {$rel=$_.FullName.Substring($target.Length+1).Replace('\','/');$existing[$rel]=Get-Sha256 $_.FullName}
      if($existing.Count -ne $expectedHashes.Count){Stop-Unsafe 'existing version contents differ from signed archive.'};foreach($name in $expectedHashes.Keys){if($existing[$name] -cne $expectedHashes[$name]){Stop-Unsafe 'existing version contents differ from signed archive.'}}
      Remove-Item -LiteralPath $stage -Recurse -Force
    } else { [void][IO.Directory]::CreateDirectory($appRoot);[IO.Directory]::Move($stage,$target) }
  } finally { $zip.Dispose();$stream.Dispose();if(Test-Path -LiteralPath $stageBase){Remove-Item -LiteralPath $stageBase -Recurse -Force -ErrorAction SilentlyContinue} }

  $newLauncher="@echo off`r`nrem EXCESS WORKER MANAGED LAUNCHER`r`nsetlocal`r`nif not defined EXCESS_WORKER_INSTALL_ROOT set ""EXCESS_WORKER_INSTALL_ROOT=%LOCALAPPDATA%\EXCESS""`r`nif not defined EXCESS_WORKER_HOME set ""EXCESS_WORKER_HOME=%LOCALAPPDATA%\EXCESS\worker""`r`nif not defined EXCESS_MODEL_DIR set ""EXCESS_MODEL_DIR=%LOCALAPPDATA%\EXCESS\ai""`r`ncall ""%EXCESS_WORKER_INSTALL_ROOT%\app\$appName\excess-worker.cmd"" %*`r`nexit /b %ERRORLEVEL%`r`n"
  $tempLauncher=Join-Path $binDir ('.excess-worker.new-'+[guid]::NewGuid().ToString('N'));$tempState=Join-Path $stateDir ('.release-state.new-'+[guid]::NewGuid().ToString('N'));$backup=Join-Path $binDir ('.excess-worker.old-'+[guid]::NewGuid().ToString('N'));$stateBackup=Join-Path $stateDir ('.release-state.old-'+[guid]::NewGuid().ToString('N'));$rollbackLauncher=Join-Path $binDir ('.excess-worker.failed-'+[guid]::NewGuid().ToString('N'));$rollbackState=Join-Path $stateDir ('.release-state.failed-'+[guid]::NewGuid().ToString('N'))
  $stateObject=[ordered]@{sequence=$sequence;version=$version;sourceCommit=$commit;manifestDigest=$manifestDigest};$stateText=($stateObject|ConvertTo-Json -Compress)+"`n"
  [IO.File]::WriteAllText($tempLauncher,$newLauncher,[Text.Encoding]::ASCII);[IO.File]::WriteAllText($tempState,$stateText,(New-Object System.Text.UTF8Encoding($false)))
  $hadLauncher=Test-Path -LiteralPath $launcher;$hadState=Test-Path -LiteralPath $statePath;$oldState=$null;if($hadState){$oldState=[IO.File]::ReadAllBytes($statePath)}
  $commitComplete=$false
  try {
    if($hadLauncher){[IO.File]::Replace($tempLauncher,$launcher,$backup,$true)}else{[IO.File]::Move($tempLauncher,$launcher)}
    if($hadState){[IO.File]::Replace($tempState,$statePath,$stateBackup,$true)}else{[IO.File]::Move($tempState,$statePath)}
    $commitComplete=$true
  } catch {
    if(Test-Path -LiteralPath $backup){[IO.File]::Replace($backup,$launcher,$rollbackLauncher,$true)}elseif(-not $hadLauncher -and (Test-Path -LiteralPath $launcher)){Remove-Item -LiteralPath $launcher -Force}
    if(Test-Path -LiteralPath $stateBackup){[IO.File]::Replace($stateBackup,$statePath,$rollbackState,$true)}elseif($hadState -and $oldState){[IO.File]::WriteAllBytes($statePath,$oldState)}elseif(-not $hadState -and (Test-Path -LiteralPath $statePath)){Remove-Item -LiteralPath $statePath -Force}
    throw
  } finally {Remove-Item -LiteralPath $tempLauncher,$tempState -Force -ErrorAction SilentlyContinue}
  if($commitComplete){Remove-Item -LiteralPath $backup,$stateBackup,$rollbackLauncher,$rollbackState -Force -ErrorAction SilentlyContinue}
  Write-Host "Verified and installed Excess Worker $version for Windows x64."
  Write-Host 'Add %LOCALAPPDATA%\EXCESS\bin to your user PATH, or run excess-worker.cmd from that directory.'
} catch {
  $message=$_.Exception.Message
  if($message -notlike 'EXCESS worker install:*'){$message='verification or installation failed safely.'}
  throw $message
} finally {
  if($null -ne $installLock){$installLock.Dispose()}
}
