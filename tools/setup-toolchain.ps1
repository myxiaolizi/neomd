# Neo MD toolchain setup (ASCII only: Windows PowerShell 5.1 compatible)
# Installs a portable JDK 21 and Android SDK into tools/ without admin rights.
[CmdletBinding()]
param(
  [switch]$SkipJdk,
  [switch]$SkipAndroid,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ToolsDir = $PSScriptRoot
$CacheDir = Join-Path $ToolsDir '.cache'
$JdkDir   = Join-Path $ToolsDir 'jdk21'
$SdkDir   = Join-Path $ToolsDir 'android-sdk'
$CliZip   = Join-Path $CacheDir 'cmdline-tools.zip'

$JdkUrls = @(
  'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
  'https://aka.ms/download-jdk/microsoft-jdk-21.0.12-windows-x64.zip'
)
$CliUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Remote([string]$Url, [string]$Out) {
  if ((Test-Path $Out) -and -not $Force -and (Get-Item $Out).Length -gt 50MB) {
    Write-Host ("  cached " + $Out)
    return
  }
  Write-Host ("  GET " + $Url)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & curl.exe -L --fail --silent --show-error --ssl-no-revoke --retry 3 --retry-delay 2 -o $Out $Url 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0 -or -not (Test-Path $Out)) { throw ("download failed (curl exit " + $code + "): " + $Url) }
}

function Expand-Zip([string]$Zip, [string]$Dest) {
  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
}

if (-not $SkipJdk) {
  Write-Host '[1/2] portable JDK 21'
  if ((Test-Path (Join-Path $JdkDir 'bin\java.exe')) -and -not $Force) {
    Write-Host '  already installed'
  } else {
    $ok = $false
    foreach ($u in $JdkUrls) {
      try {
        $zip = Join-Path $CacheDir ([IO.Path]::GetFileName($u))
        Get-Remote $u $zip
        $ok = $true
        break
      } catch {
        Write-Host ("  failed: " + $_.Exception.Message)
      }
    }
    if (-not $ok) { throw 'all JDK download sources failed' }
    $tmp = Join-Path $CacheDir 'jdk-extract'
    Expand-Zip $zip $tmp
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (Test-Path $JdkDir) { Remove-Item -Recurse -Force $JdkDir }
    Move-Item $inner.FullName $JdkDir
    Remove-Item -Recurse -Force $tmp
  }
  $prevEa = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & (Join-Path $JdkDir 'bin\java.exe') -version 2>&1 | Select-Object -First 1
  $ErrorActionPreference = $prevEa
}

if (-not $SkipAndroid) {
  Write-Host '[2/2] Android SDK'
  if (-not (Test-Path (Join-Path $JdkDir 'bin\java.exe'))) { throw 'JDK is required for sdkmanager' }

  $latest = Join-Path $SdkDir 'cmdline-tools\latest'
  if (-not (Test-Path (Join-Path $latest 'bin\sdkmanager.bat'))) {
    Get-Remote $CliUrl $CliZip
    $tmp = Join-Path $CacheDir 'cli-extract'
    Expand-Zip $CliZip $tmp
    New-Item -ItemType Directory -Force -Path $latest | Out-Null
    Copy-Item -Recurse -Force (Join-Path $tmp 'cmdline-tools\*') $latest
    Remove-Item -Recurse -Force $tmp
  }

  $env:JAVA_HOME = $JdkDir
  $env:ANDROID_HOME = $SdkDir
  $env:ANDROID_SDK_ROOT = $SdkDir
  $env:PATH = "$JdkDir\bin;$SdkDir\platform-tools;$latest\bin;$env:PATH"

  $sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'
  Write-Host '  accepting licenses'
  $yes = ("y`r`n" * 80)
  $yes | & $sdkmanager "--sdk_root=$SdkDir" --licenses 2>&1 | Select-Object -Last 3

  Write-Host '  installing platform-tools / platforms;android-35 / build-tools;35.0.0'
  & $sdkmanager "--sdk_root=$SdkDir" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 2>&1 | Select-Object -Last 6
}

Write-Host ''
Write-Host 'toolchain ready:'
if (Test-Path (Join-Path $JdkDir 'bin\java.exe')) { Write-Host ("  JDK21=" + $JdkDir) }
if (Test-Path (Join-Path $SdkDir 'platforms')) { Write-Host ("  ANDROID_HOME=" + $SdkDir) }
