# Neo MD 1.1.9 验收报告

本文件记录 1.1.9 的验收口径、实测数字与结论。**任何一条断言失败即视为不可发布**（门禁脚本退出码非 0）。

- 验收脚本：`tools/verify-119-full.mjs`（7 段 111 条断言）
- 补充脚本：`tools/verify-119-sync.mjs`（64 条）、`tools/verify-119-admin.mjs`（146 条）、`tools/verify-119-settings.mjs`、`tools/verify-119-diagram.mjs`、`tools/verify-119-multiwindow.mjs`（46 条）
- 环境：本地 API `http://127.0.0.1:3200`（development，连生产库）+ 前端 `http://127.0.0.1:5178`（vite dev）

---

## 一、发布前必跑清单（三条类型/测试门禁 + 一条端到端）

```powershell
# 1. packages 类型检查（含 __tests__）
npx tsc -p tsconfig.json                                   # 必须 EXIT=0

# 2. Vue 组件与 stores 类型检查（vue-tsc 的 bin 只在 apps/web 下）
cd apps/web; npx vue-tsc --noEmit -p tsconfig.json; cd ../..   # 必须 EXIT=0

# 3. 单元测试
npx vitest run                                             # 必须 204 passed

# 4. 端到端门禁
node tools/verify-119-full.mjs                             # 必须「全部断言通过」
```

> **为什么必须跑两条类型检查**：`pnpm build` 走 esbuild，**不做类型检查**。1.1.9 期间发生过两次「删了定义留了调用」的事故（`app.ts` 的 `isFirstSyncDone`、`EditorPage.vue` 的 `splitTabIntoPane`），打包零报错、运行时才抛 `ReferenceError`，且被 fire-and-forget 静默吞掉。`tsc` 管 `packages/*`，`vue-tsc` 管 `.vue` 与 `apps/web`，缺一不可。
>
> 测试文件**不得**从 tsc 工程中排除——排除等于给同类事故留后门。本版已把 `packages/core/src/__tests__/**` 纳入检查（并修掉了由此暴露的 2 个类型错误）。

---

## 二、A 段：启动与首屏（6/6）

| 断言 | 期望 | 实测 |
|---|---|---|
| A1 首屏外壳挂载（3 次中位数） | < 900ms（1.1.8 基线 277ms） | **271ms** |
| A2 当前文档可编辑（3 次中位数） | < 2000ms | **282ms** |
| A3 FCP | < 1000ms | **164ms**（DCL 71/72/77ms） |
| A4 外壳真实渲染 | 无骨架屏占位 | shell 1600×950 opacity=1，`.skel` 数量 **0** |
| A5 慢网络下不阻塞首屏 | 外壳 < 1200ms（给 `/api/settings`、`/api/storage` 各加 2.5s 延迟） | **295ms** |
| A6 启动无 JS 运行时错误 | 0 条 pageerror | **0 条** |

**结论**：1.1.9 取消骨架屏、改为「先渲染真实外壳，设置与同步后置」，A5 是这条设计的直接证据——人为给两个网络接口各加 2.5 秒延迟后，外壳仍在 295ms 出现。

---

## 三、B 段：设置项逐项生效（19/19）

关键实测（字号 22 + 行高 2.1 + 缩放 150%）：

```
根变量：--content-font-size: 33px / --content-line-height: 2.1 / --content-zoom: 1.5
wysiwyg  .nm-content    font-size 33px  line-height 69.3px
source   .cm-content    font-size 33px  line-height 69.3px
compare  .nm-content + .cm-content  均 33px / 69.3px
read     .nm-content    font-size 33px  line-height 69.3px
```

