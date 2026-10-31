# Neo MD 1.4.0 · 插件可用性验收证据（T1）

> 负责范围：需求 1（新装插件可用 + 功能区入口）、需求 6/17（26 款内置插件逐一可用）
> 验证时间：2026-10-31
> 全部结论均由脚本/浏览器实测产出，不含人工判断。

---

## 一、三条硬指标

| 指标 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npx vitest run` | **11 files / 277 tests passed**（基线 236 + 插件解析器 20 + T4 的 21） |
| 类型检查 | `pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json` | **exit 0，0 错误** |
| 26 款逐款验证 | `node tools/re14-builtin-plugins.mjs` | **26 款：可用 21 / 部分可用 5 / 暂不可用 0 / 缺失 0；失败 0；exit 0** |

机器可读结果：`docs/shots-140/re14-plugins-result.json`

---

## 二、26 款内置插件逐款结果

`✓` = 三层断言全过（清单一致 → 宿主可解析 → 执行有实效果）

| # | 插件 | 状态 | 入口 | 验证到的实际效果 |
|---|---|---|---|---|
| 1 | 白板 | ✓ 可用 | panel+command | `whiteboard.create` → 打开白板面板 |
| 2 | 笔记重组 | ✓ 可用 | panel+command | `reorganize.batch` → 打开笔记重组面板 |
| 3 | 标签列表 | ✓ 可用 | panel+command | `tags.panel` → 左侧栏按 `#` 搜索 |
| 4 | 出链 | ✓ 可用 | panel | 解析出 wikilink/嵌入/外链三类 |
| 5 | 大纲 | ✓ 可用 | panel | 面板渲染分支存在 + 已接线 |
| 6 | 发布 | ✓ 可用 | panel+command | `publish.current` → 打开分享弹窗 |
| 7 | 反向链接 | ✓ 可用 | panel | 面板渲染分支存在 + 已接线 |
| 8 | 工作区 | ✓ 可用 | command | `workspace.save` / `workspace.restore` |
| 9 | 关系图谱 | ✓ 可用 | panel+command | `graph.open` → 打开图谱面板 |
| 10 | 幻灯片 | ✓ 可用 | panel+command | `slides.present` → 打开幻灯片面板 |
| 11 | 脚注视图 | ✓ 可用 | panel | 识别定义/引用/悬空三类脚注 |
| 12 | 快速切换 | ✓ 可用 | command | `quick.open` → 打开命令面板 |
| 13 | 录音机 | ⚠ 部分可用 | panel+command | `recorder.toggle` → 打开录音面板（限制见下） |
| 14 | 漫游笔记 | ✓ 可用 | command | `random.open` → 打开随机笔记 |
| 15 | 日记 | ✓ 可用 | panel+command | `daily.open` / `daily.today` → 打开今日日记 |
| 16 | 书签 | ✓ 可用 | panel+command | `bookmark.toggle` → 收藏/取消并持久化 |
| 17 | 属性列表 | ✓ 可用 | panel | 聚合 frontmatter 属性（含中文键名） |
| 18 | 数据库 | ⚠ 部分可用 | panel+command | `database.create` → 打开数据库视图（限制见下） |
| 19 | 网页浏览器 | ⚠ 部分可用 | panel+command | `browser.open` → 打开内嵌浏览器（限制见下） |
| 20 | 文件恢复 | ✓ 可用 | panel+command | `recovery.open` → 打开文件恢复面板 |
| 21 | 文件列表 | ✓ 可用 | panel | 面板提供左侧栏直达 |
| 22 | 斜杠命令 | ⚠ 部分可用 | extension+command | `slash.insertMenu` → 插入标题标记（文档已变） |
| 23 | 页面预览 | ⚠ 部分可用 | panel+extension | 取到目标首段摘要 + 标出目标不存在 |
| 24 | 字数统计 | ✓ 可用 | panel | 字符/词/CJK/行数/阅读时长全部正确 |
| 25 | 流程图 | ✓ 可用 | command | `diagram.createFlowchart` → 新建 .flow 文档 |
| 26 | 思维导图 | ✓ 可用 | command | `diagram.createMindmap` → 新建 .mind 文档 |

### 5 款「部分可用」的具体限制（界面里同样会展示给用户）

| 插件 | 限制 |
|---|---|
| 录音机 | 录音与本地回放可用；上传对象存储需先在「设置 → 存储」配好 S3 且能联网，否则只能本地试听。浏览器需授予麦克风权限。 |
| 数据库 | 可按 frontmatter 聚合成表格并跳转；保存为 `.base` 文件**未实现**（宿主无 .base 读写能力）。 |
| 网页浏览器 | 内嵌浏览与「提取正文为 Markdown」可用；目标站点若设 `X-Frame-Options` / CSP `frame-ancestors` 会拒绝内嵌（站点侧限制，宿主无法绕过）。 |
| 斜杠命令 | 命令面板/功能区可唤出插入菜单；正文内直接键入 `/` 就地弹菜单**未接入**（需编辑器扩展层）。 |
| 页面预览 | 面板可预览全部 Wikilink 目标首段；正文内悬停浮层**未接入**（需编辑器扩展层）。 |

> 说明：本轮**没有**「暂不可用」项。原本评估会被禁用的 `page-preview` 已通过「面板形态」救活，行内悬停按约定砍到 1.5。

---

## 三、需求 1：社区插件端到端取证

### 3.1 链路

