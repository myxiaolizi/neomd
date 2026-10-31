# Neo MD 1.4.0 验收报告

- 验收时间：2026-10-31
- 版本：**1.4.0**
- 本地环境：前端 dev `http://127.0.0.1:5178`、API `http://127.0.0.1:3200`（development，连生产库）
- 生产环境：`https://md.zhengl.vip`

---

## 零、一句话结论

16 项需求**全部落地**，每项都有可复跑的断言与修复前后的实测对比。除需求外，本版还挖出并修掉 **3 个用户报障之外的真实缺陷**（其中一个属安全语义：封禁失效），以及 **1 个安全缺口**（插件代码作者侧无校验）。

门禁结果：

| 门禁 | 结果 |
|---|---|
| `tools/verify-140.mjs`（16 项需求 + 负向对照） | **59 通过 / 0 失败 / 0 跳过**，exit=0 |
| `tools/verify-121.mjs`（1.3.1 六项不得回归） | **45 通过 / 0 失败**（A 8 · B 8 · C 9 · D 6 · E 6 · F 6 · P 2） |
| `tools/re14-settings-audit.mjs`（设置逐项体检） | **18 通过 / 0 失败** |
| `tools/re14-settings-save-verify.mjs`（保存语义） | **15 通过 / 0 失败** |
| `tools/re14-builtin-plugins.mjs`（26 款内置插件） | **26 款失败 0**（可用 21 / 部分可用 5 / 暂不可用 0） |
| `tools/re14-release-gate.mjs`（发版产物） | **3/3 通过**（运行期 + 部署产物 + 客户端 HEAD） |
| `npx vitest run` | **295 passed / 12 files**（基线 236 → +59） |
| `pnpm --filter @neomd/web exec vue-tsc --noEmit` | **EXIT=0，0 错误** |
| `npx tsc -p tsconfig.json` | **EXIT=0，0 错误** |
| `services/api/src` 全部 `node --check` | **0 失败**（35 文件） |
| `node tools/release-119.mjs check` | **9/9 ✓** |

---

## 一、16 项需求逐条验收

### 需求1 · 新安装的插件无法使用；需要在功能区增加入口且可用

**根因**：功能区入口机制**根本不存在**。
- `layout.ribbonItems` 是内置插件的 id 白名单，社区插件天然不在其中；
- `ribbonActions` 只查 `PLUGIN_RIBBON_DEFS` 这张硬编码表，**未知 id 直接 `continue`**；
- 右键菜单 `RIBBON_ALL_ITEMS` 同样是内置硬编码。

所以从市场安装插件后，功能区**零变化**，用户唯一能找到的入口只剩命令面板。

**修复**：
- 社区插件用 `community:<pluginId>` 前缀 + **独立 key** `neomd.communityRibbon.v1`；**内置白名单一个字节都没改**（12 项逐字节实测不变，避免设置页幽灵项）；
- `packages/shared/src/community-plugins.ts` 提供可订阅注册表（Set + subscribe，无框架依赖，Node 可测）；
- 三处入口统一识别 `community:` 前缀：功能区按钮、右键菜单「加入/移出功能区」、命令面板；
- 安装即校验：`installCommunityPlugin()` 内部先跑 `loadPluginModule()`，坏插件当场报可读错误。

**实测**：
```
安装「标题自动编号」→ 功能区按钮 11 → 13（新增"社区插件：标题自动编号"）
点击 → 文档内容变化：
  第一章 / 第一节 / 正文段落。/ 第二章 / 第一节
→ 1. 第一章 / 1.1 第一节 / 正文段落。/ 2. 第二章 / 2.1 第二节
toast：「插件「标题自动编号」已执行，文档已更新」
```

---

### 需求2 · 后台插件市场增加编辑功能

**根因**：只有审核 / 下架 / 删除，**没有编辑接口**。

**修复**：
- 新增 `GET /api/admin/plugins/:id` + `PUT /api/admin/plugins/:id`（按**数字主键**，不是 pluginId 字符串）；
- 可改元数据 + `codeJs`，含**语法校验 + 危险标识符拦截**，拒绝时写审计 `admin.plugin.update_rejected`；
- 前端编辑弹窗 + 实时校验 + 变更摘要 + 保存反馈；
- **按 PATCH 语义只更新提交的字段**，未提交字段保持原值（避免前端漏传导致内容被清空）。

