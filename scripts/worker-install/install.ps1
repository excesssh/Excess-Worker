# Local signed-release verification for Windows. This script never installs an archive.
# The public hardware-isolation gate is closed; the manual workflow below stops safely.
# Do not pipe downloaded scripts into PowerShell. Download release.json, its .minisig, and
# the archive named in the signed manifest, then run this reviewed local verifier.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ManifestPath,
  [Parameter(Mandatory = $true, Position = 1)][string]$SignaturePath,
  [Parameter(Mandatory = $true, Position = 2)][string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
$maximumManifest = 64KB
$maximumSignature = 10KB
$maximumArchive = 256MB
$publicKey = @'
untrusted comment: Excess Worker release signing key
RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
'@

function Stop-Unsafe([string]$Message) { throw "EXCESS worker install: $Message" }
foreach ($tool in @('minisign')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Unsafe "'$tool' is required." }
}
foreach ($path in @($ManifestPath, $SignaturePath, $ArchivePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Unsafe 'manifest, signature, and archive must be local files.' }
}
if ((Get-Item -LiteralPath $ManifestPath).Length -lt 2 -or (Get-Item -LiteralPath $ManifestPath).Length -gt $maximumManifest) { Stop-Unsafe 'release manifest exceeds its 64 KiB bound.' }
if ((Get-Item -LiteralPath $SignaturePath).Length -lt 1 -or (Get-Item -LiteralPath $SignaturePath).Length -gt $maximumSignature) { Stop-Unsafe 'signature exceeds its 10 KiB bound.' }
if ((Get-Item -LiteralPath $ArchivePath).Length -lt 1 -or (Get-Item -LiteralPath $ArchivePath).Length -gt $maximumArchive) { Stop-Unsafe 'archive exceeds its 256 MiB bound.' }

$keyPath = Join-Path ([IO.Path]::GetTempPath()) ('excess-minisign-' + [guid]::NewGuid().ToString('N') + '.pub')
try {
  [IO.File]::WriteAllText($keyPath, $publicKey + "`n", [Text.Encoding]::ASCII)
  & minisign -Vm $ManifestPath -x $SignaturePath -p $keyPath | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Unsafe 'pinned Minisign signature verification failed.' }
} finally { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }

try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Stop-Unsafe 'release manifest is not valid JSON.' }
if ($manifest.format -ne 1 -or $manifest.product -cne 'Excess Worker' -or $manifest.repository -cne 'https://github.com/excesssh/Excess-Worker') { Stop-Unsafe 'release manifest identity is invalid.' }
if ($manifest.version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or $manifest.sourceCommit -cnotmatch '^[0-9a-f]{40}$') { Stop-Unsafe 'version or source commit is invalid.' }
if ($manifest.sequence -isnot [long] -and $manifest.sequence -isnot [int]) { Stop-Unsafe 'release sequence is invalid.' }
if ($manifest.sequence -lt 1 -or $manifest.files.Count -lt 1 -or $manifest.files.Count -gt 2) { Stop-Unsafe 'release sequence or platform count is invalid.' }
if (@($manifest.files.platform | Select-Object -Unique).Count -ne @($manifest.files).Count -or @($manifest.isolation.PSObject.Properties.Name) -notcontains 'win32-x64') { Stop-Unsafe 'release platforms are invalid.' }
foreach ($name in @('filesystem', 'network', 'credentials')) {
  $value = [string]$manifest.permissions.$name
  if (-not $value.Trim() -or $value.Length -gt 512) { Stop-Unsafe 'release permission fields are invalid.' }
}
$entry = @($manifest.files | Where-Object platform -CEQ 'win32-x64') | Select-Object -First 1
$expectedName = "excess-worker-$($manifest.version)-$($manifest.sourceCommit.Substring(0, 12))-win-x64.zip"
if (-not $entry -or $entry.file -cne $expectedName -or [IO.Path]::GetFileName($ArchivePath) -cne $expectedName) { Stop-Unsafe 'archive basename does not match the signed source-bound release entry.' }
if ($entry.bytes -ne (Get-Item -LiteralPath $ArchivePath).Length -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { Stop-Unsafe 'archive size does not match the signed release entry.' }
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { Stop-Unsafe 'archive SHA-256 does not match the signed release entry.' }

Write-Host "Verified the pinned Minisign signature, source-bound Windows archive name, size and SHA-256: $expectedName"
Stop-Unsafe 'installation is intentionally unavailable until a reviewed safe bootstrap installer is shipped after isolated hardware gates pass; no files were extracted or changed.'
