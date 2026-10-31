# A4 · 管理端全模块实测审计报告（Neo MD 1.4.0）

> 审计员：fix-admin（1.4.0 后台组原负责人，本轮**只读审计，未修任何源码**）
> 审计时间：2026-10-31 14:00 – 16:00（Asia/Shanghai）
> 环境：本地前端 `5178` / 临时 API `3211`（连生产库）/ 生产 `https://md.zhengl.vip`（1.4.0）
> 审计脚本：`tools/audit-*.mjs`（9 个）· 截图：`docs/AUDIT-140/shots/admin-*.png`

---

## 0. 执行摘要

| 维度 | 结论 |
|---|---|
| **模块可用率** | **19/19 模块可打开**，无白屏、无 JS 崩溃、无 NaN/undefined 渲染 |
| **数据一致性** | 逐项核对 **45 项，44 项一致**；1 处统计口径缺陷（AUDIT-01，根因同 AUDIT-06） |
| **联动完整性** | 5 条链路 **4 条成立**；1 处 **P0 双失效**（AUDIT-02：隔离 + 停用均可绕过） |
| **危险操作防护** | 7 项中 **6 项有二次确认**；1 项缺失且**已实证造成线上功能缺失**（AUDIT-03 → P1） |
| **权限边界** | 全部通过（401/403 正确，本地 `/admin` 重定向登录页） |
| **错误提示质量** | **10/10 可读**（全部中文、无技术栈泄漏） |
| **性能** | 正常模块 190–780ms；未见 N+1（单模块 3–5 个 API 请求） |
| **移动端 375×667** | 布局不溢出，但**可点击目标 100% 小于 44px**（AUDIT-04） |

### 缺陷清单（按 Lead 复核后的定级）

| 级别 | ID | 缺陷 | 一句话影响 |
|---|---|---|---|
| 🔴 **P0** | AUDIT-02 | 仓库隔离 + 停用双失效（**2 个漏网点**） | 写入落回「按用户名的大桶」，多仓库隔离与停用同时失效 |
| 🔴 **P0** | AUDIT-01 + AUDIT-06 | 删用户不级联账本 → 统计失真（26 vs 2） | 同一根因两端；指标随每次删用户持续恶化 |
| 🟡 **P1** | AUDIT-03 | 插件下架无二次确认（**已实证**） | 一次误点即让全部客户端用户少一个插件 |
| 🟡 中 | AUDIT-05 | 审计日志 5781 条仅可见 60 条 | 合规追溯退化为「直连数据库」 |
| 🟢 低 | AUDIT-04 | 移动端点击目标 < 44px（100%） | 窄屏点击精度不足 |

**P0 两项建议进 1.4.1 必修**（前者是隔离/鉴权绕过，后者是数据污染源头）。

> 本报告在 Lead 复核后做了三处**升格与合并**：
> 1. AUDIT-02 从「高危」升为 **P0**，且把「隔离失效」提到「停用失效」之前（详见 §3）；
> 2. AUDIT-01 与 AUDIT-06 合并为**同一根因链**（详见 §4）；
> 3. AUDIT-03 从「中危 UI 瑕疵」升为 **P1 高危误操作**（详见 §6）。
> 另外补查出 AUDIT-02 的**第二处漏网点**（multipart 上传），把「1 处」更正为「2 处」。

---

## 1. 环境异常（首先记录）

审计开始时 **`3200` 已宕机**（`netstat` 无监听，`ECONNREFUSED`）。这是今日第 3 次非预期停机
（前两次：17:18:54、约 02:33）。审计期间我起的 3211 临时实例**也被杀过一次**（第 2 次运行
`audit-analytics-conversion.mjs` 时 `ECONNREFUSED`），印证了「有外部进程在发 SIGTERM」的判断。

审计因此全程使用**独立 3211 实例**（`PORT=3211 node src/server.js`，连同一生产库），
不重启、不占用 3200/5178。生产 `1.4.0` 全程 `{"ok":true,"db":true}`（uptime 11533s+）。

> 详见另一份停机排查材料；本报告不重复。

---

## 2. 逐模块功能验证（19 个组件）

| # | 模块 | 组件 | 入口 | 数据真实 | 操作可用 | 空状态 | 错误处理 |
|---|---|---|---|:---:|:---:|:---:|:---:|
| 1 | 数据看板 | AdminDashboard | ✓ | ✓（13 项指标对上 DB） | ✓ | ✓ | ✓ |
| 2 | 运营概览 | AdminOverview | ✓ | ✓（16 项对上 DB） | ✓ | ✓ | ✓ |
| 3 | 用户与配额 | AdminUsers | ✓ | ✓（12 项对上 DB） | ✓ | ✓ | ✓ |
| 4 | 仓库管理 | AdminVaults | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 | 分享与评价 | AdminShare | ✓ | ✓ | ✓ | ✓ | ✓ |
| 6 | 发布与分发 | AdminRelease | ✓ | ✓（当前版本==pkg） | ✓ | ✓ | ✓ |
| 7 | 插件市场 | AdminPlugins | ✓ | ✓（53 条，20/页） | ✓ | ✓ | ✓ |
| 8 | 积分与兑换码 | AdminCredits | ✓ | ✓ | ✓ | ✓ | ✓ |
| 9 | 积分流水 | AdminLedger | ✓ | ✓（total=75 对上 DB） | ✓ | ✓ | ✓ |
| 10 | 计费与赠送 | AdminBilling | ✓ | ✓ | ✓ | ✓ | ✓ |
| 11 | AI 供应商 | AdminAiProviders | ✓ | ✓（密钥脱敏） | ✓ | ✓ | ✓ |
| 12 | 平台模型配置 | AdminAiModels | ✓ | ✓ | ✓ | ✓ | ✓ |
| 13 | AI 运营分析 | AdminAiUsage | ✓ | ⚠ 1 项口径错 | ✓ | ✓ | ✓ |
| 14 | 知识库令牌 | AdminKnowledgeTokens | ✓ | ✓（27 个令牌） | ✓ | ✓ | ✓ |
| 15 | 配置中心 | AdminConfig | ✓ | ✓（3 项） | ✓ | ✓ | ✓ |
| 16 | 审计日志 | AdminAudit | ✓ | ✓ | ⚠ 无分页 | ✓ | ✓ |
| 17 | 系统配置（同 15） | AdminConfig | ✓ | ✓ | ✓ | ✓ | ✓ |
| 18 | 发布管理 | (publishes) | ✓ | ✓（5 条） | ✓ | ✓ | ✓ |
| 19 | 安全/状态 | AdminDashboard(status) | ✓ | ✓ | n/a | ✓ | ✓ |