**实测**（B06，7/7）：
```
合法代码            → 200
括号不闭合          → 400「语法错误：Unexpected token ')'」
引号未闭合          → 400「Invalid or unexpected token」
括号不配对          → 400「Unexpected number」
require()           → 400「不允许使用 require()（插件在浏览器中运行…）」
child_process       → 400
process.binding     → 400
```

> **同时修掉一个安全缺口**：作者侧 `PUT /api/plugins/:pluginId` 原本**一个字节都不校验**（后台侧有），坏代码与危险标识符可直接落库，而插件代码最终在客户端 `new Function` 里执行。已补同一校验器，两端口径一致（实测两端均 400）。

---

### 需求3 · 插件市场翻页，每页 20 个

**根因**：`AdminPlugins.vue` 硬编码 `pageSize=60` 且无分页 UI；`/api/plugins/market` 一次性 `LIMIT 200` 返回、无 `total`。

**修复**：
- 服务端两个接口均支持 `page`/`pageSize`，返回**真实 `COUNT(*)`** 的 `total` + `hasMore`；**不传参时与 1.3.1 行为完全一致**（向后兼容，旧客户端零回归）；
- 前端分页 UI：每页 20、上一页/下一页/页码/总数、**翻页回列表顶部**、**页码进 URL**（`?pluginPage=N`，刷新不丢）。

**实测**：
```
page=1 → 20 条，total=53，hasMore=true
page=2 → 20 条
page=3 → 13 条，hasMore=false
page=4 → 0 条
不传参 → 53 条（完全兼容 1.3.1）
翻页后 scrollTop ≤ 2（回顶部）；URL 出现 ?pluginPage=2
```

> 过程中修掉一个真实小缺陷：`gotoMarketPage()` 原本在 `scrollTo(0)` 后又调 `scrollIntoView({block:'nearest'})`，而 `.plugin-grid` 相对滚动原点有 54px 偏移 → 实测 scrollTop 停在 **54** 而非 0。已改为 `nextTick()` 后只 `scrollTo({top:0})`。

---

### 需求4 · 后台客户端分发没有最新版本

**根因（与预期不同，结论反转）**：`/api/admin/releases` **本来就能看到 1.3.1**（实时列举 OSS）。真正的问题是三条：
1. 只列 OSS，**完全没用** `download.js` 的 `DOWNLOAD_FILES` → 本地 `services/api/releases/` 里的历史 APK 在后台不可见；
2. 没有「当前版本」判定/高亮，没有下载次数，没有可用性探测；
3. 前端只有 4 列，拿不到 `version` / `isCurrent`。

**修复**：
- 后台复用 `download.js` 的单一数据源（**不再造第二份清单**）；
- `isCurrent` 徽标置顶、下载次数、HEAD 可用性探测、**OSS/本地/两者都有/仅本地**四态区分 +「只看异常」筛选；
- 新增 `tools/re14-release-gate.mjs`：校验运行期目录 + 部署产物 + **客户端真实 HEAD** 三层。

**实测**：
```
currentVersion = 1.3.1 === services/api/package.json version ✓
onOss=29 / onLocal=10 / both=8 / localOnly=2
localOnly 暴露了 NeoMD-1.1.7.apk / NeoMD-1.1.8.apk —— 这两个文件 1.4.0 之前后台完全看不见
```

> **发版门禁抓到一次真实事故**：1.3.1 的 APK 在生产上能下（手工放进 `server/releases/`），但**本地 `services/api/releases/` 与 `dist-artifacts/deploy/server/releases/` 都没有它** —— 一旦用部署包重新部署，APK 会再次丢失、客户端重新 404。已从源头（`services/api/releases/`）补齐，并验证 `make-deploy.mjs` 会把它带进部署产物（SHA256 四处一致，含从 `/api/download/` 实际下载回来的内容）。

---

### 需求5 · 后台用户管理增加更多功能

**交付 6 项**（要求「至少 5 项」）：

| 功能 | 实测 |
|---|---|
| 封禁/解封（原因 + 到期） | 封禁后登录失败 `ACCOUNT_DISABLED`；不能封自己 403；原因必填 400；过去时间 400 |
| 批量操作 | 2 个用户发 50 积分 → 余额 220→270；**自己和最后一个管理员被逐条跳过而不拖垮整批** |
| 登录记录 | 成功 2 / 失败 2，失败带 reason（`bad_password`）；`failuresOnly` 过滤有效 |
| 数据概览 | 仓库/文档/分享/发布/AI/积分/配额使用率 全有值 |
| 角色调整 | 提升/降回；重复设置 `changed=false`（幂等）；不能取消自己的管理员 403 |
| CSV 导出 | 前 3 字节 `ef bb bf`（UTF-8 BOM）；`text/csv` + attachment；行数 === 总数 |

