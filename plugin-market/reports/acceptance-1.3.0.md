# Neo MD 1.3.0 插件商店 50 款 · 验收报告

- 验收日期：2026-10-30
- 验收对象：插件商店「50 款日常与协作插件套件」
- 版本：1.3.0（tag `v1.3.0`，commit `d575916`）
- 生产环境：https://md.zhengl.vip（站点 id 47，Node 24.14.1，端口 3200）
- 生产数据库：MySQL `neomd.community_plugins`

---

## 一、结论

| 验收项 | 结果 |
| --- | --- |
| 插件实现完整性 | **50 / 50** |
| 校验器 6 类门禁 | **50 / 50 通过，0 警告** |
| 宿主真实执行路径（`new Function`） | **50 / 50 通过** |
| 浏览器内真实执行（生产域名） | **50 / 50 通过** |
| 校验器红队反证 | **9 / 9 通过** |
| 本地 API 端到端冒烟 | **5 / 5 通过** |
| 生产数据库上架 | **50 / 50 published** |
| 生产前端部署 | **已上线并验证** |
| GitHub 推送（含 tag） | **已完成** |

**总判定：通过。** 50 款插件已在生产插件商店上架，用户可浏览、一键安装、在命令面板执行。

---

## 二、插件清单（50 款，5 组）

### 分组 1 · 日常使用 · 时间与日志（01–10）
01 每日站会日志 · 02 日终复盘 · 03 时间块规划 · 04 番茄钟台账 · 05 本周计划看板 ·
06 周报摘要 · 07 月度归档清单 · 08 截止日期登记表 · 09 连续打卡追踪 · 10 今日聚焦简报

### 分组 2 · 日常使用 · 写作与整理（11–20）
11 字数仪表盘 · 12 待办进度条 · 13 标题自动编号 · 14 目录重建 · 15 有序列表重编号 ·
16 空行与行尾清理 · 17 金句摘录卡 · 18 分隔线规范化 · 19 强调与符号规范 · 20 表格对齐整理

### 分组 3 · 日常任务 · 协作会议（21–30）
21 已完成任务归档 · 22 任务优先级排序 · 23 待办截止日扫描 · 24 今日待办聚焦 · 25 检查清单模板 ·
26 会议纪要简报 · 27 议程生成器 · 28 行动项汇总 · 29 决策记录 · 30 复盘四象限

### 分组 4 · 协作 · 评审与复盘（31–40）
31 代码评审清单 · 32 变更说明模板 · 33 发布检查清单 · 34 测试计划模板 · 35 风险登记表 ·
36 路线图时间线 · 37 缺陷报告模板 · 38 更新日志条目 · 39 故障复盘报告 · 40 文档评审轮次

### 分组 5 · 协作 · 分派与交付（41–50）
41 负责人看板 · 42 RACI 责任矩阵 · 43 联系人卡片 · 44 交接文档模板 · 45 项目状态周报 ·
46 团队术语表 · 47 项目启动简报 · 48 任务催办清单 · 49 分享摘要卡片 · 50 同步简报

---

## 三、质量门禁明细

### 3.1 校验器 `plugin-market/validate.mjs`（6 类，50/50）

| 类别 | 内容 |
| --- | --- |
| A 文件 | 命名 `NN-<id>.js`、≤12KB、LF、末尾换行、文件头注释含编号与 id |
| B 静态 | 单一 `export default`、单一 `registerCommand`、禁用标识符、`api.*` 白名单、无 import |
| C 契约 | 源码 `id`/`name`/`version`/`commandId`/`commandTitle` 与 `PLAN.json` 逐字一致 |
| D 运行 | 五类样本文档（富文/空/最小/纯代码块/大文档）均不抛异常、`notify` 恰好一次 |
| E 幂等 | `section` 与 `inplace` 模式连续两次执行结果逐字节一致 |
| F 结构 | `section` 标记 `<!-- nm:id -->` / `<!-- /nm:id -->` 成对且唯一 |