**模块可用率：19/19 = 100%。**

### 渲染实测（每模块独立 browser context，避免累积崩溃）

```
运营概览    668ms   3 API      分享与评价   650ms   4 API
用户与配额  673ms   4 API      发布与分发   671ms   4 API
插件市场    684ms   3 API      积分与兑换码 663ms   4 API
计费与赠送  770ms   3 API      AI 供应商    667ms   5 API
平台模型配置 761ms  4 API      AI 运营分析  773ms   4 API
知识库令牌  778ms   4 API      配置中心    220ms   4 API
数据看板    354ms   3 API      仓库管理    198ms   3 API
积分流水    203ms   4 API
```
→ **无 N+1**：单模块 3–5 个请求，与「1 次列表 + 1 次 me + 1 次 dashboard 预取」的预期相符。

---

## 3. 🔴 P0 · AUDIT-02：仓库隔离 + 停用**双失效**（可绕过）

> **定级说明（经 Lead 复核后升格）**：首轮我描述为「停用失效（主）+ 隔离失效（次）」。
> 复核后确认应反过来：**隔离失效是第一位**，停用失效是它的派生后果。定级 **P0**。

### 现象

后台把仓库停用后，用户端用某些请求形态**仍然能拿到上传签名**，仓库停用形同虚设；
且这些写入**不落在仓库隔离前缀下**，而是落进「该用户的老式大桶」。

### 实测（`tools/audit-vault-disabled-probe.mjs`）

同一用户、同一仓库、同一时刻，**仅因 `vaultId` 的投递位置不同**，授权结果相反：

```
停用前基线：POST /api/storage/presign {vaultId}      → HTTP 200   ✓
后台停用：  PUT /api/admin/vaults/3443 {status:disabled} → HTTP 200
DB 复核：   user_vaults.status = disabled            → PASS（前置条件成立）

停用后三种形态：
  A. body.vaultId      → HTTP 200  x-vault-legacy=1  ❌ 未拒绝（走了 legacy 兼容分支）
  B. header x-vault-id → HTTP 403  VAULT_DISABLED    ✓ 正确拒绝
  C. query ?vaultId=   → HTTP 403  VAULT_DISABLED    ✓ 正确拒绝
  读接口 GET /api/storage/object?vaultId= → HTTP 403 ✓
```

### 根因链（四步，每步都有代码位置）

**第 1 步：`presignSchema` 漏声明 `vaultId`**（`services/api/src/routes/storage.js:240`）
```js
const presignSchema = z.object({
  key: ..., method: ..., expiresSeconds: ..., contentType: ...   // ← 无 vaultId
});
```

**第 2 步：zod 默认 strip** → `storage.js:571` 的 `parse()` 解析后 `body.vaultId` 被静默丢弃。

**第 3 步：丢掉的 body 传给 `resolveScope`** → `storage.js:572` → `lib/vault-scope.js:80 readVaultId()`
读到空 → 落「老客户端不带 vaultId」分支：
```js
// storage.js:88-93
if (!rawVaultId) {
  const prefix = legacyUserPrefix(req.user.username);   // ← 按【用户名】的前缀，不含 vaultId
  if (reply) reply.header(LEGACY_HEADER, '1');
  return { prefix, vaultId: null, legacy: true };       // ← 直接 return
}
```

**第 4 步：`assertVaultUsable()` 从未被调用** —— 它只在 `rawVaultId` 非空的分支里（`storage.js:97`）。

### 影响（隔离失效为主）

`legacyUserPrefix(username)` 是**按用户名**的前缀，**不含 vaultId**。走这条路径写入的对象：

1. **不属于任何仓库**，而是落在「该用户的老式大桶」里；
2. 用户有多个仓库时（实测 admin 有 4 个），这条路径写入的对象**仓库间完全不隔离**；
3. 该前缀的读取端同样走 legacy → 任何带 legacy 的读都能看到该用户**所有仓库混在一起的数据**；
4. 这与 1.3.1/1.4.0 花大力气做的 `vault-scope.js` 三层收敛（同 name 复用 / `auto_registered` 标记 /
   20 仓库上限）**相互抵消** —— 前者费劲把数据关进各自仓库，后者又开了一个后门把数据倒回大桶；
5. 停用失效只是它的副产品：既然根本没走到仓库校验，自然也谈不上「停用」。

### 影响范围的重要限定（审计员补查，避免夸大）

须诚实地说明：**当前官方客户端不受这两处漏网点影响。**

`packages/core/src/storage/proxy-client.ts` 显示：
- `vaultId` **始终通过请求头 `x-vault-id` 传递**（`:201-207`，集中注入）；
- 上传走 **`octet-stream` 直传原始字节**（`putObject()` `:254-267`），**不用 multipart**。

这两条都落在「已被正确校验」的路径上。因此本缺陷的实际影响面是：

| 受影响对象 | 是否受影响 | 说明 |
|---|---|---|
| 官方桌面/网页/Android 客户端 | **否** | 走 header，已正确校验 |
| 第三方 SDK / 自建客户端（若用 body 传 vaultId） | **是** | 静默降级到 legacy，隔离与停用均失效 |
| 未来新增的 multipart 上传路径 | **是** | `readRawBody` 不提取 vaultId，注释却声称支持 |
| 依赖 `storage.js:504` 注释理解代码的开发者 | **是** | 会产生「此路径已覆盖」的误判（Lead 首轮即如此） |