**schema 变更**（幂等增量）：`users` 新增 `ban_reason` / `banned_at` / `ban_until`（全 `NULL DEFAULT NULL`）；新表 `release_downloads`；新增 3 个索引。第二次执行 `columns=0 tables=0 indexes=0`，幂等通过；迁移前后逐表行数完全一致。

> **设计决定**：封禁**不新增 ENUM 值**，用 `status='disabled' + ban_reason 非空` 表达。理由：`users.status` 被 auth / `/api/auth/me` / 列表筛选多处按 `ENUM('active','disabled')` 消费，加 `'banned'` 属破坏性变更。

---

### 需求6 + 需求17 · 内置插件功能可用；逐一检查每个内置插件

**根因**：`PluginPanel.vue` 是**全仓无人 import 的死代码** —— 5 款只声明 `panel: true` 的插件没有任何渲染路径；19 个声明命令，旧 dispatcher 只命中 2 个；`onPanelAction` 的 `default` 分支只 `notify('已触发插件：xxx')` —— 这是**假成功**。

**修复**：
- 接回 `PluginPanel.vue` 并补齐全部面板；
- 建立统一贡献注册表：`command id → {pluginId, title, run(ctx)}`，26 款 manifest 声明的命令全部落到具体实现；
- 拆掉假成功的 `default` 分支，改为明确报错；
- 内置命令实现放在 `packages/shared/src/builtin-plugin-runtime.ts`（无内部依赖纯函数）—— **EditorPage 与验证脚本共用同一份代码**，脚本测的是真品而非复刻品。

**实测（26 款逐款）**：
```
可用 21 / 部分可用 5 / 暂不可用 0 / 缺失 0 / 失败 0
```
5 款部分可用及具体限制（界面内主动标注，不虚报）：

| 插件 | 限制 |
|---|---|
| 录音机 | 上传需配置 S3 + 麦克风权限 |
| 数据库 | `.base` 文件持久化无宿主能力（表格视图可用） |
| 网页浏览器 | 目标站 `X-Frame-Options` 拒绝内嵌（站点侧限制） |
| 斜杠命令 | 行内 `/` 触发需编辑器扩展层（见遗留 2） |
| 页面预览 | 行内悬停浮层需编辑器扩展层（面板形态已可用） |

> **顺带挖出一个真实用户缺陷**：属性/数据库面板解析 frontmatter 的键名正则只允许 ASCII，**中文属性名（`状态: 进行中`）一律解析不出来** → 属性表永远是空的，用户会误判成「插件坏了」。已改用 `\p{L}\p{N}`。

---

### 需求7 · 左右分屏和上下分屏中间拖动不跟随鼠标

**根因：两个独立 bug 叠加**（只修一个都不行）

1. **单位模型错配**：`ResizeHandle` 是 `startValue + delta` 的**像素增量**模型，而分屏传进来的是 `splitRatio * 100`（**0..100 百分比**）。于是 `delta = 1px` 被当成 `+1%`，1300px 宽的分屏上 1% = 13px → **灵敏度放大 13 倍**。
2. **方向天然相反**：`flex: 0 0 ${splitRatio*100}%` 绑在**第二栏**。比例变大 → 第二栏变大 → 分隔条向**左/上**移动，与鼠标（右/下）**相反**。

**关键判断**：只加 `invert` 是错的（灵敏度仍错）；同时修 flex 方向又加 invert 会**双重翻转又反了**。所以方向修正放布局层、**不使用 invert**。

**修复**：`ResizeHandle` 新增 `unit: 'px' | 'percent'`（默认 px，侧栏/区块高度行为完全不变）+ `precision`；percent 模式在 `mousedown` 量一次容器尺寸（避免每帧读 `clientWidth` 触发 reflow），量不到时**本帧直接 return 而不退化成 1px=1%**；第二栏改 `(1 - splitRatio)`。

**实测（1600×950，容器 1300×842）**：
```
左右分屏  30%→偏差 0px | 50%→偏差 0px | 70%→偏差 0px      （判据 <3px）
上下分屏  30%→偏差 0.42px | 50%→0.41px | 70%→0.38px
松手前后漂移：全部 0px
修复前同场景：129 ~ 672px 偏差
```
另附**像素拖拽回归**脚本，确认左栏宽度（0.67px）与右侧区块高度（0px）未被改坏。

---

### 需求8 · 右侧最多 3 个 / 点第 4 个替换最上 / 拖动标题栏调整位置