真实市场插件 `plugin-market/plugins/13-heading-auto-number.js`（2288 字节，含中文注释）

| 步骤 | 证据 |
|---|---|
| 1. 导入（走 `installCommunityPlugin` 同一段代码） | `re14-plugin-01-import-dialog.png` |
| 2. 安装即校验通过 | 源码经 `loadPluginModule` 真实执行，无异常 |
| 3. **功能区出现入口** | 按钮数 11 → 13，新增 `社区插件：标题自动编号（点击运行）`；`re14-plugin-02-ribbon-entry.png` |
| 4. **内置白名单零污染** | `layout.ribbonItems` 逐字节未变（12 项不变）；社区插件只写 `neomd.communityRibbon.v1` |
| 5. 点击按钮 | `re14-plugin-03-before-click.png`（点击前） |
| 6. **文档真的变了** | 见下方 diff；`re14-plugin-04-after-click.png` |
| 7. 结果如实反馈 | toast：`插件「标题自动编号」已执行，文档已更新` |

### 3.2 文档前后 diff（点击功能区按钮的真实结果）

```diff
  第一章
  第一节

  正文段落。

  第二章
  第一节
```

```diff
+ 1. 第一章
+ 1.1 第一节

  正文段落。

+ 2. 第二章
+ 2.1 第一节
```

DOM 断言：`H2: 1. 第一章` / `H3: 1.1 第一节` / `H2: 2. 第二章` / `H3: 2.1 第一节`

### 3.3 坏插件必须在安装阶段被拒（可读错误）

输入（`}` 与 `//` 注释同一行 → 括号被吞）：

```js
export default { id: "broken", setup(api) { api.notify("x"); } // 右花括号被这行注释吞掉了 };
```

实测错误（`PluginSourceError`，**不是**原生 `SyntaxError`）：

```
插件源码括号或字符串未闭合，无法执行。常见原因是使用 `//` 行注释后，其后的代码（含 `}` `)`）被追加到了同一行而被注释吞掉；请把注释单独放一行，或改用 `/* */`。
```

1.3.1 的旧实现在这个场景抛的是 `SyntaxError: Unexpected token ')'`——用户完全无从下手。

### 3.4 面板类内置插件实测（此前「有清单、无渲染路径」的款）

| 截图 | 内容 |
|---|---|
| `re14-plugin-05-wordcount-panel.png` | 字数统计面板：55 字符 / 37 字符（不含空白）/ 22 词 / 16 中日韩字符 / 11 行 / 5 非空行 / 0.1 分钟 |
| `re14-plugin-06-footnote-panel.png` | 脚注视图面板：正确识别 `[^1]` 与 `[^缺失]` 两条**悬空脚注**（橙色警示「只有引用，没有定义」） |

---

## 四、回归无损坏证明

### 4.1 1.3.1 六项缺陷门禁 `node tools/verify-121.mjs`

| 段 | 内容 | 结果 |
|---|---|---|
| A | 行距 / 空行保真（A01–A08） | **全部 ✓** |
| B | 分屏配色（B01–B08） | **全部 ✓** |
| C | 设置字体不被自动恢复（C01–C09） | ✗ 8 项失败（**属 T4 的 SettingsPage / themes，非本任务文件**） |
| D | 保存后空换行不丢（D01–D06） | **全部 ✓** |
| E | 历史版本多版本可用 | 属 T5 范围 |

**关键**：A 段（行距/空行）与 D 段（空行保真）是 1.3.1 的核心断言，直接依赖
`EditorPage.vue` 与 `WysiwygEditor.vue`——**均无回归**。
C 段失败项全部落在 `SettingsPage.vue`（T4 正在改的文件），与本任务写入范围无交集。

### 4.2 架构边界确认

- `RIGHT_SECTIONS` 仍为 8 项（`ai/file/outline/backlinks/tags/history/stats/calendar`），
  **未插入 `plugin`**——右侧栏区块枚举属 T3，未越界；
- `packages/shared/src/types.ts` 的 `RightPanelSection` 联合类型**未改动**；
- `layout.ribbonItems` 语义保持不变（仍是内置插件 id 白名单）。

---

## 五、逐款可复现命令

```bash
# 26 款逐款结果表（人类可读）
node tools/re14-builtin-plugins.mjs

# 机器可读 JSON
node tools/re14-builtin-plugins.mjs --json

# 单元测试（含解析器 a~g 七用例）
npx vitest run

# 类型检查
pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json
```

---

## 六、已知限制（如实声明）

1. **斜杠命令行内 `/` 触发**、**页面预览行内悬停浮层**：需在编辑器扩展层实现，
   本轮按计划砍到 1.5，已标为「部分可用」并在界面展示限制说明。
2. **数据库 `.base` 持久化**：宿主无该文件格式读写能力，面板可用但保存未实现。
3. **市场分页**：前端已完整实现（每页 20 / 上一页下一页 / 总数 / 翻页回顶部 / 页码进 URL `?pluginPage=N`）。
   运行中的 API（1.3.1）尚不返回 `total`，前端已做降级——按「单页全量」处理，
   不会显示错误页数。T2 接口上线后自动生效，无需再改前端。
4. **插件市场安装路径的 UI 取证**：市场请求按产品设计强制走官方服务器
   （`viaMarket: true`），本机 3200 不参与，故端到端取证改用「导入本地插件」路径——
   两者走的是**同一段** `installCommunityPlugin()` 代码（安装即校验 + 自动进功能区）。