执行结果：`合计 50 款：通过 50 · 失败 0 · 警告 0`

### 3.2 宿主真实执行路径 `plugin-market/host-runtime-test.mjs`（50/50）

复刻 `EditorPage.vue` 的真实加载方式：

```js
const cleaned = codeJs.replace(/^\s*export\s+default\s+/m, 'return ');
const factory = new Function(cleaned);
const mod = factory();
mod.setup(hostApi);
```

对 50 款逐条验证：导出 `id`/`name` 与契约一致、`notify` 恰好一次、非 `append` 模式幂等、
不破坏 frontmatter 与正文（非空行数不低于原文 80%）。

执行结果：`合计 50 款：通过 50 · 失败 0`

### 3.3 红队反证 `plugin-market/selftest/run.mjs`（9/9）

| 场景 | 是否被抓到 |
| --- | --- |
| 源码出现 `fetch(` | ✅ |
| 注册 2 个命令 | ✅ |
| `section` 模式不幂等 | ✅ |
| 文件 > 12KB | ✅ |
| `run()` 抛异常 | ✅ |
| id 与 PLAN 不一致 | ✅ |
| 调用 `api.save(...)` | ✅ |
| 只有 BEGIN 标记没有 END | ✅ |
| 正式校验器对合格样例判 PASS | ✅ |

红队同时发现校验器 2 处真实漏检，**已修复**：
1. `axios` / `EventSource` / `sendBeacon` / `indexedDB` / `FileReader` / `Worker` / `Blob` / `URL.createObjectURL` 未在禁用表中 → 已补齐；
2. `api?.save?.('x')` 与 `api['save']()` 可绕过白名单正则 → 已改为兼容 `.` / `?.` / `[]` 三种写法，并对动态下标访问显式报错。

修复后回归：`自检完成：9/9 项通过`，正式校验器仍 `50/50`。

---

## 四、发现的真实缺陷与修复

### 缺陷（生产级，会影响全部插件）

`apps/web/src/views/EditorPage.vue` 的 `runCommunityPlugin` 使用：

```js
const cleaned = item.codeJs.replace(/^\s*export\s+default\s+/, 'return ');
```

该正则**没有 `m` 标志**，只能匹配「文件第一行就是 `export default`」。而按官方
`PLUGIN_DEVELOPMENT_GUIDE.md` 推荐的写法（含文件头注释）以及插件市场里的实际数据，
`export default` 都在注释之后。于是替换不生效，`new Function` 抛：

```
SyntaxError: Unexpected token 'export'
```

用户点击任何插件命令只会看到「插件执行异常」。经核查，**生产 bundle 中确实存在该缺陷写法**：

```
EditorPage-*.js: replace(/^\s*export\s+default\s+/,"return ")
```

本任务的 50 款插件全部带文件头注释，若不修复则 100% 不可用。

### 修复

新增 `normalizePluginSource()`：

- 改为 `/^\s*export\s+default\s+/m` 多行匹配；
- 增加一次兜底替换（应对 `export default` 出现在非行首的极端写法）；
- 先剥离 BOM；
- 对已是 `return {...}` 函数体的历史脚本保持幂等。

### 验证

| 阶段 | 结果 |
| --- | --- |
| 修复前走宿主路径 | 50 款全部 `SyntaxError` |
| 修复后本地宿主路径测试 | 50/50 通过 |
| 生产 bundle 校验 | `旧缺陷正则=false | 多行标志=true | 兜底替换=true` |
| 生产页面内真实执行 | 50/50 通过 |

---

## 五、部署记录

### 5.1 前端