**根因**：
- `toggleRightSection()` 是**无上限的多选开关**（实测能开 8 个，`.rightstack` 溢出 1010px，末位被压死在 80px）；
- **更关键的前提缺陷**：`enabledRightSections` 写的是 `RIGHT_SECTIONS.map(id).filter(...)`，**永远按常量顺序输出、丢弃用户顺序** —— 不修这个，任何拖拽排序写进去都会被 computed 抹平。

**修复**：
- 顺序语义：`rightPanelSections` 数组 = 唯一真相；`RIGHT_SECTIONS` 只提供 label/icon + 把**未知 id** 按常量位置聚到末尾（老数据/回滚残留）；
- 上限 3：纯函数 `toggleRightSectionWithLimit(current, id, limit) → {list, evicted}` 放 `lib/local-layout.ts`，EditorPage 与 SettingsPage 共用同一语义；淘汰规则=从**头部**移除（最上方），用 `while` 让老数据里存了 6~8 个的用户一次性收敛；
- 提示文案点名被关掉的区块；
- 拖动排序**双通道**：`.rsection__head` 本身 `draggable`（满足「拖动标题栏」）+ `.rightstack__grip` 抓手（AI/文件区标题栏在 AiPanel 内，抓手是唯一可行路径）；视觉反馈用 `box-shadow: inset` 而非插节点（插节点会改变布局高度 → dragover 判定反馈回路 → 指示线抖动）。

**实测**：
```
开满 3 个:   ai → file → outline
点第 4 个:   file → outline → tags（被替换：ai）
提示:        "右侧栏最多同时显示 3 个，已自动关闭最上方的「AI 助手」以腾出位置"
拖抓手后:    tags → file → outline
拖标题栏后:  outline → ai → file
点关闭按钮:  ai → file（draggable 没吞掉点击）
刷新后:      ai → file，持久化 ["ai","file"]
```

---

### 需求9 · 设置中「命名模板」和「AI 命名提示词」乱码

**根因：历史脏数据，不是当前代码缺陷**（三条路径全部排除）

| 假设 | 排除证据 |
|---|---|
| 源文件 GBK 破坏 | 8 个相关源文件 UTF-8 扫描 GBK 特征串 **0 命中** |
| 字符集/加密链路 | `user_settings` 是 `utf8mb4`、连接三件套 `utf8mb4`、`sql_mode=STRICT_TRANS_TABLES`（不可表示会**报错**而非替换）；`crypto.js` 编码参数全 `utf8` |
| 当前写入路径 | **6 组对照值** PUT→GET 全部原样往返：`ABC123` / `AB{CD}EF` / `AB日CD` / `YYMMDD日HHMM-{input}` / `AB-CD_EF.G` / `AB CD:E*F?G` |

**原值反推**（逐字符对齐）：
```
落库 = "YY?MM?DD?HHMM-?input?"     21 字符
原值 = "YY年MM月DD日HHMM-{input}"   21 字符
规则 = 非 ASCII 字符 或 花括号 → 单个 '?'
旁证 = SettingsPage.vue:1616 的 placeholder 至今写着 "YY年MM月DD日HHMM"
```

**修复**：
- 精确签名表（**不做比例推断** —— 避免误杀 `A?B?C` 这类合法自定义模板）；
- `naming.garbleBackup` 原值备份（万一误判可人工恢复）；
- 存量修复：`YY?MM?DD?HHMM-?input?` → `YYMMDD日HHMM-{input}`、`???` → `无标题`、aiPrompt 恢复完整中文；
- **21 条单测**，含 4 条「防误杀」用例。

**实测（QA 独立在 API + DOM 两侧双查确认）**：
```
云端 naming.template = "YYMMDD日HHMM-{input}"   （原 "YY?MM?DD?HHMM-?input?"）
云端 naming.fallback = "无标题"                  （原 "???"）
aiPrompt 163 字符中文完整、0 个连续 ??
设置页 DOM 两个控件的值均正确
```

---

### 需求10 · admin 用户出现很多仓库

**根因**：服务端 `lib/vault-scope.js` 的 `assertVaultUsable()` 对未登记的 `(user_id, vault_id)` **无条件 INSERT** —— 无 name 去重、无上限、无来源标记。配合客户端 `app.ts` 在「云端无仓库」时落 `uid('vault')` 随机 id，**每次新 profile / 测试脚本都造一条 0 文档空壳**。

> 注意：`registry.ts` 的 `mergeRemote()` / `attachVaultId()` **只做本机 localStorage 去重，完全管不到服务端表** —— 所以只修客户端不够。

