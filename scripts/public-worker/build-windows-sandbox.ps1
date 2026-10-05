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
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$output = Join-Path $outputRoot 'ExcessSandbox.exe'
$webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'
if (-not (Test-Path -LiteralPath $webExtensions)) {
  $webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll'
}
if (-not (Test-Path -LiteralPath $webExtensions)) {
  throw 'The .NET Framework JSON serializer assembly is unavailable.'
}

& $compiler /nologo /target:exe /platform:x64 /optimize+ /debug- /out:$output "/reference:$webExtensions" $source
if ($LASTEXITCODE -ne 0) {
  throw 'The Windows sandbox helper did not compile.'
}
Write-Output 'status=build-ok'
