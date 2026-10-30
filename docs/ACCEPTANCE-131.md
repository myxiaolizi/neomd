# Neo MD 1.3.1 验收报告

- 验收时间：2026-10-30
- 版本：**1.3.1**（本版为纯缺陷修复版）
- 本地环境：前端 dev `http://127.0.0.1:5178`、API `http://127.0.0.1:3200`（development，连生产库）
- 生产环境：`https://md.zhengl.vip` 已部署 **1.3.1**

> **版本号说明**：任务原定发布为 `1.2.1`。验收过程中发现 1.3.0 已由另一条并行工作流（插件商店 50 款）提交、推送并**在 GitHub 公开发布 Release**（tag `v1.3.0`，时间 2026-10-30T19:10:57Z）。若仍发 `1.2.1`，新版本号会小于已公开版本号，语义化版本倒挂且 Releases 时间线错乱。经用户确认改为 **1.3.1**。

---

## 零、一句话结论

六项用户报障**全部定位到根因并修复**，每一项都有「修复前实测失败 → 修复后实测通过」的数值证据，不是靠调样式或加兜底掩盖。

| # | 用户报障 | 根因层数 | 修复前 → 修复后 |
|---|---|---|---|
| 1 | 编辑器行距过大 | 2 层 | 段间净空白 `3.449em` → `1.949em`；行高比 `1.75` → `1.6` |
| 2 | PC 端设置字体后自动恢复 | **2 层（一层在服务端）** | 3 个字体值里 2 个被打回 → 3/3 保持 |
| 3 | 左右分屏右侧颜色不对 | 2 个独立成因 | 预览栏 `rgba(0,0,0,0)` 透明 → 与主栏同色 |
| 4 | 文件保存后空换行丢失 | 3 层 | 段间/文末/代码块空行全丢 → 字节级保真 |
| 5 | 历史版本只能看到最近一版 | **6 条根因链** | 面板 1 条 → 8 条；右侧栏 2 条 → 7 条 |
| 6 | 设置项重复出现 | 信息架构问题 | 跨页签重复 3 项 → 0 项 |

---

## 一、门禁总览（全部由 Lead 独立复跑确认）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 1.3.1 缺陷门禁 | `node tools/verify-121.mjs` | **45 通过 / 0 失败 / 0 跳过**（A 8 · B 8 · C 9 · D 6 · E 6 · F 6 · P 2） |
| 1.1.9 全量回归 | `node tools/verify-119-full.mjs --skip-build` | **111 通过 / 0 失败 / 1 跳过**（基线 110，B 段因选择器修正 +1） |
| 单元测试 | `npx vitest run` | **236 passed / 0 failed**（9 文件；基线 204，新增 32 + 11） |
| 前端类型 | `vue-tsc --noEmit -p apps/web/tsconfig.json` | **EXIT=0，0 错误** |
| 共享层类型 | `npx tsc -p tsconfig.json` | **EXIT=0，0 错误** |
| 后端语法 | `node --check`（services/api/src 全量 35 文件） | **0 失败** |
| 版本一致性 | `node tools/release-119.mjs check` | **9/9 ✓** |
| 生产健康 | `GET https://md.zhengl.vip/api/health` | `version: "1.3.1"`，`db: true` |

---

## 二、六项缺陷逐条明细

### 缺陷1 · 编辑器行距过大

**根因（2 层）**

1. **不是「两层 `line-height` 相乘」**。实测 `.wysiwyg__host.nm-content` / `.ProseMirror.nm-content` / `p` 三层的 computed `line-height` **均为 `28px`**（16px × 1.75）。CSS 的无单位 `line-height` 是**覆盖**而非相乘，不会出现 1.75² = 3.06。
2. 真实成因是「默认 1.75 偏松」与「`p { margin: 0.85em }`」**同向放大**：28px 行盒里字形只占 20px、上下各 4px half-leading，于是相邻两段**字形间净空白** = 13.6(margin) + 4 + 4 = **21.6px = 1.35em**，比一整行还空。

**修法**