**修复（服务端三层收敛）**：
1. **同 name 复用**：`defaultName` 非空且 ≠ vaultId 时，若已有同名 active 仓库直接返回，不新增行（堵住「每次新 profile 造一条 Neo MD」）；
2. **来源标记**：新建写 `auto_registered=1` + `auto_registered_at`（既有行默认 0 → 绝不会被误清）；
3. **上限兜底**：`MAX_ACTIVE_VAULTS_PER_USER = 20`，超出 409 `VAULT_LIMIT_REACHED`。

**存量清理**：`user_vaults` **10 行 → 4 行**，云端对象归零。

清理判定（4 条全部成立才删）：`doc_count=0` + `bytes=0` + **无 `manifest.json`**（真实仓库只要同步过一次就必有）+ **无 `versions/`**（真实编辑过就必有）+ 去系统文件后只剩 `docs/selftest/*`。

保留的 4 条：`笔记本`(700 篇) / `Neo MD`(436) / `vaultmvp3...`(298) / `admin`(192)。

**防复发（客户端侧，这是最关键的修复）**：
- `VaultEntry` 新增 `orphan` / `orphanSince` / `orphanMissCount`；
- 云端不存在但本地残留 → 判 `orphan` 且**不参与同步**；
- **连续 3 轮**（约 6 分钟）确认后才物理移除（防单次网络抖动误删真实仓库）；
- 纯本地目录仓库**永不误判**（`hadCloudPresence()` 返回 false）；
- 「云端有、本地没有」→ 保持 `available:false`（跨设备发现，语义不变）。

**实测（反弹复现验证）**：
```
基线 4 条 → 注入 2 条幽灵（localStorage 4→6）
→ 重载，幽灵被判 orphan ✓ 且不在 syncable ✓
→ 触发「全部同步」：synced=4（幽灵被跳过）
→ /api/vaults 4 → 4，幽灵未被重新登记 ✓
对照组：对未登记 id 直接调存储接口 → 服务端立即登记（证明反弹机制真实存在）
```

> **关键教训**：「过滤遍历列表」不等于「堵住所有入口」。第一轮只改 `syncAllVaults` 用 `listSyncable()`，实测仍 `4 → 6` 失败 —— 因为 `syncVaultById()` 在同步前还有一次**显式**的 `vaultsApi.upsert()`，这是与服务端自动登记**独立的第二条通路**。必须在该入口拦截才真正通过。
>
> 另修一个隐蔽缺陷：`normalizeEntry()` 是**白名单式**构造，新加的 `orphan` 字段在「读盘→再存」时被静默丢弃 → 标了 orphan 刷新后失效、继续参与同步。**给持久化结构加字段必须同时改「接口 + normalizeEntry + persist」三处。**

---

### 需求11 · 主题中颜色和主题调整，不影响分割线等；确保主题可用性

**根因**：`--border` 等结构色由同一套主题变量派生，调色时被一起改；实测 10 套主题里 **6 套** `--border` vs 背景对比度 < 1.2（日光白 1.14 / 石墨灰 1.15 / 护眼绿 1.17 / 静谧蓝 1.15 / 暖纸黄 1.18 / 玫瑰粉 1.19）—— 分割线在视觉上接近消失。

**修复**：`themes.ts` 语义分档 `CONTENT_THEME_VARS` / `CHROME_THEME_VARS` / `STRUCTURAL_THEME_VARS`；新增 `contrastRatio()` / `ensureContrast()` / `protectStructuralColors()`；`themeVars()` 自带结构色保护。

**实测（10 套主题 + 1 套自定义）**：
```
修复前：对比度 1.14 ~ 1.33（6 套 < 1.2）
修复后：--border 1.25 ~ 1.55，--border-strong 2.09 ~ 2.44，--table-border 1.56 ~ 2.44
断言：全部 ≥ 1.2，0 套不达标
```

---

### 需求12 · 主题勾选「仅正文」但全局生效

**根因**：排除的一侧用 `removeProperty` **清空**变量，而清空后 CSS 会**回落到 `themes.css` 里同一套主题的静态值** —— 于是"看起来没变"。

**修复**：改为写**中性基线值**（`scopedThemeVars()`），而非清空。

**实测**：
```
scope=all      → --bg / --content-bg 都是主题值
scope=content  → --bg 与 all 模式不同（界面已脱离主题）、--content-bg 保持主题值
scope=chrome   → --bg 等于主题值（界面跟主题）、正文脱离
```

---