**所以定级仍为 P0，但理由要精确**：它不是「正在造成线上数据混仓」，
而是「**接口契约存在一个当前无人使用、但一旦被使用就会静默失效的后门**」，
且**注释在主动误导后来者**。修它的价值在于「在有人踩到之前堵上」。

> 这个限定同样适用于后续两条：**发现缺陷要报，但不能为了让缺陷显得更重要而省略「当前是否正在发生」**。
> 前者会影响修复优先级排序，后者属于夸大。

### 补查：**漏网点有 2 个，不是 1 个**（证据见 `tools/audit-presign-vaultid-gap.mjs`）

首轮我凭静态阅读判断「全仓仅 presign 一处」。Lead 要求把它从**断言**变成**证据**，
补做扩查后确认**还有第二处**：

```
静态枚举（6 个 resolveScope 真实调用点，body 参与作用域的仅 2 个）：
  #  行号   方法   路径                     body 来源       schema 声明 vaultId?  能否从 body 拿到
  1   319   GET    /api/storage/list        none           -                     否（仅 header/query）
  2   403   GET    /api/storage/object      none           -                     否（仅 header/query）
  3   461   HEAD   /api/storage/object      none           -                     否（仅 header/query）
  4   505   PUT    /api/storage/object      readRawBody    n/a（无 zod）          否 ❌ readRawBody 未提取
  5   557   DELETE /api/storage/object      none           -                     否（仅 header/query）
  6   572   POST   /api/storage/presign     zod            否                     否 ❌ 被 zod strip

运行时探测（带已停用仓库的 vaultId，期望全部 403）：
  POST /api/storage/presign  body.vaultId                → HTTP 200 legacy=1  ❌ 未拒绝
  POST /api/storage/presign  header x-vault-id           → HTTP 403 VAULT_DISABLED ✓
  POST /api/storage/presign  query ?vaultId=             → HTTP 403 VAULT_DISABLED ✓
  GET  /api/storage/list     query ?vaultId=             → HTTP 403 VAULT_DISABLED ✓
  GET  /api/storage/object   query ?vaultId=             → HTTP 403 VAULT_DISABLED ✓
  HEAD /api/storage/object   query ?vaultId=             → HTTP 403 ✓
  DELETE /api/storage/object query ?vaultId=             → HTTP 403 VAULT_DISABLED ✓
  PUT  /api/storage/object   octet-stream + header       → HTTP 403 VAULT_DISABLED ✓
  PUT  /api/storage/object   multipart 字段 vaultId       → HTTP 200 legacy=1  ❌ 未拒绝
```

**新增的第二处：`PUT /api/storage/object` 的 multipart 上传。**
`readRawBody()`（`storage.js:264-296`）只提取 `file.fields.key`，
**从未提取 `file.fields.vaultId`**，返回对象是 `{buffer, key, contentType}` —— 不含 vaultId。
而 `storage.js:504` 的注释明确写着：

> `// vaultId 也可能从 body 传（multipart 场景），因此把 body 一并交给作用域解析`

**注释的意图并未实现** —— 于是 multipart 上传的 vaultId 同样被丢弃，同样静默降级到 legacy。

> 更正：首轮报告的「7 个调用点」把我自己的统计口径也算进去了（`audit-audit02-sweep.mjs` 把
> `async function resolveScope` 定义行计入了总数）。真实调用点是 **6 个**，其中 body 参与作用域的 2 个，
> **这 2 个全部可绕过**。

### 修复建议（未落盘，交开发组）

```js
// ① storage.js:240 presignSchema 内补一行
vaultId: z.string().trim().max(64).optional(),

// ② storage.js readRawBody() 的 multipart 分支补提取 vaultId
const fieldVault = file.fields?.vaultId;
const fieldVaultValue = Array.isArray(fieldVault) ? fieldVault[0]?.value : fieldVault?.value;
return {
  buffer,
  key: String(headerKey ?? fieldValue ?? '').trim(),
  vaultId: String(fieldVaultValue ?? '').trim(),   // ← 补这一行
  contentType: file.mimetype || 'application/octet-stream',
};
```
并建议（防复发）：
- 对「body 参与作用域解析」的路由，统一在 schema 里显式声明 `vaultId`；
- 给 `resolveScope` 加开发环境断言：**传了 body 却没有 `vaultId` 字段 → warn**，
  这样下次任何新路由漏声明都会立刻暴露，而不是靠人工审计发现；
- 长期看，`legacyUserPrefix` 这条兼容分支应设定明确的退场条件（与 `STORAGE_LEGACY_READ` 一并下线）。

---

## 4. 🔴 P0 · AUDIT-01 + AUDIT-06：同一条根因链 —— 删用户不级联账本 → 统计失真

> **重要合并说明（经 Lead 复核）**：首轮我把 AUDIT-01（统计口径错）与 AUDIT-06（`DELETE users`
> 不级联 `credit_ledger`）列成了两条独立缺陷。复核后确认它们**是同一条根因链的两端**：

```
后台删用户 → users 行没了 → credit_ledger 留下孤儿行
    → creditedUsers 用 COUNT(DISTINCT user_id) 统计到这些已删用户
    → 26 ≠ 2（超过全库用户数，逻辑上不可能）
```

**因此必须两件一起修**：级联清账本（止血，断掉源头）+ `JOIN users`（修正历史统计）。
只修一处都不完整：只改 SQL 则孤儿继续累积；只级联则历史 26 依旧错。

### 现象

`GET /api/admin/ai-analytics` 返回 `conversion.creditedUsers = 26`，而**全库只有 3 个用户**。

### 实测（`tools/audit-orphan-ledger.mjs`）