| 项 | 值 |
| --- | --- |
| 产物 | `neomd-web-dist-1.3.0-final.tar.gz` |
| sha256 | `d6c5a16a…5244a`（上传校验 `expected_sha256_matched: true`） |
| 部署路径 | `/www/wwwroot/md.zhengl.vip/public` |
| 备份 | `public.prev2-20261030-184836`、`public.prev-20261030-182747`、`public.old` |
| 入口 | `/assets/index-Cwguy_cf.js` |
| 校验 | `nginx -t` 通过，`reload` 成功，线上 `EditorPage-C4uVuB3W.js` 含修复 |

### 5.2 插件数据

| 项 | 值 |
| --- | --- |
| 入库方式 | `deploy/seed-prod.mjs`，`INSERT ... ON DUPLICATE KEY UPDATE`（幂等） |
| 预演 | 50/50 ✅（`--dry-run`） |
| 正式 | 成功 50 · 失败 0 |
| 表内总数 | 53（50 款新增 + 3 款官方示例） |
| 状态 | 全部 `published`，`version=1.0.0`，字段完整性异常 0 条 |

### 5.3 端到端冒烟

`deploy/local-smoke.mjs` 对本地 API（3210，连生产库）：

| 用例 | 结果 |
| --- | --- |
| 1 匿名 GET /api/plugins/market | PASS（基线 3） |
| 2 逐条发布 / 更新（50 款） | PASS（新建 50 · 更新 0 · 失败 0） |
| 3 市场复核 50 款齐全 | PASS（市场 53 条，缺失 0） |
| 4 下载回取 sha256 比对 | PASS（一致 50 · 不一致 0） |
| 5 负向校验（超短代码 / 缺简介） | PASS（均 400） |

---

## 六、Git

| 项 | 值 |
| --- | --- |
| commit | `d575916` feat(1.3.0): 插件商店 50 款日常与协作插件 + 宿主执行路径修复 |
| 变更规模 | 93 files changed, 9123 insertions(+), 10 deletions(-) |
| tag | `v1.3.0`（annotated） |
| 远程 | `origin/main` 已同步至 `d575916`，tag 已推送 |

提交时工作树存在其他并行会话的改动（分屏配色、flex 布局、编辑器相关），
本提交通过 `tools/stage-plugin-hunk.mjs` **只把插件修复写入索引**，
其余并行改动未被一并提交；已用 `tools/verify-staged-editorpage.mjs` 与
`tools/verify-staged-build.mjs` 校验索引内容不含他人改动且可编译。

---

## 七、仓库全量回归

| 项 | 结果 |
| --- | --- |
| `tsc -b` 类型检查 | 0 错误 |
| `vitest run` 单元测试 | 236 / 236 通过（9 个文件） |
| Vite 生产构建 | 成功，7 秒内完成 |

---

## 八、可复跑的验收命令

```bash
# 插件规格与一致性（50/50）
node plugin-market/validate.mjs

# 宿主真实执行路径（50/50）
node plugin-market/host-runtime-test.mjs

# 校验器红队反证（9/9）
node plugin-market/selftest/run.mjs

# 构建发布产物
node plugin-market/deploy/build-artifacts.mjs

# 本地/预发端到端冒烟（需要凭据）
node plugin-market/deploy/local-smoke.mjs --base http://127.0.0.1:3210 --token-file <path>

# 线上产物校验
node plugin-market/deploy/verify-online-build.mjs <下载的 EditorPage chunk>
```

---

## 九、已知限制

1. 插件一律不使用网络/DOM/异步，因此不具备「在线搜索」「弹窗表单」类能力；
   需要这些能力的插件属于下一阶段（宿主需扩展 SDK）。
2. `append` 模式按设计不幂等（每次插入一份新模板），用户重复执行会产生多份，
   这是模板类插件的预期行为，已在 SPEC 中明确。
3. 插件市场沿用既有 200 条上限的列表接口，本次 53 条远未触顶；未来超过 200 款时
   需为市场页加分页。
4. 生产 `md.zhengl.vip` 的 HTTPS 证书由站点级配置提供，本次未改动证书。