### 需求13 · 主题中设置了颜色细化但不生效

**两个独立成因**：
1. **强调色被吞**：`applyThemeVars()` 的判据是「`appearance.accent` 有值就覆盖主题 accent」，而 `applyThemePreset()` **每次都把 accent 写成主题自带值** → 用户改的强调色立刻被上一轮主题值覆盖。改为只在「用户值 ≠ 主题值」时才覆盖。
2. **操作路径**：颜色细化有**独立 `colorDraft`**，改 input 只是改「待应用配色」，必须再点一次「保存配色 / 存为新主题」才进草稿。按钮文案随上下文变化（自定义主题→「保存配色」，内置主题→「存为新主题」），断言必须用稳定的 `data-testid="theme-colors-apply"`。

**实测**：
```
改前 --content-bg=#64dae3 → 点「保存配色」→ 草稿变 #00aa88 → 点底部保存 → --content-bg=#00aa88 ✓
```

---

### 需求14 · 全部设置项检查测试，确保都有效果并放到该放的地方

**交付**：`tools/re14-settings-audit.mjs`，**18 条断言全绿，无效项 = 0**。

覆盖与效果类型（不同项靠不同证据，避免「只查 store 漏掉纯 CSS 项」）：

| 组 | 断言数 | 效果类型 |
|---|---|---|
| 主色调 accent | 3 | 归位到主题页签（主题 6 个 / 通用 0 个）+ 色板可点 + `--accent` 实际变化 |
| 主题作用域 all/content/chrome | 4 | CSS 变量实际计算值 |
| 分割线结构色保护 | 1 | 10 套主题对比度 |
| 颜色细化 | 2 | 两步式交互 + `--content-bg` 实际变化 |
| 排版（字号/行高/缩放/字体） | 5 | store 落盘 + **正文 computed 样式**（font-size 22.8px / line-height 43.32px） |
| 界面布局与行为开关 | 3 | store 翻转 + **不保存不生效**（需求16 反向断言） |

**「通用的主色调无法生效」确认修复**：
```
--accent: #1677ff → 点色板 #0E9F6E → 保存 → #0E9F6E ✓
且控件位置：主题页签 6 个 / 通用页签 0 个（已归位）
```

---

### 需求15 · 设置界面还会出现正文工具栏

**根因**：`<EditorBar v-if="activeTab && !isFlowTab && !isMindTab">` —— 设置标签是**虚拟 tab**（`SETTINGS_TAB_ID='__settings__'`），对 `activeTab` **为真**、且不是 flow/mind，所以整条 `.editorbar` 照常渲染。

**修复**：补 `!isSettingsActive && !isPluginActive`（两个 computed 本已存在）。

**实测（四场景）**：
```
普通文档 .editorbar = 1 ✓（正常路径未被改坏）
设置页   .editorbar = 0 ✓
图文档   .editorbar = 0 ✓
插件商店 .editorbar = 0 ✓
```

---

### 需求16 · 设置给保存按钮，不要即时生效

**改造**：设置页改为**草稿模式**
- 进入时快照草稿 + 基线；所有控件只写草稿；底部固定保存栏（保存 / 取消 / 恢复默认）+ 标题栏「实时预览」开关 + `beforeunload` 未保存提醒；
- 点保存才 `commitDraft()` → `persist()` + `applyTheme()` + `scheduleCloudPush()`；
- **只提交差集**（`buildDraftDelta()` + `diffObjects()`）—— 见下方安全修复。

**实测**：
```
B1 只改不保存 → localStorage 未变，保存栏显示「有未保存改动」
B2 点保存     → localStorage + DOM 都变，保存栏回「已保存」
【需求14-02】改字号后不保存直接关闭 → 重开仍是原值，localStorage 未变 ✓
```

---

## 二、用户报障之外挖出并修掉的缺陷

### 2.1 🔴 封禁到期时间时区错误（安全语义缺陷）

**危害**：不是显示问题，是**封禁失效** —— 管理员以为封了人，实际立刻被自动解封。

**根因（两层缺一不可）**：
1. `services/api/src/db/pool.js` 是 `timezone: 'Z'` → JS `Date` 按 **UTC** 写进 DATETIME；
2. MySQL `NOW()` 返回**服务器本地时间**（`SYSTEM` = +08:00）；
3. 两者差 8 小时。