```
creditedUsers（当前实现，含已删用户） : 26
creditedUsers（JOIN users 正确值）    :  2
全库真实用户数                        :  3
creditedUsers > 全库用户数 —— 逻辑上不可能成立
```

### 根因（`services/api/src/routes/admin.js:3218`）

```sql
(SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind IN ('recharge','grant')) AS credited
```
统计的是「**账本里出现过的 user_id**」，而 `credit_ledger` 在删除用户时**不会级联清理**
（`DELETE /api/admin/users/:id` 的 tx 未包含该表）。历史遗留 + 测试残留共 **65 条孤儿账本**，
分属 23 个已删除的 user_id。

**分子 `payingUsers` 同一写法也有此问题**，只是当前恰好为 0 才没暴露。

### 🔍 最好的证据：我 1.4.0 的验收脚本自己就在生产这个 bug

> 这 65 条孤儿里，**60 条是我的 1.4.0 验收脚本造成的**（`user_id` 11–31，时间 `00:46`–`02:55`）。
> 我的 `re14-admin-verify.mjs` 在 `finally` 里用 `DELETE /api/admin/users/:id` 清理临时用户，
> 而该接口不级联 `credit_ledger` —— 于是我**一边验证功能，一边在生产库里制造孤儿账本**。

这件事本身比任何论证都有说服力：
- 它证明这个缺陷**不是理论风险，而是任何调用该接口的正常代码路径都会触发**；
- 它证明**测试清理脚本是最高频的触发者**（每跑一次验收就多一批孤儿）；
- 它也说明为什么「删除用户」这个操作必须在事务里把关联数据一并处理干净。

（时间戳吻合：`banked 00:46/01:42/01:59/02:00/02:11/02:17/02:19/02:26/02:55` 各批次，
恰好对应我 1.4.0 期间九次验收运行。）

### 影响

- 运营看到「已充值用户 26 人」而实际只有 2 人（转化率分母失真 13 倍）；
- 该指标无法用于任何决策；
- 孤儿账本会随每次「删用户」持续累积，**指标会越来越离谱**（不会自愈）。

### 修复建议（未落盘，**两件一起做**）

**① 止血（AUDIT-06）：删除用户时级联清账本**
在 `services/api/src/routes/admin.js` 的 `DELETE /api/admin/users/:id` 事务内补：
```js
await conn.execute('DELETE FROM credit_ledger WHERE user_id = ?', [id]);
await conn.execute('DELETE FROM ai_usage WHERE user_id = ?', [id]);
```
（或给两张表加外键 `ON DELETE CASCADE`，需评估历史数据与性能）

**② 修正历史统计（AUDIT-01）：两处 COUNT 都 JOIN users**
```sql
(SELECT COUNT(DISTINCT l.user_id) FROM credit_ledger l JOIN users u ON u.id = l.user_id
  WHERE l.kind IN ('recharge','grant')) AS credited
```

**③ 历史孤儿清理**：本报告已精确定位 23 个 user_id（8,9,10 + 11–31），
建议由开发组在迁移里一次性清理（审计员不擅自删除生产数据）。

---

## 5. 🟡 中危 AUDIT-05：审计日志 99% 在 UI 上不可达

### 实测（`tools/audit-log-coverage.mjs`）

```
DB 实际条数：5781         时间跨度：2026-10-23 17:03 → 2026-10-31 15:33
接口 page=1&pageSize=60  → items=60  total=5782
接口 page=70&pageSize=60 → items=60  （能取到第 70 页，接口完全支持深分页）
第 1 页首条：2026-10-31 15:35:31
第 70 页首条：2026-10-30 00:59:11  ← 能取到更早记录
```

**UI 侧**（`apps/web/src/components/admin/AdminAudit.vue:28`）：
`pageSize: 60`，工具栏文案「最近 60 条」，**无分页组件**。

→ 接口支持、UI 未接。**5781 条中约 5721 条（99.0%）在 UI 上不可查阅**。

### 影响

审计日志是合规/追责的唯一入口。当前管理员只能看到最近 60 条，
查一周前的一次异常登录、一次配置变更，**必须直接连数据库** —— 这违背了「后台可自证」的初衷。

### 修复建议

`AdminAudit.vue` 增加分页（与 1.4.0 给 AdminPlugins 加的那套一致：page/pageSize/total + 页码 + 回顶部）。

---

## 6. 🟡 P1 · AUDIT-03：插件「下架」无二次确认（已实证造成线上功能缺失）

> **定级说明（经 Lead 复核后升格）**：首轮定为「中危／UI 瑕疵」。复核后确认应为
> **P1（高危误操作）**：这不是「少一个确认弹窗」的体验问题，而是**一次误点就能让线上功能缺失**——
> 我用一次点击在 1 秒内把市场从 53 掉到 52，且全程无任何拦截。

### 实测（`tools/audit-danger-confirm.mjs`）

```
✓ 用户管理 / 删除用户    「删除用户 dgr_xxx？不可恢复。」
✓ 用户管理 / 重置密码    「重置 dgr_xxx 的密码？新密码只显示一次。」
✓ 用户管理 / 切换角色    「dgr_xxx：设为管理员？」
✓ 用户管理 / 封禁用户    表单弹窗（未填原因时提交按钮禁用）
✓ 用户管理 / 批量操作    表单弹窗（执行时另有 confirm）
✗ 插件市场 / 下架插件    （无任何确认，点击即执行）
✓ 分享管理 / 删除撤销    「撤销该分享链接？撤销后访客将无法访问，但数据保留。」
```

### 实证后果（本次审计的真实副作用，如实记录）

点击首行「下架」后，**真实插件 #54 `sync-brief`（同步简报）立即从 published → disabled**，
市场可见数 53 → 52。

- 证据：`community_plugins` 中 `#54 updated_at = 2026-10-31 14:48:36`，与点击时刻精确吻合；
- 已用正式接口恢复：`PUT /api/admin/plugins/54/status {"status":"published"}` → 市场恢复 53/53，
  公开市场接口确认可见（`tools/audit-restore-plugin.mjs`）；
