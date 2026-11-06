# Neo MD — WinUI 3 桌面壳构建脚本
# 用法：在 apps/desktop-winui3 目录下执行  .\build.ps1
# 产物输出到 releases/2.0.0/NeoMD-2.0.0-winui3-x64/

$ErrorActionPreference = 'Stop'

$Dotnet = 'C:\Data\BAC\neomd\.toolchains\dotnet\dotnet.exe'
if (-not (Test-Path $Dotnet)) {
    # 回退到 PATH 里的 dotnet
    $Dotnet = (Get-Command dotnet -ErrorAction Stop).Source
}

$env:DOTNET_ROOT = Split-Path (Split-Path $Dotnet -Parent) -Parent
$env:PATH = (Split-Path $Dotnet -Parent) + ';' + $env:PATH

# 本机 WinINET 代理指向已关闭的 127.0.0.1:10801，会导致 NuGet 还原失败。
# 这里显式清空 .NET 代理环境变量；若仍失败，需临时关闭系统代理
# （Internet 选项 -> 连接 -> 局域网设置 -> 取消勾选代理）。
$env:HTTP_PROXY  = ''
$env:HTTPS_PROXY = ''
$env:http_proxy  = ''
$env:https_proxy = ''

$proj = 'NeoMD.WinUI3.csproj'
$repoRoot = (Resolve-Path '..\..').Path
$out = Join-Path $repoRoot 'releases\2.0.0\NeoMD-2.0.0-winui3-x64'

Write-Host "== 发布 self-contained win-x64 ==" -ForegroundColor Cyan
# 停止残留进程，避免输出目录被锁
Get-Process | Where-Object { $_.Name -like 'NeoMD*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

if (Test-Path $out) { Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue }

& $Dotnet publish $proj -c Release -r win-x64 --self-contained true -o $out
if ($LASTEXITCODE -ne 0) { throw "publish 失败，退出码 $LASTEXITCODE" }

Write-Host "== 打包 Web 产物 (webdist) ==" -ForegroundColor Cyan
$dist = Join-Path $repoRoot 'apps\web\dist'
$dest = Join-Path $out 'webdist'
if (-not (Test-Path (Join-Path $dist 'index.html'))) { throw "找不到 apps/web/dist/index.html，请先构建 Web 端" }
Copy-Item -Recurse -Force $dist $dest

# 预建 data 目录（绿色版用户数据，运行时也会自动创建）
New-Item -ItemType Directory -Force -Path (Join-Path $out 'data') | Out-Null

$exe = Join-Path $out 'NeoMD.WinUI3.exe'
$bytes = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Green
Write-Host "exe      : $exe"
Write-Host ("总大小   : {0:N2} MB ({1} 字节)" -f ($bytes/1MB), $bytes)
Write-Host "运行     : 双击 NeoMD.WinUI3.exe"