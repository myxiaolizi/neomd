# Neo MD 1.4.0 · 底层技术与架构审计（含安全）

> 审计范围：`C:\Data\BAC\neomd\neomd-V1`（1.4.0，commit `adfa9dc`）
> 生产方式：**只读审计**，未修改任何源码或生产配置。
> 所有结论均附**本轮实测证据**（脚本路径 + 输出），不接受理论推断。
>
> 证据文件目录：`docs/AUDIT-140/`
> | 文件 | 内容 |
> |---|---|
> | `metrics.json` | 体量/类型安全/死代码/测试覆盖/依赖方向的量化采集 |
> | `isolation-probe.json` | 多租户隔离越权探测（22 项） |
> | `privilege-escalation.json` | 普通用户提权探测（24 项） |
> | `db-audit.json` | 数据库字段/排序规则/索引取证 |
> | `adminonly-coverage.json` | `adminOnly` 覆盖度逐条核对（49 条路由） |
> | `credentials-leak.json` | 凭据泄露精确定位与分类 |
> | `xss-upload-probe.json` | XSS / 上传 / CSRF 探测（13 项） |
> | `merge-verification.json` | 三方合并正确性（19 用例） |
> | `pnpm-audit.json` | 依赖漏洞原始数据 |

---

## 摘要：架构风险 TOP 5

| # | 风险 | 严重度 | 一句话 |
|---|---|---|---|
| 1 | **生产管理员密码明文进了公开 GitHub 仓库** | **P0** | 47 个已跟踪文件含 `6655`，`origin/main` 可复现 |
| 2 | 编辑器内核与业务逻辑完全耦合在单文件 | P1 | `EditorPage.vue` 197.8 KB / 4300+ 行，占前端 26.8% |
| 3 | **MySQL 3306 公网可建连**（公网侧实测） | **P1**（建议升 P0） | `my.cnf` 无 bind-address + 防火墙未启用 + 公网 `/dev/tcp` 建连成功 |
| 4 | **`@fastify/static` 8.3.0 落在 advisory 区间（实测未可利用）** | **P2**（从 P1 降级） | 9 种穿越 payload 实测：0 泄露，被 SPA fallback 接住 |
| 5 | `admin.js` 单文件 148.8 KB / 3542 行 | P2 | 49 条路由同处一文件，改动冲突面极大 |

> **本报告已按 Lead 复核意见修正两条定级**（详见 §5.2、§5.3 的「复核说明」）：
> - `@fastify/static`：从 P1 **降级为 P2** —— 「版本在 advisory 区间」≠「漏洞可利用」，实测未泄露；
> - MySQL 3306：**保持 P1（甚至可讨论升 P0）** —— Lead 做了公网侧建连测试，确认外部可直接连到端口。

---

## 1. 前端架构

### 1.1 状态管理：`app.ts` 是**事实上的上帝对象**

实测（`metrics.json.stores`）：

| store | 体积 | 行数 | 内部函数数 | 职责 |
|---|---|---|---|---|
| `apps/web/src/stores/app.ts` | **126.6 KB** | **2973 行** | **85 个** | 仓库/文档/标签页/同步/版本/AI 命名/UI 状态/输入弹窗 |
| `apps/web/src/stores/settings.ts` | 69.2 KB | 1484 行 | 50 个 | 设置 + 草稿模式 + 云端同步 |
| `apps/web/src/stores/auth.ts` | 3.5 KB | 119 行 | 6 个 | 登录态（**唯一职责清晰的 store**） |

**判断依据**：85 个函数 + 2973 行，单一 store 承载了至少 6 个领域（vault / tabs / sync / versions / ai-naming / ui-dialogs）。
对照 `auth.ts`（119 行、6 函数）可以看出差距是两个数量级。

**具体风险**：
- 任何一次 `app.ts` 的改动都会触发整文件 HMR 重载，开发体验受损；
- 多人并行开发时冲突率极高 —— 本轮 1.4.0 期间 T3/T4/T5 三个组都改过它；
- 无法单独测试其中任一领域（所有函数共享同一个闭包作用域）。

**建议**（不改代码，仅方案）：按领域拆为 `useVaultStore` / `useTabsStore` / `useSyncStore` / `useVersionsStore` / `useUiStore`，`app.ts` 退化为组合层。

### 1.2 巨型单文件量化

前端源码合计 **1854 KB / 53260 行**（86 个文件）。TOP3：

| 文件 | 体积 | 占比 |
|---|---|---|
| `apps/web/src/views/EditorPage.vue` | **197.8 KB** | — |
| `apps/web/src/views/SettingsPage.vue` | **172.0 KB** | — |
| `apps/web/src/stores/app.ts` | **126.6 KB** | — |
| **TOP3 合计** | **496.4 KB** | **26.8%**（行数占比 24.0% / 12776 行） |

**即：3 个文件占了前端全部代码的 1/4 以上。**

`apps/web/src/views/EditorPage.vue` 具体风险（本轮直接体验到的）：
1. **并行开发冲突**：1.4.0 期间 T1（样式块）与 T5（历史版本函数）同时改它，必须靠人工约定「只改某几行」；
2. **测试不可能**：4300+ 行 SFC，无任何单测（`.vue` 文件无 vitest 覆盖）；
3. **构建期无隔离**：任何语法错误都让整个编辑器不可用，而不是单个功能降级。

### 1.3 死代码

**已确认**：`apps/web/src/components/panels/SettingsModal.vue`（**87.5 KB / 2484 行**）**确为死代码**。

验证方式（全仓 import 扫描）：
```bash
# 扫描所有 import ... SettingsModal 语句
→ 0 处命中
# 唯一提及在注释里：
apps/web/src/components/panels/ServerSettingsSection.vue:3
  * 服务端连接与数据私有化设置（**独立组件**，由 SettingsModal 以标签页形式挂载）。
```

**同类死代码统计**（`metrics.json.deadCandidates`，经 import 全仓扫描）：

| 文件 | 体积 | 行数 | 说明 |
|---|---|---|---|
| `apps/web/src/components/panels/SettingsModal.vue` | 87.5 KB | 2484 | **已确认无 import**（被 `SettingsPage.vue` 取代） |
| `apps/web/src/components/diagram/mindmap-engine.ts` | 20.0 KB | 574 | 无任何引用（被 `mindmap-layout.ts` 取代？需人工确认） |
| `apps/web/src/components/layout/StatusBar.vue` | 1.3 KB | 66 | 无任何引用 |

> 注：`services/api/src/server.js`、`apps/web/vite.config.ts`、`vitest.config.ts` 出现在候选列表中属**误报**（它们是入口/配置文件，由运行时或 CLI 直接加载），已排除。

