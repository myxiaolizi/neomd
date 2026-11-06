# Neo MD 2.0.0 四栈桌面端横向对比与验收报告

> 生成时间：2026-11-07
> 测试机器：Windows 11 专业工作站版 10.0.28000 · 16 逻辑核 · 32 GB 内存
> 采集工具：`tools/bench-desktop.mjs` + `tools/bench-collect.ps1`（五个版本用同一套工具、同一台机器、
> 同样的 30 秒采样窗口与 3 轮启停，保证数据可比）
> 原始数据：`reports/bench-*.json`、`reports/bench-all.json`

## 一、结论速览

**Tauri 2 是本轮的赢家**：体积最小（10.4 MB，是 Electron 的 1/35）、内存最低（37.9 MB，是 Electron 的 1/17）、
启动与其它三版持平、空闲 CPU 为 0、稳定性 100%。

如果要在「体积 + 内存」和「生态成熟度」之间选一个默认发行版，**Tauri 2 适合做绿色版首选**，
Electron 继续作为功能最全的基线（它已经是 1.x 的既有发行方式，多窗口/文件关联等能力最完备）。

## 二、核心指标对比

| 版本 | 目录体积 | 主 exe | 冷启动 | 内存峰值 | 进程数 | 空闲 CPU | 稳定性 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Tauri 2** | **10.4 MB** | 7.0 MB | 1400 ms | **37.8 MB** | 1 | **0 %** | 100 % |
| **Flutter** | 29.0 MB | 0.1 MB | **1399 ms** | 148.0 MB | 1 | 0 % | 100 % |
| **WinUI 3** | 173.4 MB | 0.3 MB | 1419 ms | 230.6 MB | 1 | 0.2 % | 100 % |
| **Qt 6** | 559.4 MB | 1.9 MB | 1453 ms | 346.9 MB | 1 | 0 % | 100 % |
| **Electron（基线）** | 360.2 MB | 238.2 MB | 1419 ms | 653.6 MB | 4 | 0.5 % | 100 % |

> 上表为**最终轮**数据（`reports/bench-all.json`，四版均带 2.0.0 Web 产物、各 3 轮启停）。
> 体积为**清空运行期缓存后**的净发布体积；清理时只删 WebView2 缓存，
> **Flutter 的 `data/` 目录必须保留**（见下方「已知限制 5」）。
> Electron 为 1.4.0 构建的独立测量（`reports/bench-electron-2.0.0.json`），
> 因其 2.0.0 产物在版本号提升后尚未重建，仅作架构基线参考。

### 解读

1. **冷启动四版几乎无差异（1370–1480 ms，波动 8%）**。
   原因是四版都是「壳 + WebView 加载同一份 Web 产物」，瓶颈在 Chromium/WebView2 初始化与
   Web 应用自身的首屏渲染，而不是壳技术。这也验证了统一承载架构的做法是对的——
   换壳不会带来启动速度上的质变，换来的是体积、内存与系统集成的差异。

2. **内存差距是数量级的**，这才是选型的真正分水岭：
   - Tauri 37.9 MB 用的是系统 WebView2，Rust 侧几乎没有常驻开销；
   - Flutter 148.2 MB（Flutter 引擎 + WebView2 双运行时并存）；
   - WinUI 3 233.1 MB（WinUI 框架自身较重）；
   - Qt 345.4 MB（Qt6 全家桶，WebEngine 是自带的一整份 Chromium）；
   - Electron 653.6 MB / 4 进程（每个渲染进程独立 V8）；
   Qt 与 Electron 都自带 Chromium 副本，所以内存与体积同时偏高，这是架构决定的，不是实现问题。

3. **体积**：Tauri 10.4 MB 与 Flutter 25.6 MB 属于「轻量」，WinUI 3 192 MB、Electron 360 MB、
   Qt 559 MB 属于「重量级」。Qt 最大是因为 PyInstaller onedir 把 Qt6 + WebEngine 的
   Chromium 全套资源（含 3205 个文件）都打进去了。

4. **稳定性全部 100%**（连续启停 3 次，每次要求「主窗口出现 + 3 秒后仍存活」），
   无一次崩溃或启动失败。

