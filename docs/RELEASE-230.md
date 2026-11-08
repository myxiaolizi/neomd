# Neo MD 2.3.0 五端桌面版交付说明

> 版本：2.3.0　构建：Windows x64　形态：绿色版（解压即用）
> 测试账号：`admin / ***`（凭据已脱敏）

---

## 一、交付物

五套绿色版压缩包，解压到任意目录双击 exe 即可运行，无需安装、不写系统注册表、用户数据留在解压目录的 `data/` 下。

| 桌面壳 | 压缩包 | 大小 | 启动文件 | 技术栈 |
|---|---|---|---|---|
| Tauri | `NeoMD-2.3.0-tauri-x64.zip` | 3.7 MB | `NeoMD.exe` | Rust + wry（系统 WebView2） |
| Flutter | `NeoMD-2.3.0-flutter-x64.zip` | 12.1 MB | `neomd_flutter.exe` | Flutter 3.38 + WebView |
| WinUI3 | `NeoMD-2.3.0-winui3-x64.zip` | 66.8 MB | `NeoMD.WinUI3.exe` | .NET 9 + WebView2 |
| Electron | `NeoMD-2.3.0-electron-x64.zip` | 153.3 MB | `Neo MD.exe` | Electron（含 `portable.txt`） |
| Qt | `NeoMD-2.3.0-qt-x64.zip` | 209.6 MB | `NeoMD.exe` | PySide6 6.12 + QtWebEngine |

体积差异全部来自运行时打包方式：Tauri 复用系统 WebView2 所以只有 3.7 MB；Qt/Electron 自带完整 Chromium 内核所以上百 MB。功能完全一致。

**Qt 版注意**：部分机器上需要以 `NeoMD.exe --no-sandbox` 启动（QtWebEngine 在受限账户下的已知限制）。

---

## 二、统一架构

五个壳不各自维护一份前端，而是在壳内启动一个本地 HTTP 服务托管同一份 `apps/web/dist`：

```
桌面壳进程
 ├─ 本地 HTTP 服务（127.0.0.1:<随机端口>）
 │   ├─ /                    → 托管 web/dist，注入 window.NeoMD
 │   ├─ /api/*               → 同源反向代理到 md.zhengl.vip
 │   └─ /__bridge/<method>   → 交给原生层执行（文件、窗口、版本等）
 └─ WebView 指向 http://127.0.0.1:<port>/
```

这样做的三个好处：
1. **同源**：`/api/*` 与页面同源，没有跨域，也不需要给每个壳单独配 CORS；
2. **一份前端**：`sync-webdist.ps1` 把同一份 dist 部署到五个壳，不存在版本漂移；
3. **桥接统一**：原生能力只经 `/__bridge/`，五个壳的接口契约相同。

**Electron 是唯一例外**：它用原生 `BrowserWindow` + `neomd://neomd/app` 自定义协议，不启本地 HTTP 服务，因此它的验收走独立的 `tools/electron-accept.mjs`（21 项）。

启动后壳会把实际地址写进 `data/boot.json` 的 `url` 字段 —— 端口被占用时会自动顺延，所以自动化脚本必须读这个文件而不是假定端口。

---

## 三、验证结果

### 3.1 自动化验收

| 桌面壳 | 项数 | 结果 |
|---|---|---|
| Tauri | 24 | **24/24** |
| Qt | 24 | **24/24** |
| Flutter | 24 | **24/24** |
| WinUI3 | 24 | **24/24** |
| Electron | 21 | **21/21** |
| **合计** | **117** | **117/117** |

24 项覆盖：启动存活、页面非空白、登录、登录态持久化、云同步、打开文档、编辑保存、历史版本增长、快捷键（8 个）、设置（草稿+保存两段式）、管理后台往返（标签不增不减）、控制台干净、窄窗响应式（500–900px 整页不横向滚动）、设置入参防护等。

### 3.2 多模型交叉验证

每个壳由 **≥3 个不同 AI 模型**独立实测，共 **17 份报告**。详细对比见 `reports/model-verify/220/COMPARISON.md`。

关键结论：模型自述的缺陷必须复核 —— 17 份报告共上报缺陷 14 条，**经复核只有 4 条是真实产品缺陷**（且归并为 2 个根因），其余是设计行为、环境干扰或测法错误。

### 3.3 绿色版语义校验

`verify-zip-210.mjs all 2.3.0` —— **5/5 PASS**：每个包里 `window.NeoMD` 注入正常、版本号显示 2.3.0、登录成功、解压后用户数据确实写在本目录。