- 这也说明该缺陷**极易造成生产误操作**：管理员误点一下就下架一个线上插件，且无任何拦截。

**为什么算 P1 而不是 UI 瑕疵**：

| 维度 | 其它危险操作 | 插件下架 |
|---|---|---|
| 有 confirm | ✓ 有（删除用户/重置密码/撤销分享…） | ✗ 无 |
| 可撤销 | 部分不可逆（删用户） | 可恢复（重新上架） |
| 影响面 | 单个用户 | **全部客户端用户的插件市场** |
| 误触概率 | 需点两次（按钮 + 确认） | **一次点击即生效** |

→ 影响面是「所有客户端用户」而非单个对象，且零摩擦触发。故定级 P1，建议 **1.4.1 必修**。

### 修复建议

`AdminPlugins.vue` 的 `setStatus` 在上架/下架前加 `window.confirm`（与其它模块保持一致），
文案建议包含插件名与影响（「下架后客户端市场将不再展示」）。

---

## 7. 🟢 低危 AUDIT-04：移动端 375×667 可点击目标全部小于 44px

### 实测（`tools/audit-mobile-targets.mjs`）

```
页签          <44px 占比         最早样本（尺寸）
dashboard   17/17  (100%)       nav 项 高约 32
users       42/42  (100%)       badge 40×20, rowbtn 42×24
plugins     79/79  (100%)       rowbtn 42×24
audit       58/58  (100%)       nm-btn 46×26, badge 69×20
releases    98/98  (100%)       badge 38×19
```

### 好消息

- **布局不溢出**：`doc scrollWidth/clientWidth = 375/375`，三个页签均无横向滚动；
- 侧栏在窄屏切换为顶部横向条，仍可访问全部模块；
- 表格在窄屏下未破版。

### 判定

后台是**桌面运营工具**，移动端非主场景。但若产品宣称「移动端可用」，则需：
给 `.adm-rowbtn` / `.nm-btn` / `.adm-badge` 在 `@media (max-width: 1000px)` 下加
`min-height: 44px; min-width: 44px`（或 `padding` 增大）。
参考：WCAG 2.5.5 要求 44×44；Material 48dp；iOS HIG 44pt。

---

## 8. 数据一致性核对明细（45 项，44 一致）

`tools/audit-admin-consistency.mjs`：接口值 vs 直接查生产库。

| 组 | 核对项 | 结果 |
|---|---|---|
| A. dashboard | users.total/active/disabled/admins/newToday/newThisWeek | 6/6 ✓ |
| | documents.vaults/total | 2/2 ✓ |
| | storage.bytes | ✓ |
| | ai.callsTotal/inTokensTotal/outTokensTotal | 3/3 ✓ |
| | credits.circulating | ✓ |
| B. stats | users.total/active | 2/2 ✓ |
| | shares.total/active/views | 3/3 ✓ |
| | publishes.total/active | 2/2 ✓ |
| | comments.total/hidden | 2/2 ✓ |
| | storage.bytes/documents/vaults | 3/3 ✓ |
| | ai.requests24h/inTokens24h/outTokens24h | 3/3 ✓ |
| C. ledger | total / summary.inflow / summary.outflow | 3/3 ✓ |
| E. users 列表 | total + 三位用户各 4 项统计 | 13/13 ✓ |
| D. ai-analytics | byDay 合计 | ⚠ 见 AUDIT-01（creditedUsers） |

**唯一不一致**：`ai-analytics.conversion.creditedUsers`（26 vs 应为 2）。

补充：`dashboard.metrics.documents.vaults = 4` 与早前观察的 `user_vaults` 10 行不符，
经查是数据变化（1.4.0 清理了 auto_registered 空壳），当前 DB 与接口**一致（4）**，非缺陷。

---

## 9. 联动验证（5 条链路，4 成立）

`tools/audit-admin-linkage.mjs`（全程临时数据，finally 清理）：

| 链路 | 断言 | 结果 |
|---|---|---|
| **L1 后台改积分 → 用户端余额** | 用户端 `/api/credits` 余额 +500 / −200 同步 | ✓ **成立**（余额与流水都变） |
| **L2 后台停用仓库 → 用户端** | 状态变 disabled / 存储接口被拒 | ⚠ **半成立**：状态 ✓，但**存储接口可绕过** → AUDIT-02 |
| **L3 后台编辑插件 → 客户端市场** | 名称/版本/描述立即可见、下架后消失 | ✓ **成立**（5 项断言全过） |
| **L4 后台撤销分享 → 公开链接** | 公开链接由 200 → 404 | ✓ **成立** |
| **L5 后台改角色 → 权限** | 普通用户 403 → 提权后旧 token 200 | ✓ **成立**（实时生效，无需重新登录） |

L5 附带结论：**提权即时生效**（旧 token 立刻能访问后台），降权也即时。
这是合理设计，但需注意「降权后旧 token 仍可能持有缓存中的界面权限」——
前端下次请求才会被拒，属正常行为。

---

## 10. 权限边界（全部通过）

`tools/audit-perm-mobile.mjs`：

```
无 token 访问 6 个后台接口          → 全 401 ✓
伪造 token（非 JWT / 空 / 签名伪造） → 全 401 TOKEN_INVALID ✓
普通用户访问 6 个 GET + 4 个危险写   → 全 403 ADMIN_REQUIRED ✓
未登录访问 /admin                   → 重定向 /login?redirect=/admin ✓
```

> 本轮因注册接口被限流（429，`请 717 秒后再试`）未重新注册普通用户；
> 1c 组结论**沿用同日 `audit-admin-linkage.mjs` L5.1 与本次同源实测**（10/10 → 403）。
> 未修改 `tester01` / `my` 的密码（纪律要求）。

---

## 11. 错误提示质量（10/10 可读）

