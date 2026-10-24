# Markdown 笔记 —— 一键构建
#
# 全程无需管理员权限，工具链全部便携安装在 .\toolchain 下。
#
#   .\build.ps1 -Target check      检查环境
#   .\build.ps1 -Target web        仅构建前端
#   .\build.ps1 -Target windows    构建 Windows x64（安装包 + 便携版）
#   .\build.ps1 -Target android    构建 Android APK（arm64）
#   .\build.ps1 -Target all        两者都构建
#   .\build.ps1 -Target dev        桌面开发模式
#
# 注意：本文件保持纯 ASCII，避免 PowerShell 代码页解析问题。

param(
    [ValidateSet('check', 'web', 'windows', 'android', 'all', 'dev', 'icons', 'setup')]
    [string]$Target = 'check'
)

$ErrorActionPreference = 'Stop'

# Native tools (npm / cargo / gradle) print progress to stderr. Wrapping each
# invocation so that stderr does not abort the script; only real exit codes do.
function Invoke-Native {
    param([scriptblock]$Block, [string]$What = 'command')
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Block 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() }
            else { Write-Host $_ }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) {
        Write-Host "$What failed with exit code $code" -ForegroundColor Red
        exit $code
    }
}

$Root   = $PSScriptRoot
$App    = Join-Path $Root 'app'
$Tauri  = Join-Path $Root 'src-tauri'
$Dist   = Join-Path $Root 'dist'

# Portable toolchain lives next to the project folder.
$Tc     = Join-Path (Split-Path -Parent $Root) 'toolchain'
$EnvPs1 = Join-Path $Tc 'env.ps1'

function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Missing: $cmd" -ForegroundColor Red
        Write-Host $hint -ForegroundColor Yellow
        exit 1
    }
}

