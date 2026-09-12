param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("nsis", "msi")]
  [string]$Kind,

  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

function Get-InstalledExecutable {
  $roots = @(
    $env:LOCALAPPDATA,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  foreach ($root in $roots) {
    $match = Get-ChildItem -LiteralPath $root -Filter "FolioMind.exe" -File -Recurse -Force -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) { return $match }
  }

  return $null
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList
  )

  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "$FilePath exited with code $($process.ExitCode)"
  }
}

$installer = Get-Item -LiteralPath $InstallerPath -File
$expectedExtension = if ($Kind -eq "nsis") { ".exe" } else { ".msi" }
if ($installer.Extension -ine $expectedExtension) {
  throw "Expected a $Kind installer, got $($installer.Name)"
}
if ($installer.Length -lt 100KB) {
  throw "Installer is unexpectedly small: $($installer.FullName)"
}

$installedExecutable = $null
$uninstaller = $null
$msiLog = Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) "foliomind-installer-smoke-$Kind.log"
$quotedInstaller = '"' + $installer.FullName + '"'
$quotedMsiLog = '"' + $msiLog + '"'

try {
  if ($Kind -eq "nsis") {
    Invoke-CheckedProcess -FilePath $installer.FullName -ArgumentList @("/S")
  } else {
    Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/i", $quotedInstaller, "/qn", "/norestart", "/l*v", $quotedMsiLog
    )
  }

  Start-Sleep -Seconds 2
  $installedExecutable = Get-InstalledExecutable
  if (-not $installedExecutable) {
    throw "Installed FolioMind.exe was not found after $Kind installation"
  }
  if ($installedExecutable.Length -lt 100KB) {
    throw "Installed executable is unexpectedly small: $($installedExecutable.FullName)"
  }

  if ($Kind -eq "nsis") {
    $uninstaller = Join-Path $installedExecutable.DirectoryName "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
      throw "NSIS uninstaller was not found next to the installed executable"
    }
    Invoke-CheckedProcess -FilePath $uninstaller -ArgumentList @("/S")
  } else {
    Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/x", $quotedInstaller, "/qn", "/norestart", "/l*v", $quotedMsiLog
    )
  }

  Start-Sleep -Seconds 2
  if (Get-InstalledExecutable) {
    throw "FolioMind.exe is still present after $Kind uninstall"
  }

  Write-Host "Installer smoke passed: $Kind install and uninstall"
} finally {
  # A failed assertion must not leave a product installation on a shared
  # runner. Best-effort cleanup is intentionally separate from the assertion
  # above so the original failure remains visible in the job log.
  if ($Kind -eq "nsis" -and $uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try { Invoke-CheckedProcess -FilePath $uninstaller -ArgumentList @("/S") } catch { Write-Warning $_ }
  } elseif ($Kind -eq "msi") {
    try { Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @("/x", $quotedInstaller, "/qn", "/norestart") } catch { Write-Warning $_ }
  }
}