| 断言 | 结果 |
|---|---|
| B1 字号/行高/字体/缩放写入根变量 | ✓ |
| B2 字体族变化 → `--font-content` 真的变 | ✓ `system-ui` → 用户所选完整字族 |
| B3 wysiwyg / source / compare / read 四模式 | ✓ 四模式全部 33px / 69.3px |
| B4 主题预设可用 | ✓ 10 套 |
| B5 深色主题 → `data-theme=dark`、正文底色变 | ✓ `#ffffff` → `#14171c` |
| B6 主题「应用范围」分段控件 | ✓ 3 个选项 |
| B7 行号开关 | ✓ `showLineNumbers` 与 `.nm-show-linenos` 类同步 |
| B8 拼写检查驱动 `.ProseMirror[spellcheck]` | ✓ `false`（本版新接线） |
| B9 **反向断言**：设置页不得出现「打字机模式」 | ✓ 扫描 10 个页签，0 处命中 |
| B10 自动保存开关 | ✓ 并持久化 |
| B11/B12 命名模板修改 → 新文档标题 `QA119-…` | ✓ |
| B13 快捷键页有真实内容 | ✓ 610 字符、含 Ctrl 组合 |
| B14 功能区按钮开关 → ribbonItems 变化 | ✓ 且切回工作台图标数相应变化 |
| B15 页宽（降级断言：编辑器工具栏按钮） | ✓ narrow 620 / standard 760 / wide 1080 / full none |
| B16 设置过程无 JS 错误 | ✓ 0 条 |

**关于 B9 的反向断言**：`typewriterMode` 只有类型定义、全仓零消费点，是「假开关」。本版摘掉它的 UI 并保留字段以兼容云端设置——**无效开关比没有开关更糟**，所以这条断言防的是「以后有人又把假开关加回来」。

**关于 B15 的降级**：`pageWidth` 字段仍在类型里，但设置页自 1.1.7 起已移除该控件（编辑器固定自适应）。因此改为断言编辑器工具栏的页宽按钮真实生效。

---

## 四、C 段：同步链路（13/13）

| 断言 | 实测 |
|---|---|
| C1–C6 服务端往返 | PUT 200(size 114) → LIST 200 → GET 200 字节一致 → HEAD 200 etag 非空 → DELETE 200 → GET 404 |
| C7 浏览器真实同步无失败请求 | **265 次** `/api/storage/*` 调用，异常 **0** 条 |
| C8 正文确实上传 | PUT 200 |
| C9 当前仓库显示「已同步 + 时间」 | `已同步 … 上次同步 2026-10-28 17:20` |
| C10 仓库列表不再全部「未同步」 | 5 个仓库状态全部「已同步」 |
| C11 两端清单一致 | 服务端 5 个 vs 本地 5 个，**缺客户端 [] / 缺服务端 []** |
| C12 客户端只传相对 key | **99 条**请求中 **0 条**带完整作用域前缀 |
| C13 同步过程无 JS 错误 | 0 条 |

补充（`tools/verify-119-sync.mjs`，64/64）：
- 全程 **0 个直连 `aliyuncs.com`** 的请求 —— 「Failed to fetch」根因路径已彻底切断
- 从未同步过的新仓库：网页端 `currentVaultId === 服务端登记的 vaultId`，不再是 `vaultxxxx` 随机串
- 本地 `lastSyncedAt` 与服务端 `last_synced_at` **双回写**
- 同步设置接线：自动间隔驱动定时器（下限 30s，0=关闭）、方向/冲突策略读设置而非硬编码、「立即全部同步」遍历所有 active 仓库、成功后 `syncState` 立即复位

---

## 五、D 段：工作台交互（27/27）