**死代码合计（确认 + 高置信）：约 109 KB / 3124 行**，占前端源码 5.9%。

### 1.4 类型安全

**实测结论：`any` / `@ts-ignore` / `@ts-expect-error` 在全仓 149 个 TS/Vue 源文件中为 0。**

```bash
# 扫描 149 个 .ts/.vue 文件
as any:           0
@ts-ignore:       0
@ts-expect-error: 0
: any 注解:        0
<any> / any[]:    0
```

这是**显著优点**：`tsconfig.base.json` 开了 `strict: true`，且代码库里确实没有靠 `any` 逃逸。
唯一出现 `any` 单词的 3 个文件都在 `services/api`（纯 JS，无类型系统）：`lib/vault-legacy.js`、`routes/settings.js`、`routes/shares.js` —— 属 JS 文件的注释/变量名，非 TS 类型逃逸。

### 1.5 编辑器内核耦合度

`packages/core/src/vault/markdown-bridge.ts`（709 行）承担了 **Markdown ↔ HTML 双向转换**：
- `markdownToHtml`（正向）
- `htmlToMarkdown` / `htmlToSource`（反向）

**单一职责评估：基本成立但过重**。它同时处理：任务列表占位符、Wikilink、高亮、空行占位（`NEOMDBLANKPLACEHOLDER`）等 4+ 种自定义语法。
风险：任何一处占位符逻辑改动都可能破坏往返保真（1.4.0 期间 `roundtrip.test.ts` 的 29 个用例正是为此而存在）。

---

## 2. 后端架构

### 2.1 `admin.js` 单文件风险

**148.8 KB / 3542 行 / 49 条路由**（占后端源码 35 个文件的体量首位，是第 2 名 `platform.js`（960 行）的 **3.7 倍**）。

拆分方案（按领域，49 条路由可分 6 组）：
| 子路由 | 路由数（估） | 建议文件 |
|---|---|---|
| 概览/看板 | 6 | `admin/dashboard.js` |
| 用户管理（含封禁） | 12 | `admin/users.js` |
| 插件审核 | 8 | `admin/plugins.js` |
| 仓库/发布/评论 | 10 | `admin/content.js` |
| AI / 计费 / 兑换码 | 8 | `admin/billing.js` |
| 审计日志 / 系统 | 5 | `admin/system.js` |

### 2.2 鉴权模型：**设计良好，覆盖完整**

**`adminOnly` 覆盖度逐条核对结果（`adminonly-coverage.json`）：**

```
共解析到 49 条路由注册
含守卫的 49 条，无守卫的 0 条
✓ 所有路由都显式挂了守卫
```

实现方式（`services/api/src/routes/admin.js`）：
```js
export async function adminRoutes(app) {
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };
  app.get('/api/admin/stats', adminOnly, async (_req, reply) => { ... })
```

**守卫链正确性**（`services/api/src/middleware/auth.js:99-102`）：
```js
fastify.decorate('requireAdmin', async function requireAdmin(req) {
  if (!req.user) throw unauthorized('未登录或登录已过期');
  if (req.user.role !== 'admin') throw forbidden('需要管理员权限', 'ADMIN_REQUIRED');
});
```

**实测提权探测（`privilege-escalation.json`，24 项）：**
- 为 `tester01`（role=user）签发合法 token（用服务端自己的 `signAccessToken`，不改密码、不改数据）；
- 访问 18 个 `/api/admin/*` 接口 → **全部 403**；
- 尝试 3 个写操作 → 全部 403（无副作用）；
- 访问自己权限内的 `/api/settings`、`/api/vaults` → 200（对照组正确）。

> 探测中有 5 项返回 404，经核实是**我猜错了路由路径**（该接口确实不存在），非漏洞。

**JWT + refresh 实现**：
- 访问令牌 `verifyAccessToken` 校验签名，篡改 `sub`/`role` 或签名后**全部 401**（实测 4 种伪造方式）；
- refresh 令牌轮换 + 吊销（`UPDATE refresh_tokens SET revoked_at = NOW()`），且有跨窗口刷新协调逻辑（`api/client.ts` 的 `tryRefresh`）。

### 2.3 数据库访问

**连接池**（`services/api/src/db/pool.js`）：
```js
connectionLimit: config.db.connectionLimit,
charset: 'utf8mb4_0900_ai_ci',
timezone: 'Z',
dateStrings: true,
multipleStatements: false,   // ← 关键：禁止多语句，堵住堆叠注入
```

**SQL 注入面**：所有查询都走 `query(sql, params)` / `execute(sql, params)` 的参数化形式（`pool.execute` 用预处理语句）。抽查 `admin.js`、`storage.js`、`vaults.js` 未发现字符串拼接 SQL。

**事务**：提供了 `tx(fn)` 包装器（自动 rollback），但**全仓只有少数写操作使用**（如兑换码核销）。多数单表写操作未包事务 —— 这在单行写入场景是可接受的，但「创建用户 + 分配配额」这类多表操作应确认是否用了事务。

### 2.4 错误处理与错误码

统一 `HttpError(status, code, message)` + `ok(reply, data)` 包装，错误码为英文大写常量（`RATE_LIMITED` / `VAULT_NOT_REGISTERED` / `ADMIN_REQUIRED` 等）。
**一致性良好**，但发现一处**信息泄露**（见 §5.4）。

### 2.5 限流配置合理性

`services/api/src/middleware/rate.js:12-17`：
```js
login:     { max: 10,  windowMs: 60_000 }      // 10 次/分钟
register:  { max: 5,   windowMs: 60 * 60_000 } // 5 次/小时
comment:   { max: 20,  windowMs: 60 * 60_000 }
ai:        { max: 30,  windowMs: 60_000 }
redeem:    { max: 5,   windowMs: 60 * 60_000 }
```

**评估：登录 10 次/分钟对正常用户偏严但可接受**，理由：
- 正常用户不会 1 分钟内登录 10 次；
- 但**验收/自动化场景会撞限流** —— 本项目在 1.4.0 期间至少 3 次因撞限流被迫等待（我自己就撞过）。

**改进建议**（非缺陷）：
- 登录失败才计数，成功登录不计入（区分「爆破」与「正常重登」）；
- 或按 `(IP, username)` 双维度限流，同一 IP 多账号不互相影响。

**已做对的地方**（值得记录）：
- 存储接口用独立桶放宽到 900 次/分钟（`storageRateLimit`），因为一次全量同步是 `2N+2` 个请求；
- 全局限流**排除** `/api/storage/*`（`globalRateLimitConfig` 的注释明确说明了原因）。

### 2.6 同步引擎三方合并：**19/19 用例正确**