- `packages/core/src/settings/settings.ts`：默认 `lineHeight: 1.75 → 1.6`（**这一处必须改** —— `settings.ts` 会把 `appearance.lineHeight` 内联写到 `<html>` 的 `--content-line-height` 上，只改 CSS 兜底值对真实用户完全无效）；
- `packages/ui/src/styles/content.css`：`line-height` 兜底同步 1.6、`p` margin `0.85em → 0.6em`；
- `WysiwygEditor.vue` / `SourceEditor.vue`：内联兜底同步 1.6。

**实测（Playwright computed style，深浅两主题一致）**

| 指标 | 修复前 | 修复后 |
|---|---|---|
| A1 `line-height / font-size` | 1.75（28px） | **1.6（25.6px）** |
| A2 是否两层叠加 | 否（28 = 16×1.75） | 否（25.6 = 16×1.6） |
| A3a 相邻非空段落净空白 | 21.59px / 1.35em | **15.19px / 0.949em** |
| A3b 段间夹 1 个显式空行 | **55.18px / 3.449em** | **31.19px / 1.949em** |

**档位语义未被破坏**（逐档实测，设置值 = 生效值，无隐式换算）：

| 设置档位 | 1.2 | 1.4 | 1.6 | 1.75 | 1.9 | 2.0 | 2.2 |
|---|---|---|---|---|---|---|---|
| 实测 ratio | 1.2 | 1.4 | 1.6 | 1.75 | 1.9 | 2.0 | 2.2 |
| 默认排版 gapEm | 0.549 | 0.749 | 0.949 | 1.099 | 1.249 | 1.349 | 1.549 |

全档 ≤ 2.0em，用户把行高调到 2.2 时视觉依然合理。

---

### 缺陷2 · PC 端设置字体后自动恢复

**根因（2 层，且两层都与此前版本的推理不同）**

**主因在服务端**，不在客户端：

`services/api/src/routes/settings.js` 的 `flattenSettings()` 用 `Object.assign(view, group)` 把 `platform.<p>.appearance` **整块**盖到 `global.appearance` 上。`appearance` 是**一个整体对象键**，所以不是逐字段覆盖，而是整块替换。

1.1.7 及更早把 `fontFamily` 写在平台分区，这份旧值至今仍在 `platform.web.appearance` / `platform.desktop.appearance`。1.1.8+ 改成写 global 之后，客户端拉到的**拍平视图里 `fontFamily` 永远是平台分区的旧值**，被当作云端权威值覆盖回本地。

实测铁证：

```
global 写入 themePresetId=midnight  →  GET /api/settings?platform=web          返回 daylight   ← 被污染
global 写入 themePresetId=midnight  →  GET /api/settings?platform=__global_only__  返回 midnight   ← 正确
global 写入 fontFamily=KaiTi        →  GET /api/settings?platform=web          返回 system-ui  ← 被污染
```

这解释了「1.1.9 把 `fontFamily` 加进 global 名单但问题仍在」：**改名单位置没错，读侧被服务端拍平逻辑污染了**。

**第二层：触发点与假设不符，focus/轮询链路是死代码**

`installCloudAutoPull()`（`apps/web/src/stores/settings.ts`）是**全仓库唯一**注册 `window.addEventListener('focus')`、`visibilitychange`、60s `setInterval` 轮询的地方。实测：

- 静态：全仓库（仅扫 `apps/*/src`、`packages/*/src`、`services/*/src`）`installCloudAutoPull` **只出现 1 次 —— 就是定义本身，0 次调用**，且**未被 store 导出**，外部根本无法调用；
- 运行时（真实浏览器 hook `window.fetch`）：派发 `focus` + `visibilitychange` 后 4s 内 `/api/settings` 请求 **0 条**；静等 **65s**（覆盖 60s 轮询周期）仍 **0 条**，也没有 `/api/settings/version`。
- 真实触发点是**打开设置页**（`SettingsPage.vue` 的 `requestCloudPull()`）→ 立刻 2 条 GET。

> **教训（已写入 CHANGELOG）**：1.2.0 之前所有基于「focus 拉取 / 60s 轮询」的推理与修复，都建立在一段**从未执行过的代码**上。

**修法**