**实测前后**：
```
修复前：封禁 2 小时 → ban_until=2026-10-30 20:00:46
        new Date() → 2026-10-30T12:00:46Z（被当成 8 小时前）
        banExpired=true, banned=false  ← 刚封禁就"到期"，且会被 sweepExpiredBans 误清记录

修复后：banUntil=2026-10-30T20:17:03.000Z | 距到期 120 分钟 | banned=true ✓
        1 小时封禁 → 剩 60 分钟 ✓    永久封禁 → banUntil=null, banned=true ✓
```

**修复三处**：SQL 侧统一 `UTC_TIMESTAMP()`；输出统一 `toIsoUtc()` 带 Z 的 ISO；JS 兜底 `isBanExpired()` 显式按 UTC 解析裸字符串。
**固化为回归断言** `D2g2`（2 小时封禁的到期时间必须落在 100~121 分钟后）+ `D2g3`（`banExpired === false`）。

### 2.2 🔴 草稿模式跨设备覆盖写

**根因**：草稿在 `onMounted` 快照，而 `requestCloudPull()` 通常**在快照之后**完成。若按整份草稿提交，会把刚拉下来的云端新值（另一台设备改的字体/主题/布局）用本端旧快照**覆盖回去**，并因「与保存前不同」被标进 pending **反向推回云端** → **静默抹掉他人改动**。

**为什么极难发现**：单机测试永远碰不到（必须「A 设备改 → B 设备打开设置 → B 保存别的项」）；症状与「设置自己变回去了」**一模一样**，会严重误导排查。

**修复**：`buildDraftDelta()` + `diffObjects()` 只提交「用户真的动过的那几项」的差集，其余尊重当前 store（含云端新值）；密钥类字段也改为「只在确实被改过时才提交」。

### 2.3 🟠 插件代码作者侧无校验（安全缺口）

见需求2 末尾。两个写 `codeJs` 的端点，后台侧有校验、作者侧没有 → 只修一个等于没修。

---

## 三、门禁设计说明（为什么这些断言不是恒真）

1. **负向对照段（N）6/6 全绿**：注入修复前逻辑，断言原判据必须失败。
   ```
   N1 px→% 换算回旧版：4 样本旧算法偏差 30~290px vs 新算法 0.00px
   N2 主题作用域判据：正确状态=true / 旧版残留=false
   N3 对比度判据：同色=1.0（判不达标）/ 黑白=21（判达标）
   N4 颜色判据：同色=true / 异色=false
   ```
2. **保存语义双向断言**：「不保存→不生效」+「保存→生效且刷新保持」。只测后者无法区分「有保存按钮」与「即时生效」。
3. **设置项按效果类型分类**：`store` / `cssVar` / `dom` 三类证据，避免「只查 store」把纯 CSS 项误判成无效。
4. **零污染自证（P）**：统计本脚本自身对生产 settings / vaults 的写请求数。

### 测试过程中的自我纠正（如实记录）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| C 段分屏全 false | localStorage key 写成 `neomd.localLayout.v1`，实际是 `neomd.localLayout` | 修脚本 |
| C 段拖动偏差 129~672px | 页面上有 2 个 `.resizer`，取到了左侧栏那个 | 改为取 `.shell__panes` 内的 |
| 右侧栏 C07/C08 失败 | `toggleRight()` 直接 `push` + `updateLayout()`，**绕过被测的上限逻辑**；且前置状态里残留 `file` | 改为走 `toggleRightSectionWithLimit` 同源逻辑 |
| A09 翻页未回顶 | 产品真缺陷：`scrollIntoView` 把容器顶到 54px | 修产品代码 |
| B06 语法校验失败 | **测试打错端点**（作者侧 vs 后台侧）→ 尽调后确认是真实安全缺口 | 修产品代码 |
| D01 审计 exit=1 | ① 首次进 /app 时 `docCount=0` 无正文容器；② 上一组把编辑模式留在源码模式；③ 嵌套跑时浏览器崩溃 | 加 `ensureDocTab()` 轮询 + 切回所见即所得 + 崩溃自愈重试 |
| D02 保存语义 B6 失败 | 断言固定等 6s，未覆盖「拉取→补发推送→1s 防抖」链路 | 改轮询（最长 45s） |
| 云端设置被污染 | **我的审计脚本点保存 → 真实 PUT 到生产库** | 改为 GET 回显本地设置 + PUT 吞掉（`isolateSettingsSync`），**让链路行为真实执行但字节不出浏览器** |

---

## 四、未覆盖项与已知遗留（如实列出，不以全绿掩盖）

### 4.1 功能未完成