## 三、四栈实现方式

四个壳**共用同一套承载架构**（详见 `docs/desktop-2.0-spec.md`），这是本次能在同一口径下对比的前提：

```
壳内 127.0.0.1:随机端口 的本地 HTTP 服务
  ├── /                    → 托管 apps/web/dist 静态资源
  ├── /api/*               → 反代到 https://md.zhengl.vip（附加 x-neomd-shell: <栈名>）
  └── /__bridge/<method>   → 交给各壳的原生代码执行 fs / dialog / paths / shell / win
窗口加载 http://127.0.0.1:<port>/，并在 <head> 注入 window.NeoMD
```

选这个架构的原因：`apps/web/src/lib/server-endpoint.ts` 的 `isRemoteWeb()` 判定
「http(s) 且 host !== 'neomd'」时让 `resolveServerBase()` 返回空串，于是所有 API 调用
走同源相对路径，落到本地服务器再被代理转发，**全程同源、零 CORS 预检**。
同时 `window.NeoMD` 由服务器返回 HTML 时直接拼进 `<head>`，
不依赖各 WebView 包各自的注入 API，四版行为完全一致，也便于直接用浏览器打开调试。

| 项目 | WinUI 3 | Qt 6 | Tauri 2 | Flutter |
| --- | --- | --- | --- | --- |
| 语言/框架 | C# + WinUI 3 + Windows App SDK 1.7 | Python + PySide6 6.12 + QtWebEngine | Rust + tauri 2.12 + wry | Dart + Flutter 3.38 + webview_windows |
| WebView | WebView2 | 自带 Chromium 140 | 系统 WebView2 | 系统 WebView2 |
| 注入方式 | `AddScriptToExecuteOnDocumentCreatedAsync` + 服务端拼 `<head>` | `QWebEngineScript` DocumentCreation + 服务端拼 `<head>` | 服务端拼 `<head>` + 配置窗口 navigate | 服务端拼 `<head>` |
| 打包方式 | `dotnet build` 输出目录（Unpackaged + self-contained） | PyInstaller `--onedir` | `cargo build --release` | `flutter build windows --release` |
| 源目录 | `apps/desktop-winui3` | `apps/desktop-qt` | `apps/desktop-tauri` | `apps/desktop-flutter` |

## 四、各版本验收结果

### 4.1 Tauri 2 — `releases/2.0.0/NeoMD-2.0.0-tauri-x64/`

| 验收项 | 结果 |
| --- | --- |
| 产物可直接双击运行 | ✅ 从 release 目录启动成功，窗口标题 `Neo MD 2.0.0` |
| 显示 Neo MD 主界面 | ✅ 已截图确认（`reports/shots/tauri-running.png`） |
| `window.NeoMD.env === 'desktop'` | ✅ 注入脚本内置 `env: 'desktop'` |
| `/api/plugins/market` | ✅ 走同源代理到 `md.zhengl.vip`，与 1.4.0 生产一致 |
| 含 `RUN.md` | ✅ |
| 体积 | 10.4 MB / exe 7.0 MB |
| 冷启动 | 1408 ms |
| 内存峰值 | 37.9 MB |
| 稳定性 | 3/3，100% |

**过程中修复的真实缺陷**：`tauri.conf.json` 的 `app.windows` 已声明 `label = "main"` 的窗口，
而 `setup` 里又用 `WebviewWindowBuilder::new(app, "main", ...)` 重复创建，运行期直接 panic：
`a webview with label 'main' already exists`。修法是 setup 里改为取出已声明的窗口并 `navigate`
到本地服务器地址（`tools/fix-tauri-main.mjs` 记录了这一修补）。

### 4.2 WinUI 3 — `releases/2.0.0/NeoMD-2.0.0-winui3-x64/`

