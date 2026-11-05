<#
.SYNOPSIS
  Build the Flowstate installer on your own PC and stop. Never uploads or pushes.
.DESCRIPTION
  1. npm test (must be green)  2. optional version set  3. electron-builder NSIS
  4. print installer path, size and SHA-256.
  Real releases are made by the "windows-build" GitHub Action, which also signs
  the update manifest. This script is for trying a build locally.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\release.ps1
  powershell -ExecutionPolicy Bypass -File .\release.ps1 -SkipTests
#>
param(
  [string]$Version,
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Run($label, [scriptblock]$block) {
  Write-Host "== $label" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

if (-not $SkipTests) { Run 'npm test' { npm test } }

if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.0.0, got '$Version'." }
  Run "set version $Version" { node scripts/set-version.mjs $Version }
}

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if (Test-Path release) { Remove-Item release -Recurse -Force }
Run 'electron-builder NSIS' { npm run dist }

$installer = Join-Path $PSScriptRoot 'release\Flowstate-Setup.exe'
if (-not (Test-Path $installer)) { throw "Installer not found at $installer" }
$item = Get-Item $installer
$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()

Write-Host ''
Write-Host "Version  : $($pkg.version)"
Write-Host "Installer: $installer"
Write-Host ("Size     : {0:N1} MB" -f ($item.Length / 1MB))
Write-Host "SHA-256  : $hash"
Write-Host 'Stopped. Nothing was uploaded, published or pushed.'