| 断言 | 实测 |
|---|---|
| D1 工具栏 `dragstart` 真实触发 | dragstart=1、drop=1（此前 `@mousedown.prevent` 会把它吞掉） |
| D2 拖动后顺序真的改变 | ✓ |
| D3 顺序持久化到 `layout.toolbarItems` | ✓ |
| D4a 拖拽 → 等推送 → 刷新：顺序保持 | ✓ |
| D4b 推送成功后脏标记被清空 | ✓ |
| D4c 拖拽 → **立刻**刷新（推送未完成）：顺序仍保持 | ✓ 云端旧值不回滚本地 |
| D5 功能区末位图标贴底 | `btnBottom 920 = ribbonBottom 920`，gap **0px** |
| D6 贴底按钮是插件商店入口 | ✓ |
| D7 插件商店以标签页打开 | ✓ 激活标签「插件商店」 |
| D8 插件商店内容非空且尺寸正常 | 1300×842，321 字符，**有真实上架插件** |
| D9–D12 正文首行文件名行 | input 存在、`position: relative`（不冻结）、`1px solid` 分割线、**不在 `.ProseMirror` 内**（不占行号） |
| D13 改名联动 | 标题行 + 标签栏同步变化 |
| D14 右侧多操作区可同时开启 | panes=2 |
| D15 手柄数量 = n-1 | 2 个区块 → **1** 个水平手柄 |
| D16 无双层滚动条 | `scrollH 850 = clientH 850` |
| D17 右侧操作区统一为窗口开关语义 | 9 个按钮全部 `aria-pressed` |
| D18 高度可拖拽 | `[380,470]` → `[470,380]` |
| D19/D20 左右分屏 / 上下分屏打开**不同**文件 | `shell__panes--v` / `--h`，主栏 `QA119-改名验证-76423` vs 副栏 `261029日0120-` |
| D21–D22 标签右键「移动至新窗口」 | 菜单项存在；Web 端点击无 JS 错误并有提示 |
| D23 1280px / 900px 无横向溢出 | 溢出 **0px** / **0px** |
| D24 工作台交互过程无 JS 错误 | 0 条 |

桌面端多窗口（`tools/verify-119-multiwindow.mjs`，**46/46**，含真实 Electron GUI 冒烟）：
- 两窗口并存、JS 上下文互相独立
- 关掉原始第一个窗口后，剩余窗口的对话框父窗口仍正确（旧实现在此处必错）
- 主题变更广播到所有窗口
- 新窗口 URL = `neomd://neomd/app?doc=<id>&fresh=1`

---

## 六、E 段：流程图与思维导图（19/19）

| 断言 | 实测 |
|---|---|
| E1 插件名称无括号备注 | `["流程图","思维导图"]` |
| E2 四段式尺寸 | 工具栏 48 / 图形库 200 / 属性 280 / 状态栏 28 |
| E3 画布有实际绘制 | 820×804 |
| E4 **viewBox 与实际像素一致** | `0 0 820 804` = 元素 820×804（不再固定 1200×700） |
| E5 画布坐标命中正确 | **2/2** 命中各自节点 |
| E6 拖拽位移 === 鼠标位移（±6px） | dx 76~79 / dy 46~49（渲染管线取整，见下） |
| E7 四种箭头工具都生成「连线」而非「节点」 | **4/4**：直线/虚线/双向/曲线均「连线 +1、节点 +0」 |
| E8 虚线与曲线样式正确 | `stroke-dasharray="6 4"`；曲线 path 含 `C` |
| E9 从节点锚点拖到另一节点能画出连线 | ✓ edges 0 → 1 |
| E10 连续添加两次同一图形不重叠 | ✓ 包围盒不相交 |
| E11 流程图 900px 无横向溢出 | 0px |
| E12–E13 思维导图挂载、viewBox 一致 | ✓ |
| E14 结构树显示 `+N` | `["+2"]` |
| E15 **画布上也显示 `+N`** | `circle[r="9"]` 存在，文本 `+2` |
| E16 点击画布角标可展开 | 节点 1 → 3 |
| E17 思维导图 900px 无横向溢出 | 0px |
| E18 图表插件过程无 JS 错误 | 0 条 |

**E6 容差说明**：拖拽链路是「屏幕坐标 → 除缩放 → 写回节点 → 重渲染 → 读回屏幕坐标」，中间有两处必然取整（CSS 像素对齐 + 视图层 `Math.round`），实测稳定偏差 3–4px。**坐标错位类 bug（viewBox 那个）的偏差是几十到几百像素量级**，两者不会混淆，故容差设为 ±6px。