- 客户端用哨兵平台名 `__global_only__` 读「纯 global 视图」，纠正拍平污染（`applyGlobalAppearanceAuthority()`，**只动 8 个主题类字段**，阅读体验字段仍按端独立）；
- 字段级基线 `neomd.appearanceBaseline.v1` + 字段级「待推送」集合（与 `layout` 同构）—— 关键：推送成功即清空，**不会退化成 1.1.9 那种永久僵住的脏标记**；
- 拉取结束**补发一次推送**：`scheduleCloudPush()` 在 `pullingCloud=true` 时直接 return，而「还原本地字段」恰好发生在拉取过程中，不补发就会变成「本地改动永远推不上去」；
- 写侧把主题类字段镜像进平台分组做自愈（即使服务端不修，两个分区值也一致）。

**实测**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 3 个字体值 × 95s + focus 脉冲 | **2/3 被打回** `system-ui` | **3/3 保持** |
| 跨端改主题能否同步（防「修一个坏一个」） | — | ✓ daylight → midnight 本端已应用 |
| 推送失败（PUT 全 409）后本地改动 | — | ✓ 不被云端旧值覆盖 |
| 解除拦截后能否收敛（防僵住） | — | ✓ 云端收敛为本地值 |

---

### 缺陷3 · 左右分屏右侧编辑器颜色不对

**根因（2 个独立成因）**

1. **对照模式 `.compare__preview` 完全没上纸色**（computed `background-color: rgba(0,0,0,0)`，透出祖先底色），而且 `--content-font-size` / `--content-line-height` **只传给了左侧 `SourceEditor`** —— 用户把正文调到 20px，右栏还是 16px，两栏对照时字号行高都对不上。
2. **左右分屏 `.shell__splitpane` 写死 `background: var(--bg)`**，那是**界面外壳色**（`--chrome-bg`），而左侧透出的是**纸张色** `--bg-elevated`。

实测色值（这是用户看到「颜色不对」的直接来源）：

| 主题 | 左侧主栏（纸张色） | 右侧（外壳色，错） |
|---|---|---|
| 浅色 daylight | `rgb(255,255,255)` | `rgb(242,244,247)` |
| 深色 midnight | `rgb(20,23,28)` | `rgb(27,31,38)` |
| 护眼绿 | `rgb(232,245,233)` | `rgb(217,239,219)` |

此外：全仓**不存在** `--bg-paper` 变量（计算值是空串 `""`），写它不会生效。

**修法**

- `.shell__splitpane` / `.compare__body--preview` 统一改取 `background: var(--content-bg, var(--bg-elevated))` + `color: var(--content-fg, var(--fg))`；
- `CompareView.vue` 新增 `previewVars` 把 `--content-font-size` / `--content-line-height` 绑到预览容器；
- `content.css` 的 `.nm-content { color: var(--fg) }` → `var(--content-fg, var(--fg))`：主题「应用范围」选「仅正文」时只写 `--content-*` 系列、不写 `--fg`，旧写法会让正文自定义字色失效。

**实测**

| 主题 | 左 | 右 | 文字色 |
|---|---|---|---|
| 浅色 daylight | `rgb(255,255,255)` | `rgb(255,255,255)` ✓ | 均 `rgb(31,35,41)` |
| 深色 midnight | `rgb(20,23,28)` | `rgb(20,23,28)` ✓ | 均 `rgb(229,231,235)` |

预览栏字号/行高与主编辑器**严格相等**（17px / 29.75px）。

---

### 缺陷4 · 文件保存后空换行丢失

**根因（3 层）**

用 `npx tsx` 直接调 `packages/core/src/vault/markdown-bridge.ts` 实测：

```
=== two-blank-between ===
IN  : "para one\n\n\npara two\n"
HTML: "<p>para one</p>\n<p>para two</p>\n"      ← 空行信息在这里就没了
BACK: "para one\n\npara two"                    ← 3 个换行变 2 个

=== trailing-3-blank ===
IN  : "para one\n\n\n\n"
BACK: "para one"                                ← 文末 4 个换行变 0 个

=== code-block-blank ===
IN  : "```\na\n\n\nb\n```\n"
BACK: "```\na\n\nb\n```"                        ← 代码块内 3 个空行被压成 1 个
```

