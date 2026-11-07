# Deploy apps/web/dist into every shell of a given release.
#
# Each shell expects the web assets at a different path, which is exactly the
# kind of thing that silently goes stale: a shell keeps running an old bundle
# and every later test describes code that is no longer in the repo.
#
# Usage: powershell -File tools\sync-webdist.ps1 -Version 2.2.0
param([string]$Version = '2.2.0')

$ErrorActionPreference = 'Continue'
$REPO = 'C:\Data\BAC\neomd\neomd-V1'
$REL  = "C:\Data\BAC\neomd\releases\$Version"
$DIST = Join-Path $REPO 'apps\web\dist'

if (-not (Test-Path (Join-Path $DIST 'index.html'))) {
    Write-Host 'ERROR: apps\web\dist\index.html missing - build web first'
    exit 1
}

# shell -> where that shell reads its web assets from
$TARGETS = @(
    @{ shell = 'tauri';    path = "NeoMD-$Version-tauri-x64\webdist" },
    @{ shell = 'qt';       path = "NeoMD-$Version-qt-x64\_internal\web-dist" },
    @{ shell = 'winui3';   path = "NeoMD-$Version-winui3-x64\web-dist" },
    @{ shell = 'flutter';  path = "NeoMD-$Version-flutter-x64\web-dist" },
    @{ shell = 'electron'; path = "NeoMD-$Version-electron-x64\resources\webdist" }
)

$ok = 0
$fail = 0
foreach ($t in $TARGETS) {
    $dest = Join-Path $REL $t.path
    $parent = Split-Path $dest -Parent
    if (-not (Test-Path $parent)) {
        Write-Host ("{0,-9} SKIP parent missing: {1}" -f $t.shell, $parent)
        $fail++
        continue
    }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    Copy-Item $DIST $dest -Recurse -Force
    if (Test-Path (Join-Path $dest 'index.html')) {
        $n = (Get-ChildItem $dest -Recurse -File | Measure-Object).Count
        Write-Host ("{0,-9} OK  {1} files -> {2}" -f $t.shell, $n, $dest)
        $ok++
    } else {
        Write-Host ("{0,-9} FAIL after copy: {1}" -f $t.shell, $dest)
        $fail++
    }
}

Write-Host ""
Write-Host "summary: $ok deployed, $fail failed"
exit $(if ($fail -eq 0) { 0 } else { 1 })