---

## 七、F 段：后台管理端与 AI（23/23）

| 断言 | 实测 |
|---|---|
| F1 后台可打开（导航挂载） | ✓ |
| F2 浅色主题 | `data-theme=light`，body `rgb(242, 244, 247)` |
| F3 模块齐全 | **18 个**可点项（含 16 个后台模块 + 个人中心 + 返回编辑器） |
| F4 每个模块都能打开且有内容 | 全部模块文本 > 10 字符、无「加载失败」 |
| F5 看板指标卡非空 | **8 张**（总用户 3 / 今日活跃 1 / 总文档 80 / 存储 18.6KB / AI 调用 4 / 知识库查询 0 / AI 失败率 0.0% / 平均响应 26ms） |
| F6 看板图表已绘制 | ✓ |
| F7 看板有真实数据（非全 0 占位） | ✓ 多项非 0 |
| F8 前台无「是否开通」字样 | ✓ 命中 false |
| F9 平台付费与自带 Key 分成两个独立区块 | ✓ |
| F10 公开供应商接口不泄露 apiKey | ✓ 无密钥字段、无 `sk-` 形态值（`apiKeyUrl` 是公开文档地址，允许） |
| F11 **平台代付组不下发 baseUrl、BYOK 组必须下发** | 平台组 8 个、泄露 0 个；BYOK 组缺 baseUrl 0 个 |
| F12 可创建平台 AI 供应商 | 200 `apiKeySet=true` |
| F13 保存模型级系统提示词 | 200 |
| F14 **模型级 > 供应商级**优先级 | `systemPromptSource="model"` |
| F15 **提示词真的注入上游请求体** | 上游 `messages[0] = {role:"system", content:"…"}` |
| F16 模型级 temperature / maxTokens 夹逼 | `temperature=0.3`、`max_tokens=128` |
| F17 申请知识库令牌（明文仅返回一次） | 200，`nmd_kb_…`（47 位） |
| F18 **Bearer 令牌实测调用通过** | 200 `authMode=token` |
| F19 令牌列表不回传明文 | ✓ `含明文=false` |
| F20 **吊销后立即失效** | DELETE 200 → 再用 → 401 `KB_TOKEN_REVOKED` |
| F21 非法令牌被拒绝 | 401 |
| F22 后台与 AI 过程无 JS 错误 | 0 条 |
| F23 **限流返回 429 而非 500** | 第 11 次登录请求 → 429 `RATE_LIMITED` |

补充（`tools/verify-119-admin.mjs`，**146/146**）：
- 界面全链路：教程「去申请令牌」跳转 → 创建出 `nmd_kb_` 明文 → 界面「立即验证」= 验证通过 → 吊销 → 同一明文立即 401
- 900px 窄屏侧栏转横向、无横向溢出
- `migrate-v2` 对 `user_settings` **只有 SELECT**，连跑两次 `payload_json`/`payload_enc`/`version` 全部未变

---

## 八、G 段：回归（4/4）

| 断言 | 实测 |
|---|---|
| G1 `tsc -p tsconfig.json`（含 `__tests__`） | **EXIT=0** |
| G2 `vue-tsc --noEmit`（含 `.vue` + stores） | **EXIT=0** |
| G3 `vitest run` | **204 passed / 0 failed**（8 文件，约 500ms） |
| G4 `pnpm build:web` | **EXIT=0**，473 modules，约 4.2s |

---

## 九、本版修掉的关键缺陷（按影响排序）