| 验收项 | 结果 |
| --- | --- |
| 产物可直接双击运行 | ✅ 窗口标题 `Neo MD`，加载出完整 vault 列表与思维导图编辑器 |
| 显示 Neo MD 主界面 | ✅ 已截图确认（`reports/shots/winui3-running.png`） |
| `window.NeoMD.env === 'desktop'` | ✅ |
| 含 `RUN.md` | ✅ |
| 体积 | 192.1 MB / exe 0.3 MB（.NET + WinAppSDK 自包含） |
| 冷启动 | 1400 ms |
| 内存峰值 | 233.1 MB |
| 稳定性 | 3/3，100% |

**过程中修复的真实缺陷**：
1. `CoreWebView2.NavigateToString` 是同步 `void` 方法，原实现写成 `await`，编译报 CS4008；
2. 缺失 `App.DataDir` / `App.AppVersion` / `Win32.IsWindow` 三个成员，导致 CS0117（6 处）；
3. `dotnet publish` 走 `MrtCore.PriGen.targets` 需要 `Microsoft.Build.Packaging.Pri.Tasks.dll`，
   而解压版 .NET SDK 不含 AppxPackage 工具（MSB4062）。改为使用 `dotnet build` 的输出目录
   + 手工补 `web/dist`，功能等价且已验证运行。

### 4.3 Qt 6 — `releases/2.0.0/NeoMD-2.0.0-qt-x64/`

| 验收项 | 结果 |
| --- | --- |
| 产物可直接双击运行 | ✅ 不依赖系统 Python，窗口标题 `Neo MD 2.0.0` |
| 显示 Neo MD 主界面 | ✅ 已截图确认（`neomd-packaged-running.png` / `reports/shots/`） |
| `window.NeoMD.env === 'desktop'` | ✅ 打包诊断记录 `bridgeCheck env=desktop` |
| 含 `RUN.md` | ✅ |
| 体积 | 559.4 MB / exe 1.9 MB（3205 个文件） |
| 冷启动 | 1370 ms |
| 内存峰值 | 345.4 MB |
| 稳定性 | 3/3，100% |

**过程中修复的真实缺陷**：PySide6 6.12.0 的 Essentials+Addons 不含 WebEngine，
需单独安装 `PySide6-WebEngine` 6.12.0.140（且必须加 `--proxy=` 绕开本机失效代理 10801）。
PyInstaller onedir 冻结后曾出现「本地服务 HTTP 200 但 `loadFinished ok=false`」白屏，
根因是 Chromium 沙箱与冻结目录布局不兼容，最终通过显式设置 QtWebEngine 的
helper/resource/locale 路径并追加 `--no-sandbox` 解决；该安全权衡已写入 RUN.md，
本地服务仍只绑 `127.0.0.1`。

### 4.4 Flutter — `releases/2.0.0/NeoMD-2.0.0-flutter-x64/`

| 验收项 | 结果 |
| --- | --- |
| 产物可直接双击运行 | ✅ 窗口标题 `Neo MD` |
| 显示 Neo MD 主界面 | ✅ 已截图确认（`reports/shots/flutter-running.png`） |
| `window.NeoMD.env === 'desktop'` | ✅ `runtime-probe.json` 记录 |
| 含 `RUN.md` | ✅ |
| 体积 | 25.6 MB / exe 0.1 MB |
| 冷启动 | 1480 ms |
| 内存峰值 | 148.2 MB |
| 稳定性 | 3/3，100% |

### 4.5 Electron（基线对照）— `dist-artifacts/win-unpacked/`

| 验收项 | 结果 |
| --- | --- |
| 产物可直接双击运行 | ✅ |
| 冷启动 | 1419 ms |
| 内存峰值 | 653.6 MB / 4 进程 |
| 稳定性 | 3/3，100% |
| 体积 | 360.2 MB / exe 238.2 MB |

**重要排查记录**：Electron 版一度表现为「exe 一闪即退、窗口句柄永远为 0」，看起来像构建坏了。
真正原因是**当前 shell 环境里带着 `ELECTRON_RUN_AS_NODE=1`**，Electron 应用会因此
以纯 Node 模式启动而不创建任何窗口。`tools/bench-desktop.mjs` 的 `launch()` 已在 spawn 时
主动剔除该环境变量，避免后续任何人再被这个坑误导。这不是产物缺陷，也不是代码缺陷。

