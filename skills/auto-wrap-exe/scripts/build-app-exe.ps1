param(
  [string]$ProjectRoot = "",
  [string]$OutputDir = "",
  [switch]$ForceStopRunningApp
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[auto-wrap-exe] $Message"
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
} else {
  $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $ProjectRoot "artifacts"
}

$SrcTauriDir = Join-Path $ProjectRoot "src-tauri"
$TauriConfigPath = Join-Path $SrcTauriDir "tauri.conf.json"
$ReleaseDir = Join-Path $SrcTauriDir "target\release"
$PreferredReleaseExe = Join-Path $ReleaseDir "app.exe"

if (-not (Test-Path $TauriConfigPath)) {
  throw "Cannot find Tauri config: $TauriConfigPath"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo is not installed or not in PATH. Install Rust toolchain first."
}

Write-Step "Project root: $ProjectRoot"
Write-Step "Output dir: $OutputDir"

$runningApp = @(Get-Process -Name "app" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $PreferredReleaseExe
  })

if ($runningApp.Count -gt 0) {
  if ($ForceStopRunningApp) {
    Write-Step "Stopping running app.exe process to unlock build output..."
    $runningApp | Stop-Process -Force
    Start-Sleep -Milliseconds 300
  } else {
    $ids = ($runningApp | Select-Object -ExpandProperty Id) -join ", "
    throw "Detected running app.exe (PID: $ids). Close it first, or rerun with -ForceStopRunningApp."
  }
}

Write-Step "Running Tauri release build..."

Push-Location $ProjectRoot
try {
  cargo tauri build
  if ($LASTEXITCODE -ne 0) {
    throw "Build failed. Exit code: $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

if (-not (Test-Path $ReleaseDir)) {
  throw "Release directory not found after build: $ReleaseDir"
}

$candidates = @()
if (Test-Path $PreferredReleaseExe) {
  $candidates += Get-Item $PreferredReleaseExe
}

if ($candidates.Count -eq 0) {
  $candidates = Get-ChildItem -Path $ReleaseDir -Filter "*.exe" -File |
    Where-Object { $_.Name -notmatch "setup|installer" } |
    Sort-Object LastWriteTime -Descending
}

if ($candidates.Count -eq 0) {
  $depsDir = Join-Path $ReleaseDir "deps"
  if (Test-Path $depsDir) {
    $candidates = Get-ChildItem -Path $depsDir -Filter "*.exe" -File |
      Sort-Object LastWriteTime -Descending
  }
}

if ($candidates.Count -eq 0) {
  throw "No executable found in $ReleaseDir"
}

$sourceExe = $candidates[0].FullName

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$targetExe = Join-Path $OutputDir "app.exe"
Copy-Item -LiteralPath $sourceExe -Destination $targetExe -Force

Write-Step "Build completed."
Write-Host "SOURCE_EXE=$sourceExe"
Write-Host "TARGET_EXE=$targetExe"
