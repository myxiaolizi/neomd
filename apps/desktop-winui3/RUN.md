# Neo MD — WinUI 3 桌面壳（Windows x64）

> 四技术栈性能对比之 WinUI 3 版：.NET 9 + Windows App SDK (WinUI 3) + WebView2。

## 架构（与 Electron / Tauri / Qt 三版完全一致）

1. C# 内起一个只绑 `127.0.0.1` 随机端口的本地 HTTP 服务器，托管 Vue 3 构建产物（`webdist/`）。
2. 同一服务器把 `/api/*` 反向代理到 `https://md.zhengl.vip`，并加请求头 `x-neomd-shell: winui3`
   （`UseProxy=false` 直连，规避本机已失效的 WinINET 代理）。
3. WebView2 加载 `http://127.0.0.1:<port>/`。
4. 首帧前通过 `AddScriptToExecuteOnDocumentCreatedAsync` 注入 `window.NeoMD`；
   `bridge.*` 全部走 `fetch('/__bridge/<method>', POST)`，由 C# 执行真实文件系统/对话框/路径操作
   （刻意不用 `AddHostObjectToScript`，规避 COM 序列化坑）。

Web 端 `server-endpoint.ts` 判定 `isRemoteWeb()` 后 API 走同源相对路径 `/api/*`，本地服务器反代生效，全程同源、无 CORS 预检。

## 产物

- 发布目录：`releases/2.0.0/NeoMD-2.0.0-winui3-x64/`
- 主程序：`NeoMD.WinUI3.exe`（Unpackaged 绿色版，self-contained：自带 .NET 9 + Windows App SDK 运行时，免安装）
- 用户数据：exe 同级 `data/`（不含字色、不写 AppData / 注册表）

## 运行

双击 `NeoMD.WinUI3.exe`。首次启动会自动把 `webdist/` 静态托管并拉起窗口。

## 构建

```powershell
# 前提：已构建 Web 端（apps/web/dist 存在）
cd apps/desktop-winui3
.\build.ps1
```

说明：
- 默认用 `C:\Data\BAC\neomd\.toolchains\dotnet\dotnet.exe`（.NET 9.0.306 SDK），找不到则回退 PATH 里的 dotnet。
- 若 NuGet 还原失败（报 `127.0.0.1:10801` 拒绝连接），说明系统代理指向已关闭的本地端口，需临时在
  「Internet 选项 → 连接 → 局域网设置」关闭代理后再跑。
- WinAppSDK 锁定 **1.7.250606001**（本机 NuGet 缓存已完整存在，可离线构建；1.8 需联网被系统代理拦截）。

## 版本锁定与关键开关

| 项 | 值 | 说明 |
| --- | --- | --- |
| TargetFramework | `net9.0-windows10.0.19041.0` | 最低 17763 |
| WindowsPackageType | `None` | 绿色版/未打包关键开关 |
| EnableMsixTooling | `true` | 用 WinAppSDK 自带 MSIX 工具生成 `resources.pri`，裸 dotnet SDK 可编译，**不代表打成 MSIX** |
| WindowsAppSDKSelfContained | `true` | 打包 Windows App SDK 运行时 |
| RuntimeIdentifiers | `win-x64` | 自包含发布 |
| Microsoft.WindowsAppSDK | `1.7.250606001` | 缓存内、可离线 |
| Microsoft.Windows.SDK.BuildTools | `10.0.26100.1742` | 缓存内 |

## 桥接口覆盖（对齐 `packages/core/src/platform.ts`）

| 分组 | 方法 | 状态 |
| --- | --- | --- |
| fs | readText / readBinary / writeText / writeBinary / mkdirp / remove / rename / list / exists / stat | 全部实现（10 个，MUST） |
| dialog | pickDirectory / pickFile / saveFile | 实现（SHOULD） |
| paths | documents / userData / vaultDefault | 实现 |
| shell | openExternal / showItemInFolder | 实现 |
| win | isMaximized / toggleMaximize / minimize / close | 实现 |
| app | version / onOpenFile | version 实现；onOpenFile 保留同步 void 签名（无文件关联源） |
| secrets | encrypt / decrypt | 实现（exe 同级 `data/.bridge-key` 可逆混淆，非平台凭据） |

契约要点：`fs.stat` 不存在返回 `null` 且只含 `{size,mtime}`；`fs.list` 字段为 `isDirectory`（非 `isDir`）、每项含 `{name,isDirectory,size,mtime}`；未实现方法返回 `{ok:false, error:"NOT_IMPLEMENTED"}`，由注入脚本 `reject`，绝不同步抛异常。

## 验证结果（已实测）

- 冷启动（进程启动 → `window.NeoMD` 注入上报 `boot.json`）：**~1.0 s**（实测 992 / 1170 / 1213 ms）。
- `window.NeoMD.env === 'desktop'`：确认（注入脚本首帧即 `fetch('/__bridge/app.ready')` 上报，落盘 `data/boot.json`）。
- 反代 `/api/plugins/market`：HTTP 200，`{"ok":true,...}`，与上游一致。
- 截图：`screenshot.png`（1440×920），PrintWindow 捕获，内容非黑屏（亮度 0–255、20 个色箱）。