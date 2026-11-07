# Neo MD 2.2.0 - build all five desktop shells into releases\2.2.0
#
# Why not use each shell's own build.ps1:
#   They hardcode output into releases\2.0.0 (legacy). Using them would put 2.2.0
#   artifacts back into the 2.0.0 folder, polluting history and giving the
#   "unzip and run" acceptance test a stale shell.
#
# Design:
#   - each step is isolated; one shell failing does not abort the others
#   - per-step elapsed time + exit code, summary table at the end
#   - never deletes 2.1.0 / 2.0.0, keeps a rollback path
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# BOM-less files as GBK, which mangles UTF-8 Chinese and breaks string
# terminators with parser errors.
$ErrorActionPreference = 'Continue'
Set-Location 'C:\Data\BAC\neomd\neomd-V1'

$REPO    = 'C:\Data\BAC\neomd\neomd-V1'
$REL     = 'C:\Data\BAC\neomd\releases\2.2.0'
$DOTNET  = 'C:\Data\BAC\neomd\.toolchains\dotnet\dotnet.exe'
$FLUTTER = 'C:\Data\BAC\neomd\.toolchains\flutter\bin'
$CARGO   = Join-Path $env:USERPROFILE '.cargo\bin'

# .NET must use the bundled toolchain; this machine's WinINET proxy points at a
# dead port and would hang NuGet restore.
$env:DOTNET_ROOT = Split-Path (Split-Path $DOTNET -Parent) -Parent
$env:PATH = "$CARGO;$FLUTTER;$env:PATH"
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:http_proxy = ''
$env:https_proxy = ''

New-Item -ItemType Directory -Force -Path $REL | Out-Null

$script:results = @()

function Run($name, [scriptblock]$block) {
    $t0 = Get-Date
    Write-Host ''
    Write-Host ('=' * 72)
    Write-Host "### $name"
    Write-Host ('=' * 72)
    $ok = $true
    try {
        & $block
    } catch {
        Write-Host "EXCEPTION: $($_.Exception.Message)"
        $ok = $false
    }
    $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Write-Host "### $name -> ok=$ok elapsed=${sec}s"
    $script:results += [pscustomobject]@{ Step = $name; Ok = $ok; Sec = $sec }
}

# ---------- Web dist (shared by all shells) ----------
Run 'web' {
    & pnpm --filter '@neomd/web' build 2>&1 | Select-Object -Last 3
    if (-not (Test-Path (Join-Path $REPO 'apps\web\dist\index.html'))) {
        throw 'web dist missing'
    }
}

# ---------- Tauri ----------
Run 'tauri' {
    $out = Join-Path $REL 'NeoMD-2.2.0-tauri-x64'
    Push-Location (Join-Path $REPO 'apps\desktop-tauri\src-tauri')
    try {
        & (Join-Path $CARGO 'cargo.exe') build --release 2>&1 | Select-Object -Last 6
        if ($LASTEXITCODE -ne 0) { throw "cargo exit $LASTEXITCODE" }
    } finally { Pop-Location }

    $relDir = Join-Path $REPO 'apps\desktop-tauri\src-tauri\target\release'
    $exe = Join-Path $relDir 'NeoMD.exe'
    if (-not (Test-Path $exe)) {
        $alt = Get-ChildItem $relDir -Filter '*.exe' -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -notmatch 'build|deps' } | Select-Object -First 1
        if ($alt) { $exe = $alt.FullName } else { throw 'tauri exe not found' }
    }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Copy-Item $exe (Join-Path $out 'NeoMD.exe') -Force
    $dist = Join-Path $REPO 'apps\web\dist'
    if (Test-Path (Join-Path $dist 'index.html')) {
        Remove-Item (Join-Path $out 'webdist') -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item $dist (Join-Path $out 'webdist') -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'data') | Out-Null
    Write-Host "tauri source exe: $exe"
}

# ---------- Qt ----------
Run 'qt' {
    Push-Location (Join-Path $REPO 'apps\desktop-qt')
    try {
        & python build.py 2>&1 | Select-Object -Last 12
    } finally { Pop-Location }
}

# ---------- WinUI3 ----------
Run 'winui3' {
    $out = Join-Path $REL 'NeoMD-2.2.0-winui3-x64'
    Push-Location (Join-Path $REPO 'apps\desktop-winui3')
    try {
        if (Test-Path $out) { Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue }
        & $DOTNET publish 'NeoMD.WinUI3.csproj' -c Release -r win-x64 --self-contained true -o $out 2>&1 | Select-Object -Last 8
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish exit $LASTEXITCODE" }
    } finally { Pop-Location }
    # this shell expects the web assets folder to be named web-dist
    Remove-Item (Join-Path $out 'web-dist') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $REPO 'apps\web\dist') (Join-Path $out 'web-dist') -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'data') | Out-Null
}

# ---------- Flutter ----------
Run 'flutter' {
    $out = Join-Path $REL 'NeoMD-2.2.0-flutter-x64'
    Push-Location (Join-Path $REPO 'apps\desktop-flutter')
    try {
        $env:PUB_HOSTED_URL = 'https://pub.flutter-io.cn'
        $env:FLUTTER_STORAGE_BASE_URL = 'https://storage.flutter-io.cn'
        & (Join-Path $FLUTTER 'flutter.bat') build windows --release 2>&1 | Select-Object -Last 8
        if ($LASTEXITCODE -ne 0) { throw "flutter build exit $LASTEXITCODE" }
    } finally { Pop-Location }

    $built = Join-Path $REPO 'apps\desktop-flutter\build\windows\x64\runner\Release'
    if (-not (Test-Path $built)) { throw 'flutter Release dir missing' }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Copy-Item (Join-Path $built '*') $out -Recurse -Force
    Remove-Item (Join-Path $out 'web-dist') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $REPO 'apps\web\dist') (Join-Path $out 'web-dist') -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'data') | Out-Null
}

# ---------- Electron ----------
Run 'electron' {
    Push-Location (Join-Path $REPO 'apps\desktop')
    try {
        & node build.mjs 2>&1 | Select-Object -Last 12
    } finally { Pop-Location }
}

Write-Host ''
Write-Host ('=' * 72)
Write-Host 'SUMMARY'
Write-Host ('=' * 72)
$script:results | Format-Table -AutoSize | Out-String | Write-Host

Write-Host '--- releases\2.2.0 contents ---'
Get-ChildItem $REL -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.PSIsContainer) {
        $sz = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
               Measure-Object -Property Length -Sum).Sum
        Write-Host ('  {0,-34} {1,8:N1} MB' -f $_.Name, ($sz / 1MB))
    } else {
        Write-Host ('  {0}' -f $_.Name)
    }
}