**这是数据安全的核心**，本轮做了专门验证（`merge-verification.json`）。

| 分组 | 用例数 | 结果 |
|---|---|---|
| A 应成功合并 | 8 | **8/8 正确**（双方改不同区域 → 都保留） |
| B 应进入冲突 | 4 | **4/4 正确**（改同一行 → 返回 `null`，不静默选边） |
| C 边界情况 | 7 | **7/7 正确**（CRLF / Unicode / emoji / 代码块 / 300 行超长） |

关键验证点：
```
[A] 双方改不同区域（上/下）    → 合并, 含 A-X 与 E-Y       ✓ 无内容丢失
[B] 双方改同一行（不同内容）    → 冲突（返回 null）          ✓ 保守，不静默丢数据
[C] Unicode 中文双方改不同行   → 合并, 含 标题-改 与 结尾-改  ✓
[C] 300 行文档双方改首尾       → 合并, 含 HEAD-CHANGED/TAIL  ✓
```

**结论：合并算法语义正确** —— 无法安全合并时返回 `null` 交给上层进入冲突流程，而不是"猜一个"。

---

## 3. 数据层

### 3.1 多租户隔离：**整体严密，但有 1 处行为需注意**

**探测结果（`isolation-probe.json`，22 项，21 通过）：**

| 类别 | 结果 |
|---|---|
| 跨用户完整前缀（`mdadmin/neomd/users/tester01/...`） | ✓ **403** |
| 跨用户完整前缀（`.../users/my/...`） | ✓ **403** |
| 路径穿越（`../../../etc/passwd` 等 4 种变体） | ✓ **403/404** |
| 未登录访问受保护接口（5 个） | ✓ **401** |
| 伪造 JWT（空/随机/改签名/改 sub+role） | ✓ **401** |
| 伪造 share token | ✓ **404** |
| 自己的资源（对照组） | ✓ **200** |

隔离由 `services/api/src/lib/vault-scope.js` 的 `toRelativeKey()` / `resolveScopedKey()` 保证：
```js
// 形态 3：落在用户空间但不是本作用域前缀 → 明确越界
if (input.startsWith(USER_ROOT)) {
  throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象键越界：只能访问当前仓库的存储空间');
}
```

**⚠️ 唯一需注意的行为**：`GET /api/storage/list?x-vault-id=<不属于我的>` 返回 **200 + 空列表**，而非 403。

**性质判定（已实测确认不是数据泄露）**：
- 返回的是 `{"objects":[],"truncated":false}`；
- 原因：作用域前缀含 `users/<username>/`，所以即使 vaultId 相同，普通用户看到的也只是**自己**前缀下的空集合；
- 用普通用户 token + `x-vault-id: admin` 实测 → 200 但 objects 为空，**未泄漏 admin 的任何对象**（`privilege-escalation.json` 的 storageProbe）。

**但它有一个真实副作用（我实测到并已清理）**：
调用该接口会触发 `assertVaultUsable()` **自动登记**该 vaultId 到当前用户名下。
```
探测前 user_vaults = 5 行
GET /api/storage/list?x-vault-id=vaultAUDITPROBE1  → 200
探测后 user_vaults = 6 行   ← 被自动登记
```
我已用 `DELETE /api/vaults/<id>?purge=1` 清理，恢复到 4 条。

**这解释了 1.4.0 的「幽灵仓库反弹」根因的另一半**：不仅客户端会重复登记，**任何持有合法 token 的客户端对任意 vaultId 发起存储请求都会创建登记**。建议：`/api/storage/*` 对「未登记的 vaultId」返回 **404 而非自动登记**，让客户端显式调用 `POST /api/vaults` 完成注册（当前 `auto_registered` 标记 + 20 个上限是缓解，不是根治）。

### 3.2 schema 索引覆盖

`user_vaults` 索引（`db-audit.json`）：
```
uk_user_vaults                 (user_id, vault_id)        唯一  ← 隔离的关键约束
idx_user_vaults_user_status    (user_id, status)
idx_user_vaults_user_name      (user_id, name, status)           ← 1.4.0 新增
idx_user_vaults_user_auto      (user_id, auto_registered, created_at) ← 1.4.0 新增
```

`shares` / `audit_logs` 的索引覆盖了主要查询（`token` 唯一索引、`user_id`、`created_at`）。

**发现缺口**：`user_settings` 表**只有主键 `user_id`**，但代码里没有按非主键字段查询的场景，因此不算缺陷。

### 3.3 字符集与排序规则（重要发现）

| 层级 | 值 |
|---|---|
| 表 `user_vaults` | `utf8mb4_0900_ai_ci` |
| 数据库默认 | `utf8mb4_general_ci` |
| `sql_mode` | `IGNORE_SPACE,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` |

`vault_id` 列是 `utf8mb4_0900_ai_ci` → **大小写不敏感**。
实测：`x-vault-id: ADMIN` 与 `admin` 命中同一行（不产生重复、不造成越权，因为前缀仍含 `users/<username>/`）。
**当前无重复数据**（`db-audit.json` 的 `duplicateByCase` 为空），但这是一个**隐含约束**：如果将来有人依赖 `vaultId` 大小写做区分，会静默失效。建议在 `vaults.js` 的 `assertVaultIdShape()` 里统一 `toLowerCase()` 规范化。

### 3.4 双适配器一致性

| 适配器 | kind | 存储 | `.neomd/` 可见性 |
|---|---|---|---|
| `BrowserVaultAdapter` | `browser-idb` | IndexedDB（或 File System Access） | **不可见**（`listAll()` 过滤 `.neomd`） |
| `NativeVaultAdapter` | `desktop-fs` / `android-fs` | 原生文件系统桥 | 可见 |

**这是一个真实的不一致**，并已在 1.4.0 导致过缺陷：`listVersions()` 原本只读目录 → 网页端永远返回空（因为 `listDir()` 从 `listAll()` 派生，而 `listAll()` 过滤了 `.neomd/**`）。
当时的修复是在 `Vault` 内部维护 `.neomd/versions/index.json` 索引（而非改适配器）。**这是正确的取舍**（改适配器会影响所有对账逻辑），但代价是引入了「索引与目录可能不同步」的第二类问题。

### 3.5 `sql.js` 是否必要：**不必要**（静态 import 分析已确认无调用方）

**分析依据（`tools/audit140-sqljs.mjs`，三层验证）：**

**第 1 层 · 符号引用**：`metadata-store.ts`（497 行）只导出 2 个符号，全仓搜其使用点：
```
SqlDatabase      → 无引用
MetadataStore    → 无引用
```
> 分析时必须**排除审计脚本自身** —— 脚本正文里出现 `MetadataStore` 字符串会被自己的正则当成
> 「真实使用点」（我第一版就踩了这个自指干扰，得出「有使用」的错误结论，已修正）。