| 场景 | HTTP | 提示 |
|---|---|---|
| 不存在用户改积分 | 404 | `USER_NOT_FOUND｜用户不存在` |
| 不存在用户封禁 | 404 | `USER_NOT_FOUND｜用户不存在` |
| 不存在用户重置密码 | 404 | `USER_NOT_FOUND｜用户不存在` |
| 不存在插件编辑 | 404 | `PLUGIN_NOT_FOUND｜插件不存在` |
| 积分传 0 | 400 | `amount: 调整数量不能为 0` |
| 积分传非数字 | 400 | `amount: 调整数量必须是数字` |
| 封禁原因为空 | 400 | `reason: 封禁原因至少 2 个字符` |
| 封禁到期时间是过去 | 400 | `封禁到期时间必须晚于当前时间` |
| 插件代码语法错误 | 400 | `PLUGIN_CODE_INVALID｜语法错误：Unexpected token ')'` |
| 批量操作空 ids | 400 | `ids: 请至少选择一个用户` |

→ 全部中文、定位到字段、无技术栈泄漏。**质量良好。**

---

## 12. 审计过程中我自己造成的副作用（如实记录）

| 副作用 | 数量 | 处置 |
|---|---|---|
| 点击「下架」误停用真实插件 `sync-brief` | 1 个 | **已恢复**（published，市场 53/53） |
| 1.4.0 验收脚本删除用户时未清 `credit_ledger` | 60 条孤儿账本 | **本轮未删**（属历史数据，交开发组统一清理；已精确定位 user_id 11–31） |
| 本轮审计注册的临时用户残留 | 1 个（`perm_*`） | **已清理**，真实账号 admin/tester01/my 完好（3 个） |
| 本轮新产生的孤儿账本 | 0 条 | 清理脚本先删账本再删用户 |

> 说明：我 1.4.0 期间的验收脚本 `re14-admin-verify.mjs` 用 `DELETE /api/admin/users/:id` 清理临时用户，
> 而该接口不级联 `credit_ledger` → 产生 60 条孤儿。这既是 AUDIT-01 的诱因，也是**同类缺陷的第二个受害者**。

---

## 13. 缺陷优先级汇总（Lead 复核后定级）

| 级别 | ID | 缺陷 | 位置 | 修复建议 |
|---|---|---|---|---|
| 🔴 **P0** | AUDIT-02 | 仓库**隔离 + 停用双失效**；**2 个漏网点**（presign 的 zod strip / 上传的 multipart 未提取） | `storage.js:240`（schema）+ `storage.js:264-296`（readRawBody） | ① schema 补 `vaultId`；② `readRawBody` 补提取 `file.fields.vaultId`；③ `resolveScope` 加开发环境断言 |
| 🔴 **P0** | AUDIT-01 + AUDIT-06 | 删用户不级联账本 → creditedUsers 统计失真（26 vs 2）；**同一根因两端** | `admin.js:3218`（SQL）+ `DELETE /api/admin/users/:id`（tx） | **两件一起做**：级联删 `credit_ledger`/`ai_usage`（止血）+ 两处 COUNT 加 `JOIN users`（修正） |
| 🟡 **P1** | AUDIT-03 | 插件下架无二次确认，**已实证一次点击让市场 53→52** | `AdminPlugins.vue` `setStatus` | 加 `window.confirm`，文案含插件名与「客户端市场将不再展示」 |
| 🟡 中 | AUDIT-05 | 审计日志 5781 条，UI 仅可见最近 60 条（接口支持深分页） | `AdminAudit.vue:28` | 补分页组件（复用 AdminPlugins 那套） |
| 🟢 低 | AUDIT-04 | 移动端点击目标 < 44px（100%） | `admin-theme.css` | 窄屏加 `min-height/min-width: 44px` |

**建议进 1.4.1 必修**：AUDIT-02、AUDIT-01/06、AUDIT-03（P0 两项 + P1 一项）。

### 与首轮报告的差异（诚实更正）

| 首轮结论 | 复核后 | 原因 |
|---|---|---|
| AUDIT-02 = 高危，停用失效为主 | **P0，隔离失效为主** | `legacyUserPrefix` 按用户名、不含 vaultId，写入不归任何仓库 |
| AUDIT-02 漏网点 = 1 处（presign） | **2 处**（+ multipart 上传） | `readRawBody()` 未提取 `file.fields.vaultId`，尽管注释声称支持 |
| 调用点总数 = 7 | **6** | 我的 sweep 脚本把 `async function resolveScope` 定义行误计入 |
| AUDIT-01 与 AUDIT-06 是两条 | **同一根因链** | 删用户 → 孤儿账本 → 统计到已删用户 |
| AUDIT-03 = 中危 UI 瑕疵 | **P1 高危误操作** | 影响面是全部客户端用户，且零摩擦触发 |

---

## 14. 审计方法与可复现性

全部脚本位于 `tools/`，均可独立运行（`node tools/xxx.mjs`）：

| 脚本 | 用途 |
|---|---|
| `audit-admin-consistency.mjs` | 45 项数据一致性（接口 vs DB） |
| `audit-analytics-conversion.mjs` | AUDIT-01 口径定位 |
| `audit-orphan-ledger.mjs` | 孤儿账本溯源与来源分类 |
| `audit-admin-linkage.mjs` | L1–L5 五条联动链路 |
| `audit-vault-disabled-probe.mjs` | AUDIT-02 三形态探测 |
| `audit-audit02-rootcause.mjs` | AUDIT-02 三重取证（静态+运行时） |
| `audit-audit02-sweep.mjs` | AUDIT-02 同类全仓排查（首轮，口径含函数定义行 → 6 个真实调用点） |
| **`audit-presign-vaultid-gap.mjs`** | **AUDIT-02 扩查（Lead 要求）：6 个调用点逐个静态枚举 + 9 个端点运行时探测 → 确证 2 个漏网点** |
| `audit-danger-confirm.mjs` | 危险操作二次确认（UI 观察） |
| `audit-restore-plugin.mjs` | 误操作恢复 |
| `audit-check-plugin-status.mjs` | 插件状态核查 |
| `audit-perm-mobile.mjs` | 权限边界 + 错误提示 + 移动端 |
| `audit-mobile-targets.mjs` | AUDIT-04 点击目标量化 |
| `audit-admin-perf.mjs` | 各模块耗时 + N+1 |
| `audit-log-coverage.mjs` | AUDIT-05 接口 vs UI 能力 |
| `audit-empty-data-recheck.mjs` | 排除「0 数据」假阴性 |
| `audit-cleanup-temp-users.mjs` | 临时账号清理（含真实账号安全断言） |