function Activate {
    if (Test-Path $EnvPs1) { . $EnvPs1 } else {
        Write-Host 'toolchain\env.ps1 not found. Run: .\build.ps1 -Target setup' -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------- web

function BuildWeb {
    Step 'Building frontend'
    Push-Location $App
    if (-not (Test-Path 'node_modules')) { Invoke-Native { npm install --no-audit --no-fund } 'npm install' }
    Invoke-Native { npx tsc --noEmit } 'typecheck'
    Invoke-Native { npx vite build } 'vite build'
    Pop-Location
    $size = (Get-ChildItem (Join-Path $App 'dist') -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host ('Frontend built: {0:N2} MB' -f ($size / 1MB)) -ForegroundColor Green
}

# ------------------------------------------------------------ windows

function BuildWindows {
    Activate
    Need 'cargo' 'Install Rust from https://rustup.rs'
    BuildWeb

    Step 'Building Windows x64 bundle'
    Push-Location $Root
    Invoke-Native { npx tauri build --target x86_64-pc-windows-gnu --bundles nsis } 'tauri build'
    Pop-Location

    New-Item -ItemType Directory -Force -Path $Dist | Out-Null
    $rel   = Join-Path $Tauri 'target\x86_64-pc-windows-gnu\release'
    $setup = Get-ChildItem (Join-Path $rel 'bundle\nsis') -Filter '*.exe' -ErrorAction SilentlyContinue |
             Select-Object -First 1

    if ($setup) {
        Copy-Item $setup.FullName (Join-Path $Dist 'MarkdownNote_1.0.0_x64-setup.exe') -Force
        Write-Host ('Installer : ' + (Join-Path $Dist 'MarkdownNote_1.0.0_x64-setup.exe')) -ForegroundColor Green
    }
    if (Test-Path (Join-Path $rel 'mdnote.exe')) {
        Copy-Item (Join-Path $rel 'mdnote.exe') (Join-Path $Dist 'MarkdownNote_1.0.0_portable.exe') -Force
        Write-Host ('Portable  : ' + (Join-Path $Dist 'MarkdownNote_1.0.0_portable.exe')) -ForegroundColor Green
    }
    if (Test-Path (Join-Path $rel 'WebView2Loader.dll')) {
        Copy-Item (Join-Path $rel 'WebView2Loader.dll') $Dist -Force
    }
}

# ------------------------------------------------------------ android

function BuildAndroid {
    Activate
    Need 'cargo' 'Install Rust from https://rustup.rs'
    if (-not $env:ANDROID_HOME) {
        Write-Host 'ANDROID_HOME is not set. Run: .\build.ps1 -Target setup' -ForegroundColor Red
        exit 1
    }

    BuildWeb

    $gen = Join-Path $Tauri 'gen\android'
    if (-not (Test-Path $gen)) {
        Step 'Initializing Android project'
        Push-Location $Root
        Invoke-Native { npx tauri android init } 'tauri android init'
        Pop-Location
    }

    # local.properties points Gradle at the portable SDK.
    $sdkEsc = $env:ANDROID_HOME.Replace('\', '\\')
    "sdk.dir=$sdkEsc" | Set-Content (Join-Path $gen 'local.properties') -Encoding ASCII

    Step 'Compiling Rust library for aarch64'
    Push-Location $Tauri
    # crates that build C code (ring, brotli) locate the NDK clang through
    # these variables; cargo's own linker setting alone is not enough.
    $ndkBin = Join-Path $env:NDK_HOME 'toolchains\llvm\prebuilt\windows-x86_64\bin'
    $env:PATH = "$ndkBin;$env:PATH"
    $env:CC_aarch64_linux_android  = Join-Path $ndkBin 'aarch64-linux-android24-clang.cmd'
    $env:CXX_aarch64_linux_android = Join-Path $ndkBin 'aarch64-linux-android24-clang++.cmd'
    $env:AR_aarch64_linux_android  = Join-Path $ndkBin 'llvm-ar.exe'
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $ndkBin 'aarch64-linux-android24-clang.cmd'
    Invoke-Native { cargo build --package mdnote --lib --release --target aarch64-linux-android } 'cargo build (android)'
    Pop-Location

    Step 'Copying native library into jniLibs'
    # Tauri normally creates a symlink here, which requires admin or
    # Developer Mode on Windows. Copying is equivalent and always allowed.
    $so  = Join-Path $Tauri 'target\aarch64-linux-android\release\libmdnote_lib.so'
    $jni = Join-Path $gen 'app\src\main\jniLibs\arm64-v8a'
    New-Item -ItemType Directory -Force -Path $jni | Out-Null
    Copy-Item $so (Join-Path $jni 'libmdnote_lib.so') -Force

    Step 'Assembling APK'
    Push-Location $gen
    # rustBuildArm64Release would re-invoke `tauri android build`; the library
    # is already in place, so skip it and let Gradle package directly.
    Invoke-Native { & .\gradlew.bat assembleArm64Release --no-daemon -x rustBuildArm64Release } 'gradle assembleArm64Release'
    Pop-Location

    Step 'Signing APK'
    New-Item -ItemType Directory -Force -Path $Dist | Out-Null
    $bt      = Join-Path $env:ANDROID_HOME 'build-tools\34.0.0'
    $ks      = Join-Path $Tc 'mdnote-release.jks'
    $srcApk  = Join-Path $gen 'app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk'
    $aligned = Join-Path $Dist 'aligned.apk'
    $signed  = Join-Path $Dist 'MarkdownNote_1.0.0_arm64.apk'

    & (Join-Path $bt 'zipalign.exe') -f -p 4 $srcApk $aligned
    & (Join-Path $bt 'apksigner.bat') sign --ks $ks --ks-key-alias mdnote `
        --ks-pass pass:mdnote123 --key-pass pass:mdnote123 --out $signed $aligned
    Remove-Item $aligned -Force -ErrorAction SilentlyContinue

    & (Join-Path $bt 'apksigner.bat') verify --verbose $signed | Select-Object -First 4
    Write-Host ('APK       : ' + $signed) -ForegroundColor Green
}

# --------------------------------------------------------------- misc

function ShowEnv {
    Activate
    Step 'Environment'
    $rows = @(
        @{ n = 'node';    h = 'https://nodejs.org' },
        @{ n = 'cargo';   h = 'https://rustup.rs' },
        @{ n = 'gcc';     h = 'portable MinGW (see toolchain)' },
        @{ n = 'java';    h = 'portable JDK (see toolchain)' },
        @{ n = 'python';  h = 'only needed for icon generation' }
    )
    foreach ($r in $rows) {
        $c = Get-Command $r.n -ErrorAction SilentlyContinue
        if ($c) {
            $v = (& $r.n --version 2>&1 | Select-Object -First 1)
            Write-Host ("  [OK]      {0,-8} {1}" -f $r.n, $v) -ForegroundColor Green
        } else {
            Write-Host ("  [missing] {0,-8} {1}" -f $r.n, $r.h) -ForegroundColor Yellow
        }
    }
    foreach ($v in 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME') {
        $val = [Environment]::GetEnvironmentVariable($v)
        if ($val) { Write-Host ("  [env]     {0} = {1}" -f $v, $val) -ForegroundColor Green }
    }
}

function BuildIcons {
    Step 'Generating icons'
    python (Join-Path $Root 'tools\make_tauri_icons.py') (Join-Path $Tauri 'icons')
    python (Join-Path $Root 'tools\make_icons.py') (Join-Path $App 'public\icons')
}

function ShowSetup {
    Step 'Toolchain setup'
    Write-Host 'The portable toolchain lives in .\toolchain and needs no admin rights:'
    Write-Host ''
    Write-Host '  Rust       https://rustup.rs  (installed per-user)'
    Write-Host '  MinGW-w64  https://winlibs.com (portable zip)'
    Write-Host '  JDK 17     https://adoptium.net (portable zip)'
    Write-Host '  Android    sdkmanager from commandlinetools'
    Write-Host ''
    Write-Host 'Run .\toolchain\env.ps1 in a shell to activate it,'
    Write-Host 'or use -Target windows / -Target android which activate it automatically.'
}

function StartDev {
    Activate
    Step 'Starting desktop dev mode'
    Push-Location $Root
    npx tauri dev
    Pop-Location
}

switch ($Target) {
    'check'   { ShowEnv }
    'setup'   { ShowSetup }
    'icons'   { BuildIcons }
    'web'     { BuildWeb }
    'windows' { BuildWindows }
    'android' { BuildAndroid }
    'dev'     { StartDev }
    'all'     { BuildWindows; BuildAndroid }
}