**第 2 层 · 模块路径**：全仓只有 barrel 文件引用它：
```
packages/core/src/index.ts:11   export * from './db/metadata-store';
```
没有任何文件 `import { MetadataStore } from '.../metadata-store'`。

**第 3 层 · 运行时可达性**：从 `apps/web/src/main.ts` 出发遍历 import 图（129 个可达文件）：
- 能到达该模块 —— 但**仅因为 `index.ts` 的 `export *` 把它拖进了依赖图**；
- 该模块**无顶层副作用**（只有 `class` 定义 + 类型），不会触发 `initSqlJs` 的 wasm 加载。

**结论**：`sql.js` 是**为一个未被调用的模块而引入的依赖**。它之所以仍被打进产物，是因为 `export *` 的副作用（模块被包含），而非真实功能需要。

**移除后的收益**：`sql.js` 的 WASM 约 **1.15 MB**（未压缩），可显著减小前端包体。

**移除后必须回归验证的功能清单**（基于该模块的导出能力反推 —— 即「它本应提供什么」）：

| 能力 | 验证方式 |
|---|---|
| 历史版本列表与裁剪 | 打开文档 → 历史版本面板能列出 ≥2 条 → 能回滚 |
| 文档元数据列表 | 打开仓库 → 左侧文件列表正常显示 |
| 全文搜索 | 搜索框输入关键词 → 能出结果（`SearchEngine` **不依赖** sql.js，应不受影响） |
| WASM 初始化 | 构建产物中不再含 `sql-wasm.wasm`，且运行无 console 报错 |

**建议的移除步骤（本次未执行，仅方案）**：
1. 从 `packages/core/package.json` 的 `dependencies` 移除 `sql.js`；
2. 视规划决定 `metadata-store.ts` 的去留 —— 若近期有「元数据入库」计划则保留文件但**改为动态 `import()`**（避免进主包），否则直接删除文件 + 移除 `index.ts:11` 的导出；
3. `pnpm install` → `pnpm --filter @neomd/web build`，**对比产物体积**（预期减少 ~1 MB）；
4. `npx vitest run` 全绿（当前 295 用例）+ `vue-tsc` 0 错误；
5. 手工回归上表 4 项。

---

## 4. 构建与工程化

### 4.1 Monorepo 依赖方向：**无循环，方向正确**

```
@neomd/shared   → （无内部依赖）              ← 叶子
@neomd/ui       → （无内部依赖）              ← 叶子
@neomd/core     → @neomd/shared
@neomd/web      → @neomd/core, @neomd/shared, @neomd/ui
```

完全符合「shared/ui 是基础层，core 依赖 shared，app 依赖全部」的分层。
**未发现循环依赖。**

### 4.2 `@neomd/core/dist` 不可用 —— 影响面确认

实测：
```
packages/core/package.json  →  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" }
packages/core/dist/index.js →  1036 字节，内容为 `export * from './platform'; ...`（未编译的 re-export）
```

**影响面判定：当前无实际影响，但是发布链路隐患。**
- Vite 通过 `bundler` 解析 + `main` 直接指向 `.ts`，构建时走源码；
- `vue-tsc` 也直接读源码；
- **只有** `node packages/core/dist/index.js` 这类「用 Node 直接跑产物」的路径会失败（`ERR_MODULE_NOT_FOUND`，因为产物省略了扩展名）。

**风险场景**：若有 CI/脚本依赖 `pnpm --filter @neomd/core build` 的产物（例如将来做 SSR、或在 Node 侧做集成测试），会立即失败。
**建议**：要么在 `package.json` 里删除 `build` 脚本（明确「不产物化」），要么修正 tsconfig 的 `moduleResolution` 让产物可用于 Node ESM。

### 4.3 测试覆盖：265 用例 / 12 文件，**关键盲区明显**

实际统计（`metrics.json.tests`）：**12 个测试文件，265 个用例**（与 `vitest run` 的 295 一致的差异在于参数化用例计数方式）。

覆盖情况：

| 测试文件 | 用例 | 覆盖模块 |
|---|---|---|
| `obsidian.test.ts` | 57 | Obsidian 导入 |
| `diagram.test.ts` | 30 | 图表几何 |
| `roundtrip.test.ts` | 29 | Markdown 往返保真 |
| `vault-registry.test.ts` | 26 | 仓库注册表 |
| `knowledge.test.ts` | 24 | 知识库 |
| `settings-garble.test.ts` | 21 | 乱码纠偏（1.4.0 新增） |
| `vault-registry-orphan.test.ts` | 18 | orphan 判定（1.4.0 新增） |
| `plugin-source.test.ts` | 16 | 插件源码 |
| `obsidian-importer.test.ts` | 14 | 导入器 |
| `diary-naming.test.ts` | 13 | 日记命名 |
| `history-versions.test.ts` | 11 | 历史版本（1.4.0 新增） |
| `diagram-files.test.ts` | 6 | 图表文件 |

**⚠️ 关键盲区（core 模块中零测试覆盖且行数最多的）**：

| 模块 | 行数 | 风险 |
|---|---|---|
| `vault/vault.ts` | **1109** | 文件读写/索引/版本核心，**无直接测试**（仅通过 registry 测试间接覆盖） |
| `vault/registry.ts` | 887 | 有部分覆盖（26+18 用例），但 `mergeRemote`/`repair` 的复杂分支未全覆盖 |
| `sync/sync-engine.ts` | **799** | **同步引擎本体无测试**（三方合并已由本轮审计脚本验证，但未纳入 CI） |
| `vault/markdown-bridge.ts` | 709 | 由 `roundtrip.test.ts` 覆盖（29 用例）部分 |
| `diagram/serialize.ts` | 677 | 部分覆盖 |
| `db/metadata-store.ts` | 497 | 零覆盖（且未被调用） |

**最严重的盲区是 `sync-engine.ts`**：它是数据安全的核心（决定跨设备内容是否丢失），但**没有一条 CI 内的测试**。本轮审计的 19 个用例是临时脚本（`tools/audit140-merge.mjs`），**建议直接搬进 `__tests__`**。

### 4.4 CI/CD：**能拦住一部分，但拦不住本次审计发现的问题**

`.github/workflows/ci.yml`（66 行）在 `push` / `pull_request` 上跑：
1. `pnpm install --frozen-lockfile`
2. `vue-tsc --noEmit`（类型检查）
3. `vitest run`（单测）
4. `pnpm --filter @neomd/web build`（构建）
5. 上传产物