**截图清单**（`docs/AUDIT-140/shots/`）：
`admin-danger-delete-user` `admin-danger-ban-user` `admin-danger-plugin-offline`
`admin-danger-share-delete` `admin-config` `admin-vaults` `admin-knowledge-tokens`
`admin-anonymous-blocked` `admin-mobile-375-{users,audit,plugins}`
`admin-mobile-targets-{dashboard,users,plugins,audit,releases}`
`admin-perf-*`（16 个模块）`admin-perf-audit-paging` `admin-recheck-{dashboard,vaults,ledger,config}`
`admin-recheck2-{vaults,ledger,config,dashboard}`

### 关于本报告中的两处「假失败」更正

1. **「数据看板/仓库管理/积分流水/配置中心加载超时」**：复核后确认是
   `waitForSelector` 选择器假设过强 + 本机 Chrome 偶发崩溃导致。真实加载耗时
   **198–354ms**，且接口有数据、无 NaN。**已更正为无缺陷。**
2. **「4 个模块显示 0 数据」**：进一步抓包确认是**采样过早**（页面仍在「加载中」时读取）。
   实际接口返回 `vaults total=4`、`ledger total=75`、`config items=3`、`dashboard users.total=4`。
   **已更正为无缺陷。** 这一条我特意做了二次复核，避免把脚本问题当成产品缺陷上报。

---

# 附录 A · AUDIT-02 建议补丁（**未经测试验证**，供 1.4.1 修复参考）

> ⚠️ **本附录只是建议，审计员未落盘、未运行验证。**
> 本次审计全组保持只读纪律：一旦审计员开始改代码，「审计」与「修复」的边界就乱了，
> 且没有任何人验证过补丁的正确性。请由修复组实施 + 走正常 review/测试流程。
>
> **两个补丁的共同本质：收紧鉴权。** 收紧一定会让某些原本能通过的请求开始失败 ——
> 这是预期行为，但必须提前告知修复方与运营，否则上线后会收到大量「上传失败」投诉却不明原因。

## 补丁 1：`presignSchema` 补 `vaultId`

```diff
--- a/services/api/src/routes/storage.js
+++ b/services/api/src/routes/storage.js
@@ -240,6 +240,7 @@ const presignSchema = z.object({
   key: z.string(...)...,                    // 保持原样
   method: z.enum(['GET','PUT']).optional().default('GET'),
   expiresSeconds: z.coerce.number()...,
   contentType: z.string().trim().max(120).optional(),
+  vaultId: z.string().trim().max(64).optional(),
 });
```

**效果**：body 里的 `vaultId` 不再被 zod strip → `resolveScope` 能读到 →
`assertVaultUsable()` 真正生效 → 停用仓库会被 403 拒绝。

**风险 1（行为变化）**：某些客户端把 `vaultId` 放在 body 但**值非法**（含非法字符/超长），
补声明后会被 `assertVaultIdShape` 抛 **400**，而不是像现在这样静默走 legacy。
原本「看起来能用的请求」会开始报错。

**风险 2（数据落点变化）**：修复后这些写入会从 legacy 前缀**改落到仓库隔离前缀**。
若某个客户端长期走 body 传 vaultId 并已写入 legacy 前缀，修复后它**读不到自己之前写的对象**
（除非 `STORAGE_LEGACY_READ` 的双读回退仍开着）。上线前需评估这类客户端数量。

> ### ✅ 已核实（审计员补查，1.4.0 现状）
>
> `packages/core/src/storage/proxy-client.ts` 显示：**官方客户端始终用 `x-vault-id` 请求头**
> （`:201-207` 集中注入），**从不把 vaultId 放进 body**。
>
> 因此对**官方客户端而言，补丁 1 的行为变化为零** —— 它本来就走的 header 分支，
> 早已被 `assertVaultUsable` 正确校验。这条漏网点真正影响的是：
> - 第三方 SDK / 自建客户端（若它们按 body 传）；
> - 未来新增的任何「把 vaultId 放 body」的调用路径。
>
> **结论调整**：补丁 1 的实际上线风险**低于**本附录初稿的估计。
> 它更多是「堵住一个当前无人使用的后门」，而不是「改变现有用户行为」。
> 但仍建议按下面的流程观察后再全量，因为第三方客户端的使用情况我们无法从仓库内确认。

**上线前必须确认**：
1. 从访问日志统计 `x-vault-legacy: 1` 的**比例与来源客户端**；
2. 若比例显著（说明大量客户端走 body 传 vaultId），应先在灰度环境观察；
3. 确认 `STORAGE_LEGACY_READ` 的开关状态，评估双读回退是否能兜住历史数据。

## 补丁 2：`readRawBody()` 提取 multipart 的 `vaultId`

```diff
--- a/services/api/src/routes/storage.js
+++ b/services/api/src/routes/storage.js
@@ -264,6 +264,8 @@ async function readRawBody(req) {
     const headerKey = req.headers['x-object-key'];
     const fieldKey = file.fields?.key;
     const fieldValue = Array.isArray(fieldKey) ? fieldKey[0]?.value : fieldKey?.value;
+    const fieldVault = file.fields?.vaultId;
+    const fieldVaultValue = Array.isArray(fieldVault) ? fieldVault[0]?.value : fieldVault?.value;
     return {
       buffer,
       key: String(headerKey ?? fieldValue ?? '').trim(),
+      vaultId: String(fieldVaultValue ?? '').trim(),
       contentType: file.mimetype || 'application/octet-stream',
     };
   }
```