1. **`markdown-it` 把连续空行当块分隔符直接丢弃** —— `A\n\n\nB` 与 `A\n\nB` 渲染结果完全相同。空行在**进 HTML 的那一刻**就没了，之后无论怎么往返都无从还原。
2. **`htmlToMarkdown` 的 `if (s) parts.push(s)` 丢弃空段落**，末尾 `.trim()` 又吃掉文末换行（每次保存 git 都报 `\ No newline at end of file`）。
3. **全局 `\n{3,}` 折叠把围栏代码块内部的空行一起吃了** —— 代码块是逐字内容，任何压缩都是**数据损坏**，不是排版。

**修法：把空行做成双向可逆载体**

```
N 个连续空行  ⇄  渲染 (N-1) 个 <p class="nm-blank">  ⇄  回写 2+(N-1) 个换行
校验：N=1 → 2 换行 ✓   N=2 → 3 换行 ✓   N=4 → 5 换行 ✓
```

- 新增 `markBlankRuns()`（**围栏感知**，代码块内部逐字保留、连空行统计都不做）、`isBlankBlock()`、`tidyOutsideFences()`；
- 文末换行改为**按原文件惯例保留**（原文 N 个就保 N 个），不再无条件 trim；
- 顺带修掉两个同源缺陷：`<br>\n` 硬换行被升级成段落分隔；行尾两空格（Markdown 硬换行语法）被 `/[ \t]+$/gm` 静默剪掉；
- 导出链路同步（`exporters.ts` BASE_CSS）：`p{margin:.6em 0}` + `p.nm-blank{margin:0;min-height:1.6em}`。

**实测**

| 项 | 修复前 | 修复后 |
|---|---|---|
| 段间 2 空行 | 丢（3→2 换行） | **3 换行，字节级一致** |
| 文末 3 空行 | 丢（4→0） | **4 换行，字节级一致** |
| 代码块内 2 空行 | 压成 1 | **原样保留** |
| 导出空段落高度 | 28px + 27.2px margin ≈ 55px | **25.59px ≈ 一个行盒（25.6px）** |

---

### 缺陷5 · 历史版本只能看到最近一版

**根因链（6 条，逐条有实测证据）**

| # | 根因 | 证据 |
|---|---|---|
| R1 | `HistoryModal.load()` 的 `if (local.length) { 用 local; return }` —— 本地残留 1 条旧快照，云端 N 条被**整体忽略**；`EditorPage.loadRightHistoryVersions()` 是同一处缺陷的**复制品** | `local=1, cloud=8` → 旧逻辑 **1 条** / 新逻辑 **8 条** |
| R2 | 归档挂在 5 分钟节流 / 300 字阈值上，而自动保存间隔 1.5s —— `shouldVersion` 长期 false，**自动保存路径根本不产生历史**；条件还带 `!keepLocal`，开了本地留痕的用户**永不**上云 | 节流窗口内十几次改动零归档 |
| R3 | `void archiveVersionToCloud(...)` 是 fire-and-forget | 刷新/切仓库时 PUT 被中断，失败只写日志 |
| R4 | 版本 key 唯一性：本地 `<rev>-<hash>-<dev>.md` 纯内容派生 + `if (!exists(key))` 短路 → 同 rev+hash **必然覆盖**；云端 `ts` 用 `Date.now()`，同毫秒两次归档撞 key | 线上取证：两个 ts 不同、内容**完全相同**的同版对象 |
| R5 | 网页端 `listVersions()` **永远返回空**：`BrowserVaultAdapter.listDir()` 由 `listAll()` 派生，而 `listAll()` 过滤掉 `.neomd/**` —— 快照明明写了却列不出来 | `adapter.listAll()` 里 versions 路径数 = **0**，`listVersions()` 返回 1 |
| R6 | 恢复 **100% 失败**：旧 `restoreVersion` 把云端对象键直接交给本地 adapter | `文件不存在: mdadmin/neomd/users/admin/vaults/<vid>/versions/<docId>/<ts>-...md` |

