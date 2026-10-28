# 解压 JDK 与 Android SDK（配合 setup-toolchain.ps1 使用）
$ErrorActionPreference = 'Stop'
$ToolsDir = $PSScriptRoot
$CacheDir = Join-Path $ToolsDir '.cache'
$JdkDir   = Join-Path $ToolsDir 'jdk21'
$SdkDir   = Join-Path $ToolsDir 'android-sdk'

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Expand-Zip($Zip, $Dest) {
  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
}

# JDK
if (-not (Test-Path (Join-Path $JdkDir 'bin\java.exe'))) {
  $zip = Join-Path $CacheDir 'jdk21-tuna.zip'
  if (-not (Test-Path $zip)) { throw "缺少 $zip" }
  Write-Host '解压 JDK…'
  $tmp = Join-Path $CacheDir 'jdk-extract'
  Expand-Zip $zip $tmp
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $JdkDir) { Remove-Item -Recurse -Force $JdkDir }
  Move-Item $inner.FullName $JdkDir
  Remove-Item -Recurse -Force $tmp
}
& (Join-Path $JdkDir 'bin\java.exe') -version 2>&1 | Select-Object -First 3

# Android cmdline-tools
$latest = Join-Path $SdkDir 'cmdline-tools\latest'
if (-not (Test-Path (Join-Path $latest 'bin\sdkmanager.bat'))) {
  $zip = Join-Path $CacheDir 'cmdline-tools.zip'
  if (-not (Test-Path $zip)) { throw "缺少 $zip" }
  Write-Host '解压 Android cmdline-tools…'
  $tmp = Join-Path $CacheDir 'cli-extract'
  Expand-Zip $zip $tmp
  New-Item -ItemType Directory -Force -Path $latest | Out-Null
  Copy-Item -Recurse -Force (Join-Path $tmp 'cmdline-tools\*') $latest
  Remove-Item -Recurse -Force $tmp
}

$env:JAVA_HOME = $JdkDir
$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir
$sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'

Write-Host '接受许可…'
$yes = ("y`r`n" * 80)
$yes | & $sdkmanager --sdk_root="$SdkDir" --licenses 2>&1 | Select-Object -Last 3

Write-Host '安装 SDK 组件…'
& $sdkmanager --sdk_root="$SdkDir" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 2>&1 | Select-Object -Last 6

Write-Host '完成。'
Write-Host "JDK21_HOME=$JdkDir"
Write-Host "ANDROID_HOME=$SdkDir"
