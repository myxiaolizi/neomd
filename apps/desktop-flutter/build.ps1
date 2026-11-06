$ErrorActionPreference = "Stop"

$env:PATH = "C:\Data\BAC\neomd\.toolchains\flutter\bin;$env:PATH"
$env:PUB_HOSTED_URL = "https://pub.flutter-io.cn"
$env:FLUTTER_STORAGE_BASE_URL = "https://storage.flutter-io.cn"

$projectDir = "C:\Data\BAC\neomd\neomd-V1\apps\desktop-flutter"
$releaseDir = "C:\Data\BAC\neomd\releases\2.0.0\NeoMD-2.0.0-flutter-x64"

Write-Host "==> [1/3] Building Flutter Windows x64 Release..."
Push-Location $projectDir
try {
    flutter build windows --release
} finally {
    Pop-Location
}

Write-Host "==> [2/3] Assembling green release package in $releaseDir..."
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item "$projectDir\build\windows\x64\runner\Release\*" -Destination $releaseDir -Recurse -Force

Write-Host "==> [3/3] Done! Executable is at: $releaseDir\neomd_flutter.exe"