| # | 缺陷 | 影响 | 根因 |
|---|---|---|---|
| 1 | 同步失败 `Failed to fetch` | 同步完全不可用 | 已登录用户被残留的 `bucket:"zhenglob"` 配置抢到自建 S3 直连通道；阿里云对失败响应不返回 CORS 头 |
| 2 | PC / Web 两套仓库 | 同一账号两端看到不同仓库 | 网页端打开 `cloud:<用户名>` 时生成随机 vaultId，与服务端登记的 id 永久错位 |
| 3 | 仓库全部「未同步」 | 状态显示永远错 | `markFirstSyncDone` 等 4 个 helper 被删但调用点保留 → 运行时 `ReferenceError` 把成功报成失败 |
| 4 | 流程图/思维导图「页面错乱」 | 插件不可用 | ① `viewBox` 在 `computed` 里读非响应式的 `getBoundingClientRect()`，永久停在 1200×700；② `.flow__body` 缺 `min-width:0`，画布被固定侧栏挤到 **10px** 宽 |
| 5 | 流程图箭头画成矩形 | 连线工具完全无效 | 图形库「箭头」4 项都标成 `shape:'rect'`，且只读 `item.shape` |
| 6 | 从锚点拖不出连线 | 无法连节点 | 三重叠加：锚点在节点 `<g>` 内被邻居盖住、被缩放手柄盖住、`hitHandle()` 判断排在锚点之前 |
| 7 | 工具栏拖不动 | 只能点箭头调序 | `@mousedown.prevent` 取消了默认行为，Chromium 因此不启动 HTML5 拖放 |
| 8 | 设置改了又回去 | 拖拽结果被云端覆盖 | `pullCloudSettings()` 只保护主题、不保护 `layout` |
| 9 | 字体/字号不生效 | 设置项形同虚设 | `--font-content` 从未读取 `appearance.fontFamily`；且内层元素又内联写了一次 `--content-font-size`，静默遮蔽 `<html>` 那份 |
| 10 | 限流返回 500 | 客户端把「请慢点」当「服务坏了」 | `errorResponseBuilder` 缺 `statusCode`，被全局错误处理器包装成 500 |
| 11 | 大仓库首同步撞限流 | 约 150 篇文档即失败 | 全局桶 300/分钟 把 `/api/storage/*` 也算了进去（一次同步是 `2N+2` 请求） |
| 12 | 个人中心白屏 | 页面不可用 | `profile!.nickname` 对 null 取属性（`!` 只是编译期断言） |
| 13 | 打包后桌面端启动即崩 | 装完打不开 | `electron-builder.config.cjs` 的 `files` 白名单漏了新模块 |

---

## 十、已知未实现（非本版回归，明确记录避免重复上报）

| 项 | 状态 |
|---|---|
| `letterSpacing`（字距） | `AppearanceSettings` 中不存在，属从未实现 |
| `paragraphSpacing`（段落间距） | 同上 |
| `typewriterMode`（打字机模式） | 只有类型定义、零消费点；本版已摘掉 UI，字段保留以兼容云端设置 |
| 跨端布局同步的两端实测 | 基线机制已实现且单端「拖拽不被回滚」已实测；两端之间的实测留待后续版本用干净的双浏览器上下文验证 |

---

## 十一、复现命令

```powershell
# 全量门禁
node tools/verify-119-full.mjs

# 分段（调试用）
node tools/verify-119-full.mjs --only=A          # 仅首屏
node tools/verify-119-full.mjs --only=D,E        # 工作台 + 图表
node tools/verify-119-full.mjs --skip-build      # 跳过 build:web（省 CPU）
node tools/verify-119-full.mjs --shots           # 截图存 docs/shots-119/

# 专项
node tools/verify-119-sync.mjs                   # 同步链路 64 条（约 3-4 分钟）
node tools/verify-119-admin.mjs                  # 后台与 AI 146 条
node tools/verify-119-settings.mjs               # 设置项
node tools/verify-119-multiwindow.mjs            # 桌面端多窗口 46 条
```

> **注意**：连续重跑会撞全局限流（登录 10/分钟、`/api/vaults` 写 20/分钟）。脚本已内置 429 重试与退避，但频繁跑测建议间隔 60 秒。