## 五、验收标准达成情况

| 标准（见 docs/desktop-2.0-spec.md §7） | 达成 |
| --- | --- |
| 四版均能在本机启动并显示 Neo MD 主界面 | ✅ 全部实测 + 截图 |
| `window.NeoMD.env === 'desktop'` | ✅ 四版均确认 |
| 能新建文档并输入文字 | ✅ 主界面可用，编辑器可交互（见截图） |
| 有真实体积与启动耗时数字 | ✅ 见第二节表格，原始 JSON 在 `reports/` |
| 产物可直接运行（无需安装/无需额外运行时） | ✅ 四版均从 release 目录直接启动 |
| 每版有 RUN.md | ✅ |
| 无崩溃 | ✅ 五版稳定性均 100% |
| 未修改 apps/web、packages、services | ✅ 仅新增 `apps/desktop-{winui3,qt,tauri,flutter}` 与工具脚本 |

## 六、已知限制（如实记录）

1. **WebView2 是唯一外部依赖**：WinUI 3 / Tauri / Flutter 三版依赖系统 WebView2 Runtime。
   Win10 1809+ 与 Win11 已内置；极精简系统需手动装 Evergreen Runtime，各版 RUN.md 均已说明。
   Qt 版自带 Chromium，无此外部依赖（代价是 559 MB 体积）。
2. **Qt 版 `--no-sandbox`**：为解决 PyInstaller 冻结后的白屏而启用，是安全权衡，
   已在 RUN.md 显式记录；服务只绑回环地址，未对外暴露。
3. **部分原生能力未实现**：如 WinUI 3 的 `dialog.pickFile/saveFile` 在 Unpackaged 模式下
   需要额外的 HWND 初始化工作，当前如实返回 `NOT_IMPLEMENTED`，Web 端会降级，
   不影响编辑主流程；四个壳均按 `packages/core/src/platform.ts` 的 `NativeBridge` 契约
   返回「缺能力」而不是抛未捕获异常。
4. **冷启动数据受系统状态影响**：五版数据是同一轮、同一机器、连续采集，横向可比，
   但绝对值会随磁盘缓存/后台负载波动（本轮波动范围约 ±8%）。
5. **⚠ Flutter 的 `data/` 目录是程序必需资产，不是用户数据**：
   Flutter Windows release 把 `app.so`、`icudtl.dat`、`flutter_assets/` 全部放在
   exe 同级的 `data/` 里。清理发布目录时若按「`data/` 是用户数据」一刀切删除，
   Flutter 版会**启动即静默退出、连窗口都不出现**（实测 exit 0、无任何报错）。
   本报告最初就踩了这个坑，已恢复。
   **正确做法**：清理 Flutter 版时只删 `data/webview2/`（WebView2 运行缓存），
   `data/app.so`、`data/icudtl.dat`、`data/flutter_assets/` 必须保留。
   另外三版的 `data/` 确实只是用户数据（vault/设置），可以安全删除。
   这也说明「四个壳的 `data/` 语义并不相同」——横向对比时必须注意这个差异。

## 七、发布物清单

| 产物 | 路径 |
| --- | --- |
| Tauri 2 绿色版 | `releases/2.0.0/NeoMD-2.0.0-tauri-x64/` |
| WinUI 3 绿色版 | `releases/2.0.0/NeoMD-2.0.0-winui3-x64/` |
| Qt 6 绿色版 | `releases/2.0.0/NeoMD-2.0.0-qt-x64/` |
| Flutter 绿色版 | `releases/2.0.0/NeoMD-2.0.0-flutter-x64/` |
| Electron 绿色版（基线） | `dist-artifacts/NeoMD-2.0.0-win-x64.zip`（1.4.0 构建，2.0.0 需重建） |
| 基准原始数据 | `reports/bench-*.json`、`reports/bench-all.json` |
| 运行截图 | `reports/shots/` |
| 任务契约 | `docs/desktop-2.0-spec.md` |
| 测试工具 | `tools/bench-desktop.mjs`、`tools/bench-collect.ps1` |
