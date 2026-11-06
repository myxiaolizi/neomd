# Neo MD 2.0.0 (Flutter Windows x64 Desktop Shell)

## 启动方式

直接双击或在命令行运行：

```powershell
.\neomd_flutter.exe
```

一键重新构建脚本：
```powershell
.\build.ps1
```

## 架构说明

1. **本地静态服务与反向代理**：
   - 启动时通过 `dart:io` 的 `HttpServer` 在 `127.0.0.1:0`（随机可用端口）启动本地服务器，承载 `C:\Data\BAC\neomd\neomd-V1\apps\web\dist`（若同级存在 `web-dist` 或 `data\web-dist` 则优先使用）。
   - 将 `/api/*` 请求反向代理到 `https://md.zhengl.vip`，并自动附加请求头 `x-neomd-shell: flutter`。
2. **宿主标记与 NativeBridge 注入**：
   - 在返回 `index.html` 时向 `<head>` 注入 `<script>window.NeoMD = { env: 'desktop', version: '2.0.0', bridge: ... }</script>`。
   - `window.NeoMD.bridge` 通过同源 HTTP 端点 `/__bridge/<method>` 与 Dart 端通信，完整实现 `fs.*`（10 个方法）、`paths.*`（3 个方法）、`app.version()`、`app.onOpenFile(cb)`。
   - 未实现的 `dialog.*` / `secrets.*` / `shell.*` / `win.*` 均按规范返回 `Promise.reject(new Error('NOT_IMPLEMENTED'))`，不会同步抛出异常。
3. **`data\` 目录：既是程序资产、又是用户数据（本版与其它三版不同！）**：
   Flutter Windows release 会把程序必需的资产打包在 exe 同级的 `data\` 下：

   | 路径 | 性质 | 能否删除 |
   | --- | --- | --- |
   | `data\app.so` | **程序必需**（Dart AOT 编译产物） | ❌ 删了无法启动 |
   | `data\icudtl.dat` | **程序必需**（ICU 国际化数据） | ❌ 删了无法启动 |
   | `data\flutter_assets\` | **程序必需**（字体/着色器/清单） | ❌ 删了无法启动 |
   | `data\vault\` | 用户数据（默认笔记仓库） | ✅ 可删 |
   | `data\userData\` | 用户数据（应用数据） | ✅ 可删 |
   | `data\webview2\` | WebView2 运行缓存 | ✅ 可删（会自动重建） |

   > ⚠ **重要**：如果你要「重置」本程序或清理发布目录，**只删上面标 ✅ 的三项**，
   > 绝不要整个删掉 `data\`。整个删掉后程序会**启动即静默退出**——
   > 退出码 0、没有任何错误弹窗、也没有窗口出现，非常容易被误判成"程序坏了"。
   >
   > 另外三版（Tauri / WinUI 3 / Qt）的 `data\` **只是用户数据**，可以整个删除，
   > 但它们的 Web 产物放在各自的 `webdist\` / `web\dist\` / `_internal\web-dist\` 里。
   > **四个壳的 `data\` 语义并不相同**，这是横向对比时最容易踩的坑。

## 运行依赖

- Windows 10 (1809+) / Windows 11 x64
- 系统已安装 **Microsoft Edge WebView2 Runtime**（Windows 10/11 默认自带）
- Visual C++ Redistributable 2015–2022 x64

## 已知问题与限制

- `webview_windows` (v0.4.0) 基于 `Windows.Graphics.Capture` 纹理合成渲染 WebView2，需要 Windows 10 1809 及以上版本。
- 原生文件选择框 `dialog.*` 暂未接通原生 Win32 对话框，调用时返回 `Promise.reject(new Error('NOT_IMPLEMENTED'))`，前端自动走默认 Vault 路径逻辑。
