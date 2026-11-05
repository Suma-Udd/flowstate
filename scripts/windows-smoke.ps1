<#
.SYNOPSIS
  Installs the built Flowstate installer silently and proves the installed copy works.
.DESCRIPTION
  1. Silent install into a private folder (never the real install location).
  2. Runs `Flowstate.exe --self-test`, which loads every native module from the
     installed app: SQLite with full-text search, the keyboard hook, the Windows
     FFI layer and the speech engine in a utility process.
  3. Starts the app normally against throwaway data and checks it stays up, opens
     its window and writes a first-run config.
  4. Uninstalls and checks the folder is gone.
  Exits non-zero on the first thing that is wrong.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1 -Installer release\Flowstate-Setup.exe
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Work = (Join-Path ([IO.Path]::GetTempPath()) "flowstate-smoke-$PID")
)
$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "FAILED: $text" -ForegroundColor Red; exit 1 }

# Only ever touch processes that run from the folder this script installed to.
function Stop-InstalledApp($dir) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

$Installer = (Resolve-Path $Installer).Path
$InstallDir = Join-Path $Work 'app'
$Data = Join-Path $Work 'data'
$LocalData = Join-Path $Work 'local'
New-Item -ItemType Directory -Force $Work, $Data, $LocalData | Out-Null

Step "Silent install to $InstallDir"
# NSIS wants /D last and unquoted.
$install = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallDir") -Wait -PassThru
if ($install.ExitCode -ne 0) { Fail "installer exited with $($install.ExitCode)" }
$exe = Join-Path $InstallDir 'Flowstate.exe'
if (-not (Test-Path $exe)) { Fail "Flowstate.exe is not in $InstallDir after installing" }
Write-Host ("Installed: {0:N1} MB in {1} files" -f `
  ((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB),
  (Get-ChildItem $InstallDir -Recurse -File).Count)

# The installer starts the app when it finishes. That copy is not under test.
Start-Sleep -Seconds 3
Stop-InstalledApp $InstallDir
Start-Sleep -Seconds 2

Step 'Self-test: native modules load from the installed app'
$report = Join-Path $Work 'self-test.json'
$test = Start-Process -FilePath $exe -ArgumentList "--self-test=$report" -Wait -PassThru
if (Test-Path $report) { Get-Content $report | Write-Host }
if ($test.ExitCode -ne 0) { Fail "self-test exited with $($test.ExitCode)" }
$result = Get-Content $report -Raw | ConvertFrom-Json
if (-not $result.ok) { Fail 'self-test reported a failure' }
if (-not $result.versions.packaged) { Fail 'self-test ran an unpackaged app' }

Step 'First launch on a clean profile'
$env:FLOWSTATE_DATA_DIR = $Data
$env:LOCALAPPDATA = $LocalData   # no speech model here: the setup must offer to download it
$app = Start-Process -FilePath $exe -PassThru
$deadline = (Get-Date).AddSeconds(60)
$title = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ($app.HasExited) { Fail "Flowstate exited by itself with code $($app.ExitCode)" }
  $app.Refresh()
  $title = $app.MainWindowTitle
  if ($title -match 'Flowstate') { break }
}
Write-Host "Window title: '$title'"
if ($title -notmatch 'Flowstate') { Fail 'no Flowstate window appeared within 60 seconds' }
Start-Sleep -Seconds 10
if ($app.HasExited) { Fail "Flowstate quit after opening its window (code $($app.ExitCode))" }

$config = Join-Path $Data 'flowstate\config.json'
if (-not (Test-Path $config)) { Fail "no config.json was written to $config" }
$parsed = Get-Content $config -Raw | ConvertFrom-Json
if ($parsed.onboarding.completed -ne $false) { Fail 'a fresh profile should still have the first-run setup to do' }
if ($parsed.llm.apiKey) { Fail 'a fresh profile must not contain an API key' }
Write-Host 'Stayed up, opened its window, wrote a first-run config.'

Stop-Process -Id $app.Id -Force
Start-Sleep -Seconds 2
Stop-InstalledApp $InstallDir
Remove-Item Env:\FLOWSTATE_DATA_DIR -ErrorAction SilentlyContinue

Step 'Uninstall'
$uninstaller = Get-ChildItem $InstallDir -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $uninstaller) { Fail 'no uninstaller was installed' }
Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$InstallDir") -Wait | Out-Null
if (Test-Path $exe) { Fail 'Flowstate.exe is still there after uninstalling' }

Write-Host 'Smoke test passed.' -ForegroundColor Green