**修法**

- `listVersions()` 改「索引 ∪ 目录」，新增 `.neomd/versions/index.json`（绕开适配器对 `.neomd` 的过滤）；
- 版本 key 改 `<ts>-<rev>-<hash>[-dev].md`，`ts` 走 `max(now, last+1)` 严格递增（两端都改）；去掉 `exists()` 短路；
- 归档与 `shouldVersion` 解耦：本地留痕仍按节流，**云端每版都归档**；`void` → `await`；
- `load()` 改「本地 ∪ 云端合并、按内容身份去重、时间倒序」，两端失败各自降级；
- 新增 `readVersionContent()` 按 key 形态路由（`.neomd/` 前缀走本地，否则走云端）；
- 恢复流程补「恢复前先把当前内容归档」—— 确认框早已承诺，旧实现没做，**误点即永久丢失**。

**实测**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 同一份数据只换算法 | **1 条** | **8 条** |
| 保存 5 次后弹窗 | 1 条 | **6 条，内容 6 种全异** |
| 右侧栏区块（DOM `.verrow`） | 2 条 | **6 行** |
| 回滚到 v2 | 报「文件不存在」 | **正文 / 磁盘文件 / 编辑器标签页三者同时**变回该版 |
| 数据层对象 / UI 行数 | — | 11 个对象 / 6 条 UI（6 个不同 sha256） |

---

### 缺陷6 · 设置里部分选项重复出现

**根因**：主题页签的「⑤ 字体与排版」（字体族 / 正文字号 / 行高 / 缩放）与编辑器页签的「字体、字号与排版」是**同一批控件**，两处都调 `patchAppearance`，用户在两个页签看到同一项、改了互相不知道改的是哪一个。

**修法（信息架构收敛）**

- **主题页签只负责配色**：主题预设 / 配色细化 / 应用范围 / 自定义主题；
- **凡影响排版与编辑行为的一律归「编辑器」页签**：字体、字号、行高、缩放、行号、拼写检查；
- 删掉主题页签的重复整块，并把原先**只存在于**主题页签的「正文缩放」**迁入**编辑器页签（直接删会丢功能）；
- 顺带给「显示正文行号」「拼写检查」两个 toggle 补 `aria-label`（此前只有可视 label，无障碍名为空）。

**实测唯一性**

| 统计项 | 总数 | 去重后 | 重复 |
|---|---|---|---|
| `label`（`.pane .nm-label`） | 54 | 54 | **0** |
| `aria-label` | 40 | 40 | **0** |
| 关键控件（字体/字号/行高/缩放/行号/拼写检查） | 各 1 次 | — | **0** |
| 跨页签重复项 | — | — | **0** |

> `data-testid` 里 `vm-*` 有 16 次重复 —— 那是**仓库列表的模板复用**（16 个仓库各渲染一次），不是设置项，已在断言里显式排除并注释原因。

---

## 三、发布过程中连带修掉的两个「结构性缺陷」

这两项**不在用户报障范围内**，但都会导致「发版必须靠人记得手改」的静默失败，属于同一类隐患，一并根治。

### 1. `services/api/src/routes/download.js` 硬编码 1.1.8 清单

线上实测：APK 已放进 `server/releases/`，但 `/api/download/NeoMD-1.3.1.apk` 返回 **404**。根因是 `DOWNLOAD_FILES` 硬编码 1.1.8 文件名，而下载入口**用清单做白名单**（找不到就 404）—— 磁盘上真有也永远下不到。

**这正是 1.2.0 发布时 APK 缺失的真正原因**（当时的发布日志记的是「缺少 1 个必需产物：NeoMD-1.2.0.apk」，其实文件在，只是清单没登记）。

修法：清单从 `services/api/package.json` 的 `version` 推导；同时把磁盘上的历史 APK 动态登记为「仅放行白名单」的条目，让旧链接继续可用，又不污染下载页卡片。

### 2. `tools/publish-releases.mjs` 硬编码 1.1.8 产物名

同一隐患。改为从根 `package.json` 推导。

### 3. `apps/android/build.mjs` 硬编码 `NeoMD-1.2.0.apk`

