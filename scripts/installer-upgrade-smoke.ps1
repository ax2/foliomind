param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("nsis", "msi")]
  [string]$Kind,

  [Parameter(Mandatory = $true)]
  [string]$PreviousInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$CurrentInstallerPath
)

$ErrorActionPreference = "Stop"

function Get-InstalledExecutable {
  $roots = @(
    $env:LOCALAPPDATA,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  foreach ($root in $roots) {
    $match = Get-ChildItem -LiteralPath $root -Filter "FolioMind.exe" -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer } |
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

function Invoke-BestEffortUninstall {
  param(
    [string]$UninstallerPath,
    [string]$MsiPath
  )

  try {
    if ($Kind -eq "nsis" -and $UninstallerPath -and (Test-Path -LiteralPath $UninstallerPath -PathType Leaf)) {
      Invoke-CheckedProcess -FilePath $UninstallerPath -ArgumentList @("/S")
    } elseif ($Kind -eq "msi" -and $MsiPath -and (Test-Path -LiteralPath $MsiPath -PathType Leaf)) {
      Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @("/x", ('"' + $MsiPath + '"'), "/qn", "/norestart")
    }
  } catch {
    Write-Warning "Best-effort upgrade smoke cleanup failed: $_"
  }
}

function Assert-Installer {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $installer = Get-Item -LiteralPath $Path
  if ($installer.PSIsContainer) {
    throw "Installer path is a directory: $Path"
  }
  $expectedExtension = if ($Kind -eq "nsis") { ".exe" } else { ".msi" }
  if ($installer.Extension -ine $expectedExtension) {
    throw "Expected a $Kind installer, got $($installer.Name)"
  }
  if ($installer.Length -lt 100KB) {
    throw "Installer is unexpectedly small: $($installer.FullName)"
  }
  return $installer
}

$previousInstaller = Assert-Installer -Path $PreviousInstallerPath
$currentInstaller = Assert-Installer -Path $CurrentInstallerPath
$configDirectory = Join-Path ($env:APPDATA ?? (Join-Path $env:USERPROFILE "AppData\Roaming")) "app.foliomind.desktop"
$markerPath = Join-Path $configDirectory "upgrade-smoke-marker.txt"
$markerValue = "foliomind-upgrade-smoke-$([Guid]::NewGuid().ToString('N'))"
$oldUninstaller = $null
$currentUninstaller = $null
$activeMsiPath = $null

try {
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  Set-Content -LiteralPath $markerPath -Value $markerValue -NoNewline -Encoding utf8

  if ($Kind -eq "nsis") {
    Invoke-CheckedProcess -FilePath $previousInstaller.FullName -ArgumentList @("/S")
  } else {
    $activeMsiPath = $previousInstaller.FullName
    Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/i", ('"' + $previousInstaller.FullName + '"'), "/qn", "/norestart"
    )
  }

  Start-Sleep -Seconds 2
  $oldExecutable = Get-InstalledExecutable
  if (-not $oldExecutable -or $oldExecutable.Length -lt 100KB) {
    throw "Previous $Kind installer did not produce a usable FolioMind.exe"
  }
  if ($Kind -eq "nsis") {
    $oldUninstaller = Join-Path $oldExecutable.DirectoryName "uninstall.exe"
    if (-not (Test-Path -LiteralPath $oldUninstaller -PathType Leaf)) {
      throw "Previous NSIS installer did not produce an uninstaller"
    }
  }

  if ($Kind -eq "nsis") {
    Invoke-CheckedProcess -FilePath $currentInstaller.FullName -ArgumentList @("/S")
  } else {
    $activeMsiPath = $currentInstaller.FullName
    Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/i", ('"' + $currentInstaller.FullName + '"'), "/qn", "/norestart"
    )
  }

  Start-Sleep -Seconds 2
  $currentExecutable = Get-InstalledExecutable
  if (-not $currentExecutable -or $currentExecutable.Length -lt 100KB) {
    throw "Current $Kind installer did not produce a usable FolioMind.exe"
  }
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
      (Get-Content -LiteralPath $markerPath -Raw) -ne $markerValue) {
    throw "User configuration marker was not preserved across $Kind upgrade"
  }
  if ($Kind -eq "nsis") {
    $currentUninstaller = Join-Path $currentExecutable.DirectoryName "uninstall.exe"
    if (-not (Test-Path -LiteralPath $currentUninstaller -PathType Leaf)) {
      throw "Current NSIS installer did not produce an uninstaller"
    }
    Invoke-CheckedProcess -FilePath $currentUninstaller -ArgumentList @("/S")
  } else {
    Invoke-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/x", ('"' + $currentInstaller.FullName + '"'), "/qn", "/norestart"
    )
  }

  Start-Sleep -Seconds 2
  if (Get-InstalledExecutable) {
    throw "FolioMind.exe is still present after $Kind upgrade smoke uninstall"
  }
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
      (Get-Content -LiteralPath $markerPath -Raw) -ne $markerValue) {
    throw "User configuration marker was removed by $Kind uninstall"
  }

  Write-Host "Installer upgrade smoke passed: $Kind previous install, current upgrade, config preservation, and uninstall"
} finally {
  Invoke-BestEffortUninstall -UninstallerPath $currentUninstaller -MsiPath $currentInstaller.FullName
  if ($Kind -eq "nsis" -and $oldUninstaller -and $oldUninstaller -ne $currentUninstaller) {
    Invoke-BestEffortUninstall -UninstallerPath $oldUninstaller -MsiPath $null
  } elseif ($Kind -eq "msi" -and $activeMsiPath) {
    Invoke-BestEffortUninstall -UninstallerPath $null -MsiPath $activeMsiPath
  }
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
  }
}
