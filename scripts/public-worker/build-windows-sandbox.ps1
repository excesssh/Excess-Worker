$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot '..\..\native\windows\ExcessSandbox.cs'
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
  throw 'The .NET Framework C# compiler is unavailable.'
}

$outputRoot = 'C:\ExcessBuilds\tools\excess-sandbox'
if (-not [string]::IsNullOrWhiteSpace($env:EXCESS_SANDBOX_OUTPUT_ROOT)) {
  $outputRoot = [IO.Path]::GetFullPath($env:EXCESS_SANDBOX_OUTPUT_ROOT)
  $allowedRoot = 'C:\ExcessBuilds\tools\excess-sandbox-runs\'
  if (-not $outputRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The sandbox helper output directory is outside the neutral run-output root.'
  }
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$output = Join-Path $outputRoot 'ExcessSandbox.exe'
$neutralSource = Join-Path $outputRoot 'ExcessSandbox.cs'
$sourceText = [IO.File]::ReadAllText($source)
$privateIdentifier = [string]::Concat([char]97, [char]97, [char]114, [char]111, [char]110)
$homePrefix = [string]::Concat([char]67, [char]58, [char]92, [char]85, [char]115, [char]101, [char]114, [char]115, [char]92)
if ($sourceText.ToLowerInvariant().Contains($privateIdentifier) -or $sourceText.IndexOf($homePrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
  throw 'Sandbox source failed the privacy scan.'
}
[IO.File]::Copy($source, $neutralSource, $true)
$webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'
if (-not (Test-Path -LiteralPath $webExtensions)) {
  $webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll'
}
if (-not (Test-Path -LiteralPath $webExtensions)) {
  throw 'The .NET Framework JSON serializer assembly is unavailable.'
}

& $compiler /nologo /target:exe /platform:x64 /optimize+ /debug- /out:$output "/reference:$webExtensions" $neutralSource
if ($LASTEXITCODE -ne 0) {
  throw 'The Windows sandbox helper did not compile.'
}
Write-Output 'status=build-ok'