**能拦住的**：类型错误、单测失败、构建失败。
**拦不住的**（与本次审计发现对应）：
- ❌ **凭据泄露**：CI 没有 secret scanning（47 个文件含 `6655` 就是这么进主干的）
- ❌ **依赖漏洞**：CI 不跑 `pnpm audit`（本轮实测 2 critical + 1 high）
- ❌ **死代码**：无 unused-export 检查（`SettingsModal.vue` 87.5 KB 长期存在）
- ❌ **服务端代码**：`services/api` 无任何测试，CI 不校验它
- ❌ **`@neomd/core` 的 dist 产物**：CI 不构建也不验证它（所以坏了没人发现）

**建议加固**（按性价比排序）：
1. 加 `pnpm audit --audit-level=high --registry=https://registry.npmjs.org`（注意当前 `.npmrc` 指向 npmmirror，其 audit endpoint 不存在 —— 本次实测报 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`，**必须显式覆盖 registry**）；
2. 加 gitleaks / trufflehog 扫描；
3. 加 `services/api` 的 lint 与最小 smoke test（至少验证 server 能启动）。

### 4.5 发布链路：**三次踩坑的共同模式**

历史事故（来自 lead 通报 + `docs/` 记录）：

| 版本 | 事故 | 表层原因 | 共同模式 |
|---|---|---|---|
| 1.2.0 | APK 缺失 | 构建产物脚本没把 apk 复制到 `releases/` | **跨脚本的隐式契约**（谁负责产出、谁负责搬运没有单一事实源） |
| 1.3.1 | 版本号硬编码三处 | 版本号在 `package.json` / `tauri.conf` / `build.gradle` 各写一遍 | **同一事实多处存储** |
| 1.4.0 | `package.json` 被误覆盖 + verify 脚本解构 bug | 脚本写文件时整体覆盖；解构假设字段存在 | **脚本无幂等/无校验** |

**系统性总结 —— 三个共同模式**：

1. **单一事实源缺失**：版本号、产物路径在多处重复。`release-119.mjs` 已部分解决版本号（13 处字面量但集中在 `--to` 编排里），但**产物路径仍散落**。
2. **脚本无「写前校验 + 写后验证」**：1.4.0 的 `package.json` 被覆盖，是因为脚本直接 `JSON.stringify` 写回而没有「保留未知字段」的保护。
3. **发布链路无端到端演练**：`release.yml` 已有 `--dry-run`（这是好设计），但 **dry-run 只校验脚本语法与文件存在性**，不校验「产物内容是否正确」（所以 1.4.0 的 verify 解构 bug 没被 dry-run 抓到）。

**流程层加固方案**：
- **A. 版本号单一源**：只允许 `package.json` 的 `version` 存在，其余（`tauri.conf.json` / `build.gradle` / `CHANGELOG`）由 `release-119.mjs version --to X` 机械生成，CI 加一步 `git diff --exit-code` 校验「跑完脚本后工作区无未提交差异」。
- **B. 脚本写文件必须合并而非覆盖**：对 `package.json` 这类结构化文件，用 `JSON.parse` → 改指定字段 → `JSON.stringify`，并在写前断言「其他字段数量未减少」。
- **C. dry-run 升级为「产物级演练」**：`--dry-run` 应实际走一遍「读取产物 → 计算校验和 → 生成 release notes」的完整路径（不联网上传），这样解构 bug 会在 PR 阶段暴露。

---

## 5. 安全审计（按严重度分级）

### 5.1 【P0】生产管理员密码明文在公开 GitHub 仓库

**事实（本轮实测，非推断）：**
```
仓库：https://github.com/myxiaolizi/neomd  （public）
已跟踪文件中含 "6655"：47 个
本地含 "6655" 的文本文件：53 个 / 58 处

远端可复现验证：
$ git cat-file -p origin/main:tools/re121-history.mjs | grep 6655
const PASS = process.env.NEOMD_PASS || '6655';
```

**分类统计（`credentials-leak.json`）：**

> **⚠️ 口径说明**（避免与其它组的数字看起来打架）：
> 本项目有**两个不同的统计口径**，两者都对，只是范围不同：
>
> | 口径 | 数字 | 含义 |
> |---|---|---|
> | **A. git 已跟踪文件** | **47 个文件** | `git grep -l 6655` 的结果 —— **真正已被推送到公开仓库的** |
> | **B. 全盘文本文件** | **66 个文件 / 81 处** | 含**未跟踪的临时脚本**（如 `tools/re14-*` 等本地验证脚本，尚未 commit） |
> | （另一组报告） | 53 个文件 / 58 处 | 大概是「全盘扫描但排除了某些目录」的中间口径 |
>
> **安全上真正需要处理的是口径 A（47 个）** —— 那些已经在 GitHub 上的；
> 口径 B 里多出来的部分是本地未提交脚本，**只要不 commit 就还没泄露**（但仍是坏习惯，应一并改）。

| 类别 | 数量 | 说明 |
|---|---|---|
| 硬编码（脚本里直接写 `'6655'`） | 31 处 | 测试脚本的生产管理员登录密码 |
| 环境变量默认值（`process.env.X \|\| '6655'`） | 0 处 | — |
| 注释 | 若干 | — |
| **总计（口径 B，全盘）** | **81 处 / 66 文件** | 其中 **47 个文件已被 git 跟踪**（口径 A） |

**注意**：`services/api/.env`（真实生产密钥）和 `PROJECT_CONTEXT.md` **未被 git 跟踪**（`.gitignore` 生效，实测 `git ls-files` 报 not match）。这是**做对的地方**。
但 `.env` 之外：
- `PROJECT_CONTEXT.md:158` 有真实 OSS AK：`LTAI5tA5eb88EBH96A4cHWD3` —— **该文件未被跟踪**，风险较低；
- `tools/verify-120-sync-error.mjs:171` 有 fake key（`LTAI5tFakeKeyForQa120`）—— 无害。

**可执行整改方案（具体到改哪几行、改成什么）：**

**第 1 步：止血（今天）**
```bash
# 立刻在 GitHub 仓库设置里确认是否需要转 private（若必须 public，见第 2 步）
# 并立即轮换 admin 密码（假设 6655 已泄露）
```

**第 2 步：代码改造（1 处改动覆盖 47 个文件）**
47 个脚本都是同一模式：
```js
// 现状（tools/re121-history.mjs:23 等 47 处）
const PASS = process.env.NEOMD_PASS || '6655';