`release-119.mjs check` 在 1.3.1 收口时**真的拦到了**这一条（9 项里 1 项不一致）。改为动态推导后，Android 端与桌面端（1.2.0 已改）行为一致。

> 这三处的共同教训：**版本号必须只有一个事实源**。任何在代码里重复写死版本号的地方，都会在某次发版时静默失效，而构建日志全绿、只有用户点下载才发现。

---

## 四、仓库脏数据清理

**`apps/web/src/stores/settings.ts` 的中文注释在 1.2.0 已发布版本里就是 GBK 乱码。**

- 逐字节审计：`git show HEAD:apps/web/src/stores/settings.ts` 第一个非 ASCII 在 byte 526，按 UTF-8 解码得到 `缁?settings 琛ラ綈鏈嶅姟绔厤缃粯璁ゅ€笺€?`；
- 全仓扫描（42 个改动文件 + 全部 git 跟踪文件）：**只有这 1 个文件**有该问题（629 处）；
- 影响面：**98 行真乱码 + 14 行「注释原文编码损坏，已清理」占位符，全部在注释里**，不影响运行时（所以 `vue-tsc` 与 `vitest` 一直全绿），但这是可维护性地雷，且说明 1.2.0 发布时带了脏数据上线；
- 第 1 处「非注释行」实为块注释续行（L724，以 `*/` 结尾），**没有任何用户可见文案被破坏**；
- 本版按语义还原 **112 行**，保留全部「为什么」解释；附两个可复跑校验：`re121-verify-mojibake.mjs`（残留 0）、`re121-verify-lexical.mjs`（逐字符状态机确认块注释闭合）。

**根因**：历史上用 PowerShell `Set-Content -Encoding UTF8` 写 UTF-8 无 BOM 文件 —— PowerShell 5.1 会把它按 GBK 读入再写回，多字节中文与全角标点被吞。本仓库 `PROJECT_CONTEXT.md` 第七节第 5 条早已记载该陷阱，本次再次印证（两个修复组成员在同一天各自踩了一次：一个把 `SourceEditor.vue` 写坏后整份重写，一个把 `tools/verify-121.mjs` 写成 1791 处乱码导致 `SyntaxError`）。

**已落地的硬约束**：编辑含中文的源文件一律用 `write` / `edit` 工具，禁用 PowerShell 重定向与 `Set-Content`；QA 门禁脚本重写为**模块化 10 个文件**（单文件最大 34KB），每个写完立刻 `node --check`。

---

## 五、门禁修正（不是放宽断言，是修正过时选择器）

`tools/verify-119-full.mjs` 的 B 段在 1.3.1 上**整段中断**（92 通过 vs 基线 110），根因是它硬依赖「字体/字号/行高控件在**主题**页签」且用旧 `aria-label`（`正文字号` / `正文行高`）。而缺陷6 的修复**正是**把这些控件收敛到编辑器页签（并补了「编辑器」前缀）—— 两个需求直接冲突。

**处理方式**：修 B 段选择器，而不是加白名单绕过。

- 新增 `openSettingsForTypography()`：**按控件是否存在**选页签（先试「编辑器」，找不到回落到「主题」），使同一份门禁可同时跑在收敛前后两个版本上；
- 新增 `fillByAnyLabel()`：按多个候选 `aria-label` 定位输入框（`编辑器正文字号` / `正文字号`）。

**结果**：B 段由「整段中断」恢复为 **19/19 全通过**（比 1.2.0 基线的 18 条还多 1 条），全量 **111 通过 / 0 失败 / 1 跳过**。

> 反过来说：如果用白名单把 B 段放过，就等于把「B1~B16 到底还成不成立」永久失去验证能力 —— 而 1.1.9 的报告里恰好记着一条教训：「断言为 ✓ 但 note 描述着缺陷，是门禁全绿但仍有用户可见问题的典型形态」。

---

## 六、生产部署与线上验证

部署路径：`/www/wwwroot/md.zhengl.vip`，宝塔 Node 项目 `neomd`，监听 `127.0.0.1:3200`。