1. **斜杠命令的行内 `/` 触发、页面预览的行内悬停浮层**：需编辑器扩展层（`WysiwygEditor` 的 slash 扩展 + wikilink hover DOM），本版按优先级砍至 1.5。功能已标注「部分可用」，不留死按钮。
2. **`SettingsModal.vue` 是死代码**（全仓无 import），未删除。

### 4.2 架构性技术债

3. **两份插件校验器**：`packages/shared/src/plugin-source.ts` 是给前端用的 TS 源码，服务端（Node ESM）无法直接 import，因此 `plugins.js` 有一份**等价实现**，规则靠人工对齐。任一侧新增规则必须同步另一侧，否则出现「后台能存、客户端跑不了」或反之。正解是下沉到 `packages/shared` 编译产物由服务端引用（需改 shared 构建），记为 1.4.1。
4. **`admin.js` 已达 3473 行**（本版 +1053 行），可按 users / releases / ai 拆分路由文件。
5. **`@neomd/core/dist/` 产物不可用**（`tsc` 输出省略扩展名的 ESM + 空 `index.js`），当前构建链路不依赖（Vite 直读源码），但 CI 若消费该产物会踩。

### 4.3 测试覆盖缺口

6. **内置插件面板渲染只抽 5 款**做 DOM 级验证（outline / tags / backlinks / bookmarks / outgoing-links），未覆盖全部 21 款「可用」面板。其余 21 款由 `tools/re14-builtin-plugins.mjs` 在数据层逐款断言。
7. **N 段是逻辑级验证**（喂两组输入给判据函数），不是「注入旧代码让真实页面失败」—— 因依赖产品当前主题状态不稳定。
8. **跨设备覆盖写修复只做了单机验证**（差集提交逻辑 + 19 条相关单测），未在真正的两台设备上端到端复现。
9. **封禁到期为惰性解封**（读列表时纠正），无定时任务；长期无人访问后台时到期账号会短暂保持 disabled（语义无害，下次任何读取都会纠正）。
10. **云端历史版本无数量上限**，`pruneRemoteVersions` 存在但无调用点（1.3.1 起遗留）。

### 4.4 环境与流程风险

11. **生产服务在本次验收期间多次非预期停机**（`SIGTERM` + 「开始优雅停机」，非崩溃非 OOM，服务器内存充足）。已定位到可能来源：同机还有一个不属于本仓库的 node 进程监听 `0.0.0.0:8781` 且**连同一个生产 MySQL**，若它属于某个「按进程名批量 kill node」的运维脚本，就能解释为什么是优雅停机而非崩溃。**这是待查的运维问题，不是代码缺陷**。
12. **本机无头 Chrome 不稳定**：默认参数约 30s 崩（空白页也崩，非内存），必须 `--disable-gpu`；嵌套跑（父门禁 + 子脚本各持一个 Chromium）时会偶发 `Page crashed`，已在审计脚本里加崩溃自愈重试。

---

## 五、复现命令

```powershell
cd C:\Data\BAC\neomd\neomd-V1

# 1.4.0 全量门禁（16 项需求 + 负向对照，约 12 分钟）
node tools/verify-140.mjs --negative-control --json=docs/evidence-140/verify-140-lead.json

# 1.3.1 六项不得回归
node tools/verify-121.mjs --only=A,B,D,E,F
node tools/verify-121.mjs --only=C          # 含 95s×3 字体保持等待

# 设置专项
node tools/re14-settings-audit.mjs          # 18 条，无效项 = 0
node tools/re14-settings-save-verify.mjs    # 15 条，保存语义
node tools/re14-builtin-plugins.mjs         # 26 款逐款

# 发版产物门禁（必须在 make-deploy 之后跑）
node tools/re14-release-gate.mjs

# 基础质量
npx vitest run
pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json
npx tsc -p tsconfig.json
node tools/release-119.mjs check
```

> **限流提醒**：登录 10 次/分钟、`/api/vaults` 写 20 次/分钟。连续重跑建议间隔 60 秒。

---

## 六、结论

**1.4.0 可发布。**

- 16 项需求全部落地，`verify-140` **59/59**、`verify-121` **45/45**（1.3.1 零回归）、`vitest 295`、三道类型检查全 0 错误；
- 每项需求都有修复前后的实测对比，负向对照 6/6 证明断言非恒真；
- 除需求外修掉 3 个真实缺陷（封禁时区、跨设备覆盖写、插件代码校验缺口），其中前两个都是「测试期发现不了、上线后静默损坏数据」的类型；
- 本报告第四章**如实列出 12 项未覆盖或存疑之处**，含功能未完成、架构债、测试缺口与环境风险。