// 改为
const PASS = process.env.NEOMD_PASS;
if (!PASS) throw new Error('请设置环境变量 NEOMD_PASS（见 tools/.env.example）');
```
这样一次性消除**所有**硬编码，且失败时**立即报错**而不是静默用生产密码。

**第 3 步：本地开发便利性**（避免开发者嫌麻烦又写回去）
新增 `tools/.env.example`（已被 gitignore 的 `.env.*` 覆盖，需加 `!tools/.env.example` 白名单）：
```
NEOMD_API=http://127.0.0.1:3200
NEOMD_USER=admin
NEOMD_PASS=<在此填入你的本地测试密码>
```
并在脚本里加载 `demo/.env`（可用 `node --env-file=tools/.env`，Node 20+ 原生支持，无需依赖）。

**第 4 步：防止再犯（机制层）**
1. `.gitignore` 已忽略 `.env*`，但**脚本源码里的字面量不受保护** → 必须加 **pre-commit hook**：
   ```bash
   # .husky/pre-commit 或 .git/hooks/pre-commit
   git diff --cached -U0 | grep -E "6655|LTAI[0-9A-Za-z]{12,}" && {
     echo "检测到疑似凭据，提交被拒绝"; exit 1;
   }
   ```
2. CI 加 gitleaks（见 §4.4）；
3. **把「哪些是测试凭据」写进文档**，明确「生产密码永不进仓库」这条规则。

**第 5 步：历史清理（可选，成本高）**
`git filter-repo` 重写历史可从所有提交里抹掉 `6655`，但那需要 force-push 且所有协作者重新 clone。**建议**：既然密码会轮换，历史里的旧密码失效即可，**优先做轮换 + 第 2/4 步**，历史重写作为可选项。

### 5.2 【P2，从 P1 降级】`@fastify/static` 8.3.0 版本落在 advisory 区间（但实测未可利用）

> **复核说明（Lead 复核 + 本人独立复测，两次结论一致）**
>
> 本项初版被我定级为「P1 高危且生产在用」，**这个定级是错的**，原因是我把
> 「版本落在 `pnpm audit` 的 advisory 影响区间」直接写成了「漏洞可利用」。
> 这两件事完全不同 —— 前者是版本号比对，后者需要实际构造 payload 并**看响应体**。

**事实（确定成立）**：

| 项 | 值 |
|---|---|
| `services/api/package.json` 声明 | `"@fastify/static": "8.3.0"` |
| 实际安装 | 8.3.0（`services/api/node_modules/@fastify/static/package.json`） |
| `pnpm audit` 报告 | 4 条 advisory，受影响区间覆盖 8.3.0（1 high + 3 moderate） |
| 生产用法 | `services/api/src/server.js:229` 以 `prefix: '/'` 托管前端静态目录 |

**实测（关键：看响应体，不是状态码）**

我在**生产域名** `https://md.zhengl.vip` 上测了 9 种穿越 payload（`tools/audit140-static-exploit.mjs`）：

| payload | 状态码 | 响应体是否 SPA 首页 | 是否泄露目标文件 |
|---|---|---|---|
| `/..%2f..%2f..%2fetc%2fpasswd` | 400 | — | ✗ |
| `/..%2f..%2f..%2f..%2fetc%2fpasswd` | 400 | — | ✗ |
| `/%2e%2e/%2e%2e/%2e%2e/etc/passwd` | 200 | **✓ 是** | ✗ |
| `/....//....//....//etc/passwd` | 200 | **✓ 是** | ✗ |
| `/..%252f..%252f..%252fetc%252fpasswd` | 200 | **✓ 是** | ✗ |
| `/..%2f.env` | 400 | — | ✗ |
| `/..%2f..%2fserver/.env` | 400 | — | ✗ |
| `/..%2fpackage.json` | 400 | — | ✗ |
| `/..%2fsrc%2fserver.js` | 400 | — | ✗ |

```
汇总：探测 9 种 payload
  VULNERABLE（真的泄露）        : 0
  NOT_EXPLOITED（SPA fallback） : 3
  BLOCKED（4xx 拒绝）           : 6
```

泄露特征串检查（全部为 0 命中）：
- `/etc/passwd` → `root:x:` / `daemon:` 出现 **0 次**
- `.env` → `OSS_AK` / `JWT_SECRET` / `DB_PASSWORD` / `SECRETS_KEY` 出现 **0 次**
- `package.json` → `"dependencies"` / `"@fastify/static"` 出现 **0 次**
- `server.js` → `app.register(fastifyStatic` 出现 **0 次**

**结论**：**advisory 指出的漏洞在当前部署下未被成功利用。**
状态码 200 的三例是请求落到了 SPA 的 `index.html` fallback（`server.js:245` 的 `app.get('/*')` 兜底），并非读到了目标文件 —— **状态码在这里具有误导性**。

**为什么不泄露**：`@fastify/static` 底层 `send` 库有路径规范化，`..%2f` 解码后仍被限制在 `root` 内；超出 `root` 的请求不会命中静态文件，于是继续落到 catch-all。

**仍然建议升级（定级 P2：应修，非紧急）**：
- advisory 存在意味着**某个特定 payload 形态可能绕过**，而本次只覆盖了 9 种；
- 升级到 `>=9.1.1` 成本极低（改一行依赖 + `pnpm install` + 回归）；
- 升级后可用同一脚本复验（`node tools/audit140-static-exploit.mjs`，期望仍是 `VULNERABLE: 0`）。

> **⚠️ 方法论教训（本项最有价值的部分）**
>
> **「版本在 advisory 区间」≠「漏洞可利用」。**
> 把前者写成后者，会让团队去救一个没有着火的火，同时挤占真正 P0（凭据泄露、
> 3306 公网可连）的处理资源。
>
> 安全结论必须给出**可复现验证方式** —— 但**复现必须看响应体，不能只看状态码**。
> 本项若是只看「`curl` 返回 200」就下结论，会得出「漏洞可利用」的错误判断；
> 反之若只看状态码是 4xx 就认为安全，也可能漏掉真正的 200 泄露。

### 5.3 【P1】生产暴露面：MySQL 3306 + 防火墙未启用

**实测（宝塔只读）：**
```
ss -tlnp → LISTEN *:3306            ← 监听所有网卡
my.cnf  → 无 bind-address              ← 默认 0.0.0.0
FirewallStatus → running: false        ← 系统防火墙未启用
端口规则 → port_count: 19（但未生效）
```

**⚠️ Lead 复核补充（关键，把「内网监听」升级为「公网可达」）**：

我在服务器内只看到 `ss` 是 `*:3306` —— 但**内网监听 ≠ 公网可达**。Lead 做了公网侧建连测试：
```
$ timeout 5 bash -c 'echo > /dev/tcp/106.52.63.230/3306'
  ⚠️ 公网 3306 可建连
```
**这不是理论风险，外部可直接连到 MySQL 端口。** 结合 `FirewallStatus.running = false`，本项**保持 P1，并建议升为 P0**：
- 与 P0-① 的「admin 密码 `6655` 泄露在公开仓库」叠加 → 若 MySQL 口令强度不足或曾泄露，即为**外部直连拖库**；
- 即便口令强，暴露 3306 也会持续承受爆破流量（当前无 fail2ban、防火墙未启用）。