**备份**：`/www/backup/neomd-131-20261030-222943/`（`.env.bak` / `package.json.bak` / `public.bak/` / `server-src.tar.gz` / `releases.bak/`）

| 验证项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `/api/health` 版本 | 1.3.1 | `version: "1.3.1"`，`db: true` | ✅ |
| `.env` 完好 | SHA256 前后一致 | `4fe1cfda...b0cb3c9` 前后完全一致 | ✅ |
| `server/releases/` 完好 | 保留历史 APK | 10 个历史 APK + 新增 1.3.1 | ✅ |
| 全部 JS 语法 | 0 失败 | 35 个文件全通过 | ✅ |
| 依赖完整性 | 无缺失 | `missing deps: (none)` | ✅ |
| 前端资源引用 | 无 404 | 3 个 asset 全部存在 | ✅ |
| 首页 / 应用页 | 200 | 200 / 200 | ✅ |
| **下载清单** | 三项均为 1.3.1 | zip / exe / apk 全部 1.3.1 | ✅ |
| **APK 直下** | 200 + 正确字节数 | `200`，`4363947` bytes（与本地 SHA256 一致） | ✅ |
| **历史 APK 仍可下** | 200 | `NeoMD-1.1.8.apk` → `200`，`4338972` bytes | ✅ |
| Windows 安装包 | 302 到 OSS | `302` + 预签名 URL | ✅ |
| 生产库连接 | `db: true` | 是 | ✅ |

**部署过程中的一段真实故障（如实记录）**：第一次部署后 APK 仍 404。排查发现 `download.js` 硬编码清单（见第三节），本地改完后**重新打包时 `Copy-Item` 把 `src` 目录嵌套进了已有的 `src`**（`server/src/src/...`），导致上传的是**未含修复的包**。发现方式是部署后执行 `grep -c 'APP_VERSION' server/src/routes/download.js` 得到 `0`（期望 5）。修正打包方式后二次部署才生效。

> 教训：**部署后必须验证「产物里真的有这次修复」**，不能只看「命令成功 + health 版本对」。版本号对只证明 `package.json` 到了位，不证明业务代码到了位。

---

## 七、未覆盖项与已知遗留（如实列出，不以全绿掩盖）

### 7.1 门禁未覆盖

1. **PC 端原生文件系统适配器未覆盖**：D（空行保真）与 E（历史版本）两段用的是 Web 端 IndexedDB 适配器（`neomd-vault:cloud:admin`）。若空行丢失只在桌面端 `NativeVaultAdapter` 上复现，本门禁抓不到。
2. **C 段只覆盖「409 版本冲突」一种推送失败**：断网 / 私有化拦截 / 服务端 500 未单独实测，理论上走同一条 `pullCloudSettings` 保护路径，但**未验证**。
3. **云端历史版本无数量上限**：去重后每版一个对象，长期使用单文档可达上千个。`pruneRemoteVersions` 存在但**全仓无任何调用点**（grep 确认）。
4. **`@neomd/core/dist/` 是坏的**：`tsc` 产物是省略扩展名的 ESM + 空 `index.js`，Node 直接 import 会 `ERR_MODULE_NOT_FOUND`。当前构建链路不依赖它（Vite 直读源码），但 CI 若跑 `pnpm build:core` 后消费产物会踩。
5. **`SettingsModal.vue` 是死代码**：全仓无任何 `import`，不影响运行时，可后续删除。
6. **导出侧相邻 margin 未与编辑器完全对齐**：编辑器靠 `:has()` 把空段落两侧段落 margin 清零，导出 `BASE_CSS` 只清了空段落自身 → 导出里一个显式空行段间距 44.78px，编辑器 31.19px。纯视觉，不影响数据。
7. **`p:has(> br.ProseMirror-trailingBreak)` 依赖 TipTap 内部类名**：升级后若改名，空段落 margin 归零会失效（视觉变松，数据不受影响）；`p:empty` / `p.nm-blank` 两条兜底仍在。
8. **Android APK 未做真机安装验证**：只验证了构建成功（`BUILD SUCCESSFUL`）与产物字节数/SHA256，未在真机或模拟器上安装启动。