**字段名需与实际客户端对齐**：这里假设 multipart 字段名是 `vaultId`。
**必须先核实**：客户端（`packages/core` 的上传实现）实际用的字段名是 `vaultId` / `vault_id` / 其它？
字段名对不上时，补丁等于没打（仍然取到空值，仍然静默走 legacy）。

> ### ✅ 已核实（审计员补查，1.4.0 现状）
>
> 查 `packages/core/src/storage/proxy-client.ts`：
> - **官方客户端用 `octet-stream` 直传原始字节**（`putObject()`，`:254-267`），**不走 multipart**；
> - **`vaultId` 始终通过请求头 `x-vault-id` 传递**（`:201-207`，集中注入而非散落各处）。
>
> 所以：**当前官方客户端不受这两处漏网点影响**（它走的是 header 路径，已被正确校验）。
> 这降低了两处缺陷的**紧迫性**，但**不降低严重性**：
> - 缺陷是**接口契约层面的**——任何第三方 SDK / 自建客户端 / 未来新增的 multipart 上传路径
>   只要用 body 传 vaultId，就会静默降级到 legacy；
> - 且「注释声称支持 multipart 传 vaultId」会**误导后续开发者**以为这条路径已被覆盖
>   （Lead 首轮读这段时就产生了这个误判）。
>
> **这也意味着补丁 2 的风险显著低于补丁 1**：
> 因为官方客户端根本不走 multipart，补 2 不会影响任何现有用户的上传行为；
> 它是「把注释承诺兑现」，主要价值是防未来接入方踩坑。

**风险（行为变化）**：一旦开始提取，**所有 multipart 上传**都会进入「带 vaultId」分支 →
`assertVaultUsable` 真正生效 → 若客户端传了**已停用仓库**的 id，**原本能成功的上传会开始 403**。

这是**预期行为**（停用就该拒绝）。但结合上面的核实结论：
**现有官方客户端不受影响**（它不用 multipart），因此这条风险主要针对**第三方/未来接入方**。
建议：
1. 补丁 2 可与补丁 1 分开上线（互不依赖），风险更低、可先上；
2. 若未来要正式支持 multipart 上传，**必须同时**声明字段名并在文档里写清，避免又一次「注释与实现脱节」；
3. 错误文案应明确（现有 `VAULT_DISABLED` 文案「该仓库已停用，请先在仓库管理中重新启用」是好的）。

## 补丁 3（防复发，非必须）：`resolveScope` 开发期断言

```diff
--- a/services/api/src/routes/storage.js
+++ b/services/api/src/routes/storage.js
@@ async function resolveScope(req, body = null, reply = null) {
   const rawVaultId = readVaultId(req, body);
 
+  // 开发期护栏：调用方传了 body 却没有 vaultId 字段，说明上游 schema/解析把它丢了。
+  // 这类缺陷靠人工审计发现太晚（本次两处漏网点就是这么漏掉的）。
+  if (body && typeof body === 'object' && !('vaultId' in body) && process.env.NODE_ENV !== 'production') {
+    req.log.warn(
+      { url: req.url, bodyKeys: Object.keys(body) },
+      'resolveScope 收到 body 但无 vaultId 字段 —— 检查上游 schema 或参数提取是否丢弃了它',
+    );
+  }
+
   if (!rawVaultId) {
```

**局限（为什么只作为「补充」而非主方案）**：warn 日志会被忽略 —— 没人盯日志就等于没有。
真正硬的方案是下面的表驱动测试。

---

# 附录 B · 建议的回归测试（表驱动，Lead 提议）

> 本次两处漏网点的**共同深层根因**是：**注释声明了能力，但没有测试验证它**。
> 表层是「schema 漏字段」、中层是「提取函数漏字段」，深层是「**没有测试覆盖的注释承诺**」。
> 加 warn 只能提醒，加测试才能拦住。

建议给 `resolveScope` 写**表驱动测试**，把「每个端点 × 每种 vaultId 投递方式」列成表，
逐行断言「停用仓库时必须 403」：

```js
// packages/api 测试（示意，非最终实现）
const CASES = [
  // 端点                          投递方式            期望（仓库已停用）
  ['POST /api/storage/presign',    'body',            403],
  ['POST /api/storage/presign',    'header',          403],
  ['POST /api/storage/presign',    'query',           403],
  ['GET  /api/storage/list',       'header',          403],
  ['GET  /api/storage/list',       'query',           403],
  ['GET  /api/storage/object',     'query',           403],
  ['HEAD /api/storage/object',     'query',           403],
  ['DELETE /api/storage/object',   'query',           403],
  ['PUT  /api/storage/object',     'header',          403],
  ['PUT  /api/storage/object',     'multipart-field', 403],   // ← 本次发现的第二处
];
```

**这套表的价值**：
1. **新增路由时**，表里少一行就会被 review 发现（「你加了端点，表呢？」）；
2. **有人改了 schema 或 `readRawBody`**，表驱动测试立刻红，不依赖人盯日志；
3. 把「注释承诺」变成「可执行断言」—— 这正是本次两道漏网点缺失的东西。

**本次审计的遗憾之处（如实说明）**：我是用事后探测脚本（`audit-presign-vaultid-gap.mjs`）
才抓到的，而不是在写代码时就有测试拦住它。这份脚本本身可以改造成上述回归测试的雏形。

---

*报告结束。审计员未修改任何 `apps/**` `services/**` `packages/**` 源码；仅新增 `tools/audit-*.mjs` 与本报告。*
*附录中的补丁为建议性质，未经测试验证，请由修复组实施并走正常 review 流程。*