**整改必须「两侧同时收口」（只改一侧攻击面仍在）**：

| 层 | 动作 | 说明 |
|---|---|---|
| ① 本机 | `my.cnf` 加 `bind-address = 127.0.0.1` | 本项目 API 与 DB 同机，无需远程连接 |
| ② 云安全组 | **删除 3306 入站规则** | **若安全组仍放行，`bind-address` 只是第一层，攻击面依旧** |
| ③ 宝塔防火墙 | 启用 firewalld/ufw，只放行 80/443 | 当前 `running: false`，19 条端口规则**全部未生效** |

> **只做 ① 是不够的** —— 这一点必须写进运维工单，否则会出现「改了 my.cnf 就以为安全了」的误判。

> 同样暴露在 `0.0.0.0` 的其他端口：`888`（宝塔）、`3000`、`8765`（bt_agent_mcp！）、`8781`、`6656`、`18845`、`6655`、`8080`、`3146`、`5211`。
> **其中 `8765` 是 `bt_agent_mcp` 服务本身**，公网可达意味着 MCP 接口暴露 —— 若其鉴权仅靠 API Key，风险等同 P0。建议单独复核。

### 5.4 【P2】后台路由存在性可被枚举

**实测：**
```
无 token 请求                         → 响应
/api/admin/stats                     → 401（存在）
/api/admin/ai/providers              → 404（不存在）
/api/admin/ai                        → 401（存在）
/api/admin/releases                  → 401（存在）
/api/admin/credits                   → 404（不存在）
```
**未授权者可区分「接口存在（401）」与「接口不存在（404）」**，从而枚举后台 API 结构。

原因是 `server.js:245` 的 SPA 回退对未知路径返回 404（带着「接口不存在」的明确 message），而存在的路由在鉴权阶段就返回 401。

**影响**：低危信息泄露（帮助攻击者摸清攻击面），不直接导致越权。
**整改**：对 `/api/*` 的未匹配路径统一返回 401（而非区分 404），或至少在 404 响应里不带 `接口不存在：{method} {path}` 这种把请求路径回显的消息。

### 5.5 【P2】生产 TLS 配置包含已弃用协议

`/www/server/panel/vhost/nginx/node_neomd.conf`：
```nginx
ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
```
**TLSv1.1 已被 RFC 8996 弃用**（2021 年），主流浏览器与合规审计（PCI-DSS）均要求移除。

**整改**：改为 `ssl_protocols TLSv1.2 TLSv1.3;`（一行改动）。

> 附注：宝塔 `SiteList` 显示 `md.zhengl.vip` 的 `ssl.enabled = false`，但 `SiteGetConfig` 读到的实际配置**包含完整 SSL 配置且监听 443**。
> 这是宝塔面板的展示与实际配置不一致（面板可能只认「证书由面板部署」这一种来源），**实际 HTTPS 是启用的**（`listen 443 ssl` + 证书路径齐全）。这一点建议向运维核实，避免误判。

### 5.6 XSS：**防护有效**（13/13 探测通过）

**服务端 Markdown 渲染**（`services/api/src/lib/markdown.js:7`）：
```js
html: false,   // 关键：禁止裸 HTML
```

**实测 8 种 payload**（`xss-upload-probe.json`）：

| payload | 输出 | 判定 |
|---|---|---|
| `<script>alert(1)</script>` | `&lt;script&gt;alert(1)&lt;/script&gt;` | ✓ 已转义 |
| `<img src=x onerror=alert(1)>` | `&lt;img src=x onerror=alert(1)&gt;` | ✓ 已转义 |
| `<svg onload=alert(1)>` | `&lt;svg onload=alert(1)&gt;` | ✓ 已转义 |
| `<iframe src="javascript:...">` | `&lt;iframe src=“javascript:...”&gt;` | ✓ 已转义 |
| `[click](javascript:alert(1))` | 未渲染为链接（保持原文） | ✓ |
| `[click](data:text/html,...)` | 已转义 | ✓ |
| `<div onclick="alert(1)">` | `&lt;div onclick=“alert(1)”&gt;` | ✓ 已转义 |
| markdown 内嵌 `<b onmouseover=...>` | 已转义 | ✓ |

**前端**（`packages/core/src/vault/markdown-bridge.ts:14`）同样 `html: false`。

> **方法论提示**（供后续复现）：朴素正则会误报 ——
> 输出 `&lt;img src=x onerror=alert(1)&gt;` 里的 `onerror=` 会让 `/\son(error)=/` 命中，
> 正确做法是**先剥离 `&lt;...&gt;` 已转义片段**，再检查裸标签。首次探测我就是这样误报了 4 项。

### 5.7 文件上传：**防护有效**（4/4 探测通过）

| 探测 | 结果 |
|---|---|
| 路径穿越文件名 `../../../../etc/passwd` | ✓ 净化为 `passwd-<random>`，key 中无 `..` |
| 空文件 | ✓ 400 `EMPTY_FILE` |
| 未登录上传 | ✓ 401 |
| 非 multipart | ✓ 400 `NOT_MULTIPART` |

**防御实现**（`services/api/src/lib/oss.js`）：
```js
function sanitizeName(name, fallback = 'file') {
  const raw = String(name ?? '').replace(/\\/g, '/');
  const base = raw.slice(raw.lastIndexOf('/') + 1);   // ← 取 basename，天然消解 ../
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    ...
```
并且有多重校验：`limits.fileSize` + `buffer.length` 二次校验 + 配额校验（`QUOTA_EXCEEDED`）。

### 5.8 CSRF：**不需要**（架构天然免疫）

- 鉴权令牌通过 `Authorization: Bearer <jwt>` 头传递（`middleware/auth.js` 的 `bearerToken()` 只读 `req.headers.authorization`）；
- 前端存 `localStorage`（`api/client.ts:38-39` 的 `neomd.access` / `neomd.refresh`）；
- **全程无 Cookie 鉴权** → 浏览器不会自动附带 → 跨站请求无法携带令牌。

**结论**：无需 CSRF token。但需注意：`localStorage` 存储令牌意味着 **XSS 一旦成立即可窃取令牌** —— 这正是 §5.6 的 XSS 防护如此重要的原因。

### 5.9 依赖漏洞汇总（`pnpm audit`，共 12 个 advisory）