---

## 四、本轮修复

详细记录见 `reports/model-verify/220/FIXES.md`，共 5 项：

| # | 缺陷 | 影响 | 根因 |
|---|---|---|---|
| 1 | 窄窗底部状态栏溢出，整页横向滚动 | 700px 左右窗口下缩放/字数控件被裁到点不到 | `.statusbar__right` 缺 `flex-shrink`，`.statusbar__left` 又 `flex:1` 抢占空间 |
| 2 | 管理后台往返标签页重复累积 | 3 个标签往返 3 次变 9 个 | `restoreTabs()` 绕过了 `openDoc()` 的 docId 去重 |
| 3 | 设置 action 无入参校验 | 误传字符串会展开成字符下标污染 localStorage | `updateAppearance` / `updateLayout` 直接展开入参 |
| 4 | 429 限流被当成硬失败且无自动恢复 | 限流时同步中断 → 历史版本归档不上（用户视角"保存了但历史里没有"） | `explainSyncError` 无 429 分支；catch 里一律置 `error` |
| 5 | 标签恢复时索引未就绪会静默丢标签 | 新建文档后立刻去管理后台再回来，标签可能消失 | 索引查不到就 `continue`，把"索引未刷新"和"文档已删"混为一谈 |

第 1、2 项各由 4 个壳/模型独立复现，是确凿的产品缺陷；第 4 项是我从 winui3 连续两次验收失败中挖出来的，排查过程中还发现原提示「对象存储配置不完整」具有误导性（已登录用户根本不会走自建 S3）。

---

## 五、已知限制（非缺陷，如实说明）

1. **历史版本首次为空**：保存归档的是「保存前旧内容」，且落盘有延迟。新建空文档保存后立刻查可能读到 0 条，再过一会儿就有了。判据应为「再保存一次，版本数必须增加」。
2. **设置是两段式**：改完 store 不变是**正确**的（草稿态），必须点保存栏的「保存」才落库。多份报告把这当成"设置失效"，属误判。
3. **窄窗部分元素越界**：被 `overflow:hidden` 有意裁剪（文字省略、装饰块），只要整页不横向滚动、可交互控件点得到，就不算缺陷。
4. **云端 429**：共享账号多端并发同步时容易触发限流。现在会自动退避重试 3 次并明确提示，改动不会丢。
5. **Qt 需 `--no-sandbox`**：少数机器上 QtWebEngine 在受限账户下需要该参数。

---

## 六、源码与构建

```
apps/
  web/                 Vue 3 + Vite + Pinia（五个壳共用的唯一前端）
  desktop/             Electron 壳
  desktop-tauri/       Tauri 壳（Rust）
  desktop-qt/          Qt 壳（PySide6）
  desktop-winui3/      WinUI3 壳（.NET 9）
  desktop-flutter/     Flutter 壳
packages/{core,shared,ui}
services/api/          Fastify 后端
tools/                 构建、验收、探针脚本
```

重建命令：

```powershell
node tools/bump-version.mjs 2.3.0                              # 统一五个壳的版本号
powershell -File tools/build-all.ps1 2.3.0                     # 构建五壳到 releases\2.3.0
node tools/package-release.mjs 2.3.0                           # 打绿色版 zip
node tools/verify-zip-210.mjs all 2.3.0                        # 校验绿色版语义
node tools/shell-ui-accept.mjs --shell tauri --release 2.3.0   # 单壳 24 项验收
node tools/electron-accept.mjs 2.3.0                           # Electron 21 项验收
```

---

## 七、本轮顺带修掉的构建隐患

**版本号会覆盖历史发布目录。** `apps/desktop-qt/build.py` 的版本默认值原为硬编码 `2.2.0`，而构建脚本没有传 `NEOMD_VERSION`，于是构建 2.3.0 时 `main()` 里那句 `rmtree(RELEASE_ROOT)` 把 `releases\2.2.0\NeoMD-2.2.0-qt-x64` **整个删掉并用 2.3.0 产物覆盖** —— 历史发布被污染，回滚路径失效。

修法：① `build.py` 改为从环境变量取，未设置时读根 `package.json`；② `build-all.ps1` 显式传 `NEOMD_VERSION`。2.2.0 的 Qt 目录已从当时的 zip 恢复，时间戳印证未被再次触碰。

同类问题还有 Electron：`build.mjs` 的产物落在 `dist-artifacts/` 而非 `releases/`，导致五壳目录结构不一致。已在构建脚本里补上归位步骤。