### 7.2 测试方法的已知局限

9. **本机无头 Chrome 不稳**：实测默认参数（`--headless=new --no-sandbox --disable-dev-shm-usage`）约 30s 崩（空白页也崩，heap 仅 10MB，非内存不足）；加 `--disable-gpu` 后稳定，`--headless=old` 也稳定。这对 C 段（每个字体值需静等 95s）是**危险假信号** —— 崩溃会看起来像「字体回归失败」。已改用 `launchPersistentContext` + 分段可恢复等待（`waitResilient`，每 15s 检查存活，崩了重启浏览器再回 `/app`，**总等待时长不缩水**）。
10. **生产库存在并发写入**：多个修复组的脚本同时登 `admin`、同时改 `settings`，中途观察到 `global.appearance.pageWidth/zoom` 从基线 `wide`/`150` 变成 `full`/`70`。已用 `tools/re121-restore-original.mjs` 归零到基线并逐字段校验（`version 293`）。**这是流程缺陷**：应给测试单独建账号，或明确「同一时刻只允许一个任务跑 settings 写入」。
11. **`tools/verify-121.mjs` 曾被编码损坏**：第一版用 `pwsh -replace` + `Set-Content` 写成 GBK 乱码（1791 处），`node` 直接 `SyntaxError`。已按硬约束用 `write` 工具模块化重写。

---

## 八、复现命令

```powershell
cd C:\Data\BAC\neomd\neomd-V1

# 1.3.1 六项缺陷门禁（约 3 分钟）
node tools/verify-121.mjs

# 带负向对照（注入修复前样式，验证断言非恒真）
node tools/verify-121.mjs --negative-control --shots --json=docs/evidence-121/verify-121-full.json

# 1.1.9 全量回归（约 10 分钟）
node tools/verify-119-full.mjs --skip-build

# 单元测试 / 类型检查
npx vitest run
pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json
npx tsc -p tsconfig.json

# 版本一致性
node tools/release-119.mjs check

# 各修复组的独立取证脚本
node tools/re121-blankline.mjs          # 空行保真（20/20）
node tools/re121-settings-font-repro.mjs # 字体不被恢复（12/12）
node tools/re121-settings-uniqueness.mjs # 设置项唯一性（18/18）
node tools/re121-evidence-autopull.mjs   # focus/轮询死代码证据（8/8）
node tools/re121-history.mjs             # 历史版本（probe / e2e / cleanup）
node tools/re121-right-dom.mjs           # 右侧栏历史版本 DOM 级取证
```

> **限流提醒**：登录 10 次/分钟、`/api/vaults` 写 20 次/分钟。连续重跑建议间隔 60 秒。
>
> **deviceId**：门禁脚本固定使用常量（`qa-verify-121`），避免每跑一次在云端堆积 `index/<deviceId>.json`。

---

## 九、结论

**1.3.1 可发布，且已发布到生产。**

- 六项用户报障全部定位到根因并修复，每项都有修复前后的实测数值对比；
- 其中缺陷2 的主因在**服务端**（`flattenSettings` 整块覆盖），并发现 `installCloudAutoPull` 是**从未被调用的死代码** —— 这解释了为什么 1.2.0 之前的同类修复都没真正生效；
- 缺陷5 是**6 条根因叠加**，只修其中一条（例如只改 `HistoryModal` 的合并逻辑）不会有明显效果；
- 连带根治 3 处「版本号硬编码」的结构性隐患，其中 `download.js` 的硬编码正是 1.2.0 发布时 APK 缺失的真正原因；
- 清理了 1.2.0 已发布版本里的 112 行 GBK 乱码注释（全部在注释内，不影响运行时，但是可维护性地雷）；
- 门禁：`verify-121` 45/45、`verify-119-full` 111 通过 / 0 失败、`vitest` 236/236、三道类型检查全 0 错误；
- 生产已部署 1.3.1 并逐项验证，含 APK 与历史 APK 的**真实下载**（不只是 302 可达）；
- 本报告第七节**如实列出 11 项未覆盖或存疑之处**，不以「全绿」掩盖它们。