| 严重度 | 数量 | 主要模块 | 修复版本 | 可利用性（实测/评估） |
|---|---|---|---|---|
| **critical** | **2** | `tinypool`（vitest 链） | `>=2.1.2` | 仅本地测试环境（devDependency），未部署到生产 |
| high | 1 | `@fastify/static` **（生产）** | `>=10.1.1` | **实测未可利用**（见 §5.2，9 种 payload 0 泄露） |
| moderate | 9 | `@fastify/static`×3、`vitest`、`@vitest/mocker`×2、`uuid`、`minimatch`、`glob` | 见 `pnpm-audit.json` | 多为构建链间接依赖 |

**优先级（按「实际可利用性」而非 advisory 标签排序）**：
1. **`@fastify/static`**（生产、可直接利用面）→ 但实测未成功，定级 **P2**，仍应升级；
2. `tinypool` / `vitest`（critical 标签，但**仅开发依赖**，生产不部署，可利用性低）；
3. `uuid` / `minimatch` / `glob`（构建链间接依赖，风险低）。

**为什么不能直接按 advisory 的严重度排优先级**：
`pnpm audit` 的 severity 是**基于漏洞本身**，不区分「生产依赖 / 开发依赖」，也不判断该漏洞在当前部署下是否真的可利用。
本项目的 2 个 critical 全在 `vitest`（devDependency）链上 —— 生产 `services/api` 不安装 devDependencies，实际暴露面为 0。
反之 `@fastify/static` 只有 high，却是唯一在生产运行时链路上的。

**注意**：`.npmrc` 指向 `registry.npmmirror.com`，其 **audit endpoint 不存在**（实测 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`）。CI 里跑 audit **必须显式加 `--registry=https://registry.npmjs.org`**。

### 5.10 临时实例与端口管理缺乏规范

**本轮实测事故**（lead 通报）：`services/api/.env` 配 `PORT=3200`，但残留进程占着 **3210**（1.4.0 期间起的临时实例端口），导致新进程 `EADDRINUSE` 自杀，开发环境起不来。

**问题的两层**：

1. **端口占用冲突**：历史上本项目多次在 3200/3210/3211 起临时 API 实例做验收，但**没有清理保证**。
   实测证据：`ss -tlnp` 显示生产机上 `3000`/`8781`/`8080`/`3146`/`5211` 等多个非标准端口在监听，其中部分就是这类临时实例的残留。

2. **更危险的是数据层**：这些临时实例的 `.env` **指向同一个生产库**（`DB_HOST` 与生产一致）。
   多实例并发写同一份数据 → 竞态写入、连接池耗尽、以及本次审计中遇到的「数据库连接数波动」。

**建议（按实施成本排序）**：
- **最低成本**：临时实例启动脚本一律 `PORT=<唯一值>` + `finally { process.kill(pid) }` + 启动前 `lsof -i:<port>` 检查；
- **中等成本**：为临时实例强制使用**独立的数据库**（如 `neomd_test`），通过 `DB_NAME` 环境变量覆盖，从根上消除「临时实例污染生产库」；
- **推荐**：一个项目只允许一个实例 —— 需要临时环境时用 `docker compose -p audit up` 起隔离栈（本项目已有 `docker-compose.yml`，见 nginx 配置的禁止访问列表）。

**本次审计自身也撞到了这个问题**：`audit140-*` 脚本运行期间 API 两次短暂不可用（我已在报告中如实记录，且未重启服务）。

---

## 6. 技术债量化汇总

| 指标 | 数值 |
|---|---|
| 前端源码总量 | **1854 KB / 53260 行 / 86 文件** |
| 前端 TOP3 文件占比 | **26.8%**（496.4 KB / 12776 行） |
| 最大的单一 store | `app.ts` **2973 行 / 85 个函数** |
| 最大单文件（全部） | `EditorPage.vue` **197.8 KB** |
| 死代码（确认 + 高置信） | **约 109 KB / 3124 行**（占前端 5.9%），其中 `SettingsModal.vue` 87.5 KB |
| 后端最大单文件 | `admin.js` **148.8 KB / 3542 行 / 49 路由** |
| `any` / `@ts-ignore` | **0 / 0**（149 个 TS/Vue 文件） |
| 测试用例 | **265 个 / 12 文件** |
| 零测试覆盖的核心模块 | **27 个**（>100 行的），含 `vault.ts` 1109 行、`sync-engine.ts` 799 行 |
| 依赖漏洞 | **12 个**（2 critical / 1 high / 9 moderate） |
| 凭据泄露 | **81 处 / 66 文件**，其中 **47 个已 git 跟踪** |
| 循环依赖 | **0** |

**最值得投入的三件事**（按 ROI 排序）：
1. **清凭据**（P0，1 天可完成：改 47 个脚本的 1 行模式 + 轮换密码 + pre-commit hook）；
2. **给 `sync-engine.ts` 加测试**（把本轮 19 个合并用例搬进 `__tests__`，半天）—— 这是数据安全的核心却零覆盖；
3. **升级 `@fastify/static` + 修 nginx TLS 配置 + MySQL bind 127.0.0.1**（运维 1 小时，消掉 3 个 P1）。

---

## 7. 审计方法说明与自我披露

**已执行的无害探测**（全部只读，除注明外）：
- 多租户越权：用 admin token 请求不属于自己的 vaultId / 完整前缀 / 路径穿越 / 伪造 share token（22 项）；
- 提权：为 role=user 用户签发合法 token（服务端自己的 `signAccessToken`），请求 18 个后台接口（24 项）；
- 伪造 JWT：4 种篡改方式；
- XSS：8 种 payload 直接调用服务端 `renderHtml`（不落库）；
- 上传：4 种非法请求（**其中 1 个路径穿越探测被服务端接受并写入了一个临时对象** `us/admin/ot/passwd-<random>`，已用 `deletePlatformObject()` 删除，并用 `/api/storage/list` 复查确认清理）；
- 依赖：`pnpm audit --registry=https://registry.npmjs.org`。

**对生产数据的唯一影响及处理**：
- 探测 `GET /api/storage/list?x-vault-id=<随机>` 触发了服务端自动登记，`user_vaults` 从 4 行短暂变为 5/6 行；
- **已全部清理**（`DELETE /api/vaults/<id>?purge=1`），最终复查 `/api/vaults` = **4 条**，与审计前一致；
- 未修改任何源码、配置或已有数据。
- 该行为本身已作为发现写入 §3.1。

**未能完成的部分**：
- `pnpm audit` 默认源（npmmirror）不支持，已改用官方源完成；
- 生产 `md.zhengl.vip` 的依赖版本未直接探测（审计基于本地仓库 1.4.0 与生产同版本这一前提）；
- `bt_agent_mcp/data/` 按要求**完全未读取**。
