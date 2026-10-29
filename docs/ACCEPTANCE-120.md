# Neo MD 1.2.0 验收报告

- 验收时间：2026-10-30
- 版本：**1.2.0**（源码提交 `e7e5bc1`）
- 环境：本地 API `http://127.0.0.1:3200`（development，连生产库）+ 前端 `http://127.0.0.1:5178`（vite dev）
- 生产：`https://md.zhengl.vip` 已部署 1.2.0

---

## 零、一句话结论（先回答用户最关心的两件事）

### ①「同步失败：Failed to fetch」修好了吗？ → **修好了，且已上线生产**

**根因**：不是新 bug，而是 **1.1.9 的修复从未部署**。生产环境当时 `/api/health` 仍返回 `version: 1.1.8`，而 1.1.9 里「已登录永不直连自建 S3」的不变量只存在于源码中。实测重现：登录 admin → 点同步 → 唯一失败请求发往

```
https://zhenglob.oss-cn-guangzhou.aliyuncs.com/?list-type=2&max-keys=1000&prefix=...
→ TypeError: Failed to fetch
```

`zhenglob` 是**拼写错误的桶名**（真实桶是 `zhengle`）。1.1.8 的分支顺序让「自建 S3」判断排在「已登录」之前，于是已登录用户被这份残留配置抢到第三方 OSS 直连通道；阿里云对该桶的失败响应不返回 CORS 头，浏览器只能抛一句没有 URL、没有原因的 `Failed to fetch`。

**生产实测证据（部署后）**：

| 项 | 结果 |
|---|---|
| `/api/health` | `version: 1.2.0`，`db: true` |
| 浏览器真实同步 | **114 次请求 / 0 个发往 aliyuncs.com / 0 失败** |
| 同步后状态 | 「已自动同步 (刚刚)」 |
| 服务端 `lastSyncedAt` | `admin: 2026-10-29 16:26:44`，108 篇文档 |

**并且即使再失败，也不再是笼统提示**：

修复前（1.1.8）：
> 无法连接到服务器（Failed to fetch）。可能原因：① 网络中断或服务器不可达；② 浏览器拦截了跨域请求（自定义请求头未被服务端允许）；③ 自建服务器地址配置错误。

修复后（1.2.0，未登录 + 桶无效场景，实测输出）：
> 无法连接对象存储 oss-cn-guangzhou.aliyuncs.com（Failed to fetch）。你的配置在格式上没有问题，但浏览器无法访问它，通常是以下三类原因之一：① 桶名「zhenglob」在服务端不存在（请到云控制台核对拼写）；② 该桶未配置 CORS 规则（需允许本页面来源的 GET/PUT/HEAD 请求）；③ 网络或 Endpoint 地域填写错误。建议先登录账号改用平台存储…

修复后（服务端不可达场景，实测输出）：
> 无法连接服务端 127.0.0.1:5178（Failed to fetch）。请依次确认：① 当前网络能否打开 127.0.0.1:5178；② 若使用自建服务器，检查「设置 → 服务器」中的地址是否正确（含端口与 https）；③ 若为官方部署，可能是服务端临时不可用，稍后重试。

### ②「PC 端绿色版能下载能跑吗？」 → **能，已发布到 GitHub Releases**

| 项 | 值 |
|---|---|
| 绿色版（免安装） | `NeoMD-1.2.0-win-x64.zip` — **151.9 MB**（159,308,688 B） |
| SHA256 | `4581dbc24945ab2f19f04cd396fc90283e1ed51900fa4627f7bbf31e2cadd3ab` |
| 安装包（附带） | `NeoMD-1.2.0-setup.exe` — **107.9 MB**（113,184,892 B） |
| SHA256 | `abd5aa0c6e71ca2162670902a8b5f5daa0fa2696ca119c08442c0556c56caaaa` |
| 下载地址 | https://github.com/myxiaolizi/neomd/releases/tag/v1.2.0 |
| 本机实测 | **38/38 通过**（12 静态 + 20 GUI + 6 便携模式） |

本机实测细节：解压到**含中文与空格的路径**（`...\Temp\nm 中文 路径测试 ...\我的 软件\Neo MD 绿色版\`）后启动，验证主窗口 `neomd://neomd/app` 加载成功、`window.NeoMD.bridge` 8 项 API 齐全、`env=desktop`、`contextIsolation` 未回退（`window.require`/`process` 均 undefined）、**本地仓库真读写**（写入含中文文件名的文档 → 列出 → 读回 → 与磁盘内容交叉验证）、多窗口未回退、便携模式切换后单实例锁仍生效。

---

## 一、验收结论总览

| 门禁 | 结果 |
|---|---|
| `tools/verify-119-full.mjs`（全量回归） | **110 通过 / 0 失败 / 1 跳过**（G4 因 `--skip-build` 跳过） |
| `tools/verify-120-sync-error.mjs`（本版核心） | **29 通过 / 0 失败** |
| `tools/verify-119-sync.mjs`（同步链路） | **66 通过 / 0 失败** |
| `tools/verify-120-portable.mjs`（绿色版） | **38 通过 / 0 失败** |
| `tools/verify-119-github.mjs`（GitHub 发布） | **18 通过 / 0 失败** |
| `tsc -p tsconfig.json`（含 `__tests__`） | **EXIT=0** |
| `vue-tsc --noEmit -p apps/web/tsconfig.json` | **EXIT=0** |
| `vitest run` | **204 passed / 0 failed** |
| `release-119.mjs check`（版本一致性） | **9/9 ✓** |
| 生产 `/api/health` | **1.2.0** |

---

## 二、1.2.0 新增断言（本版核心）

### 2.1 同步错误可定位化（`verify-120-sync-error.mjs`，29/29）

| # | 断言 | 实测 |
|---|---|---|
| A | 已登录 + 残留 `bucket:"zhenglob"` → 走平台代理 | **0 个**直连 OSS；122 个 `/api/storage/*` 全成功；UI 无「Failed to fetch」 |
| B | 未登录 + `zhenglob` → 提示含桶名/CORS | 含桶名 `zhenglob`、明确指向「对象存储」，**不再是笼统三选一** |
| C | 服务端不可达（route abort）→ 提示含具体 host | 含 `127.0.0.1:5178`（即 `location.host`） |
| D | **脏配置下回归**：同步仍成功 | 122 个存储请求全成功、0 个 OSS 直连、`lastSyncedAt` 回写 |
| E | 三条旧错误码分支可达 | `QUOTA_EXCEEDED` / `VAULT_DISABLED` / `VAULT_NOT_REGISTERED` 文案逐字命中 |

**A 的实测输出**：
```
✓ 0 个直连阿里云 OSS 的请求  [0 个]
✓ 同步确实走了 /api/storage/* 服务端代理  [122 个]
✓ /api/storage/* 无失败请求  [0 个]
✓ UI 未出现「Failed to fetch」/「同步失败」/ JS 异常 0 个
```

**D 段的意外发现（值得记录）**：登录后 `pullCloudSettings()` 会把服务端保存的 storage 配置**合并回本地**，而 admin 账号在生产库里确实还有 `bucket:"zhenglob"`。所以「客户端本地清空配置」是无效的——云端会覆盖回来。

因此 D 段从「清空配置后回归」改成「**脏配置下回归**」：`bucket="zhenglob"` 仍然存在，但同步依然 122 个请求全成功、0 个 OSS 直连。**这比原设计更有说服力**——它直接证明「已登录永不直连自建 S3」这个不变量在**生产脏数据**下也成立。

### 2.2 PC 绿色版（`verify-120-portable.mjs`，38/38）

| 类别 | 项数 | 关键断言 |
|---|---|---|
| 静态 | 12 | 白名单无幽灵条目、asar 内含全部 6 个 `.cjs`、artifactName 用 `${version}` |
| GUI 实测 | 20 | 主窗口加载、bridge 8 项 API、`contextIsolation` 未回退、本地仓库真读写、多窗口、无 `MODULE_NOT_FOUND` |
| 便携模式 | 6 | userData 切到 exe 同目录、单实例锁仍生效、默认模式不污染解压目录 |

**方法学亮点**：打包后的 exe **无法用脚本入口驱动**（上一版用 `electron.exe driver.cjs` 可行，是因为未打包运行时会把首参当入口；打包后入口固定为 app.asar 内 `main.cjs`，传脚本只进 `process.argv`）。改用 **`--remote-debugging-port` + CDP** 驱动，启动的就是**用户双击的那个 exe**，比注入驱动更接近真实使用。

### 2.3 GitHub 发布（`verify-119-github.mjs`，18/18）

```
✓ main HEAD = e7e5bc1
✓ main 树含 pnpm-workspace.yaml / apps / apps/web / apps/desktop / package.json
✓ main 树不含 src-tauri / build.ps1
✓ package.json 版本 = 1.2.0
✓ legacy-tauri 分支存在：db2d78d
✓ tag v1.2.0 指向 main 最新提交
✓ Release body 含 CHANGELOG 全部小标题 + 关键字 Failed to fetch / 绿色版
✓ 两个资产字节数与本地一致，且均可下载（302 预签名）
```

---

## 三、1.1.9 全量回归（`verify-119-full.mjs`，110/110）

| 段 | 通过 | 失败 |
|---|---|---|
| A 启动与首屏 | 6 | 0 |
| B 设置项逐项 | 19 | 0 |
| C 同步链路 | 13 | 0 |
| D 工作台交互 | 27 | 0 |
| E 图表插件 | 20 | 0 |
| F 后台与 AI | 23 | 0 |
| G 回归 | 3 | 0（G4 跳过） |
| **合计** | **110** | **0** |

**关键意义**：这套门禁来自 1.1.9，现在跑在 1.2.0 的代码上依然全绿——即本版改动**没有引入功能回归**。

---

## 四、本版修掉的真实缺陷

| # | 缺陷 | 严重度 | 根因 |
|---|---|---|---|
| 1 | 生产未部署 1.1.9，报障持续存在 | **P0** | `/api/health` 返回 1.1.8；用户报障的「Failed to fetch」在生产可 100% 复现 |
| 2 | `explainSyncError` 自身回归：新增诊断分支**永远执行不到** | **P0** | 1.1.8 首句是「message 含中文就透出」，storage 层补了中文后这句短路把新增分支全部吞掉。已改为「先判网络类型 → 三级诊断 → 非网络错误才透传中文」 |
| 3 | `withHostContext` 在相对路径下把整条 query 当 host | P1 | 同源部署时 `resolveApiUrl()` 返回相对路径，`new URL()` 失败 → host 退化为空 → fallback 取 `split('/')[0]` 得到空 → 最终展示 `无法连接服务端 /api/storage/list?prefix=index%2F...`。改为取 `location.host` 并剥 query |
| 4 | **1.1.8 起的死代码**：`QUOTA_EXCEEDED`/`VAULT_DISABLED`/`VAULT_NOT_REGISTERED` 三个分支从未生效 | P1 | `if (/[\u4e00-\u9fa5]/.test(raw)) return raw;` 排在所有错误码分支之前，而这三个分支的中文说法（「配额」「已停用」「请求超时」）都含中文 → 一律被短路。已把错误码分支提前 |
| 5 | `presign`（生成签名地址）路径抛裸 `Failed to fetch` | P1 | 该方法直接调 `transport.fetch` 未包装。已改用统一 `request()` 包装 |
| 6 | **构建假成功**：`tar` 压缩失败只打日志、退出码仍为 0 | P1 | 会产出「构建成功但没有绿色包」，或让上次的成功包被误当作本次产物发布。已改为非零退出，并在构建前清理同版本旧产物 |
| 7 | `electron-builder` 的 zip target 与 build.mjs 的 tar 产物**同名互覆盖** | P2 | 同一份 250MB 目录被压两遍、后写覆盖先写，既慢又分不清哪个是发布物。已移除 zip target |
| 8 | 打包白名单遗漏新模块 | **P0（会导致启动即崩）** | `portable.cjs` 是 1.2.0 新增，未加入 `files` 白名单会导致打包后 `MODULE_NOT_FOUND`，而**开发态完全不暴露**。已补入，并加了「白名单 vs 实际 require vs asar 内容」三方比对断言 |
| 9 | 版本一致性门禁**误报**（把注释当漏改） | P2 | 校验脚本全文正则，把 `build.mjs` 注释里的历史版本号当成硬编码。已改为先剥注释再匹配，并做了反向验证（代码里真硬编码仍能抓到） |
| 10 | 验收脚本参数解析**静默忽略**未识别写法 | P2 | `--version 1.1.9`（空格形式）被静默忽略 → 验收对象悄悄回落到 `package.json` 版本。已改为拒绝未识别参数并中止 |

---

## 五、已知缺陷与遗留风险（**门禁全绿不等于无缺陷**）

### 5.1 验收脚本曾把「已知缺陷」写进 note 却标 ✓（已修正）

**现象**：`verify-119-full.mjs` 的 E9b 断言标记为 ✓，但其 `note` 写着「4 个连线锚点被缩放手柄完全遮挡，用户无法从锚点拖出连线」，而实测是 `4/4 可达`——**自相矛盾**。

**核查结论**：该 note 是 **1.1.9 修复前的过时描述**。1.1.9 已修复此缺陷（锚点移出节点 `<g>` 并置于手柄之后），实测：
- `elementFromPoint` 四个锚点全部命中自身 ✓
- **从右锚点真实拖拽到另一节点，连线数 0→1** ✓

**已做的修正**（本版收口时）：
1. 把 E9b 的过时 note 改为「守住此缺陷不再回归」的准确描述；
2. 原 E9 段落里那段「锚点被遮挡所以不敢用拖拽验证」的注释改为「已修复」；
3. **新增 E9c 断言**：从锚点**真实拖拽**（`mouse.down` → `move` → `up`）并断言 `edges +1`。

**为什么新增 E9c 而不是只保留 E9b**：`elementFromPoint` 只证明「锚点在最上层」，不证明「拖拽链路能通」。1.1.9 修锚点遮挡时实际有**三层**缺陷叠加（被邻居节点盖住、被缩放手柄盖住、`hitHandle()` 判断排在锚点之前），只验 `elementFromPoint` 会漏掉第三层——「点得到锚点但拖出来是 resize」。E9c 实测通过：`连线 0→1`。

> **教训**：断言为 ✓ 但 note 描述着缺陷，是「门禁全绿但仍有用户可见问题」的典型形态。note 与断言必须一致；不一致时以**重新实测**为准，而不是相信任何一方。

### 5.2 服务端仍靠兜底才正确（遗留风险）

`verify-119-full.mjs` 的 C12「客户端只传相对 key」为 ✓，但 note 指出：当前是靠服务端 `toRelativeKey()` / `resolveScopedKey()` **反向剥离**才返回 200。

客户端行为已经对了（1.1.9 已改为边界处单向归一），服务端的反向剥离是**防御性兜底**。风险：若日后有人改动归一逻辑，会**静默串仓**（对象写到别的仓库前缀下）。建议后续版本移除该兜底，或加断言锁住。

### 5.3 生产库仍残留 `bucket:"zhenglob"`（不影响同步，但会误导排查）

1.2.0 已保证「已登录永不直连自建 S3」，D 段实测证明**脏配置下同步仍全绿**。但设置页会显示这份无效配置，误导排查。

清理入口：设置页「对象存储 → 重置对象存储配置」（**用户主动触发**）。服务端 `migrate-v2` **只做只读检测 + 日志**，不自动改写用户加密设置——在迁移脚本里解密、修改、重新加密的风险远大于收益。

### 5.4 `typewriterMode` / `letterSpacing` / `paragraphSpacing`（沿用 1.1.9 清单）

- `letterSpacing`（字距）、`paragraphSpacing`（段落间距）：`AppearanceSettings` 中不存在，属从未实现；
- `typewriterMode`（打字机模式）：只有类型定义、零消费点，1.1.9 已摘除 UI，字段保留以兼容云端设置。

### 5.5 未能验证的事项（如实记录）

1. **验收仓库 `qa119gate` 是否被脚本 `finally` 清理干净** —— 尝试核实时登录接口正处于限流状态（门禁刚做过 429 限流断言），未取得实测证据。脚本声明会自清理，但**未经验证**。
2. **`tools/verify-120-full.mjs` 未交付** —— 原计划由 qa-gate 产出「1.2.0 新增 + 1.1.9 回归」的合并门禁脚本，该任务未完成落盘。因此本报告改用**多个专项脚本并列**的方式覆盖同等范围：`verify-120-sync-error`（新增核心）+ `verify-120-portable`（绿色版）+ `verify-119-full`（全量回归）+ `verify-119-sync`（同步链路）+ `verify-119-github`（发布）。
3. **跨端布局同步的两端实测** —— 沿用 1.1.9 结论：基线机制已实现且单端「拖拽不被回滚」已实测，两端之间留待后续版本用干净的双浏览器上下文验证。

---

## 六、复现命令

```powershell
# 本版核心：同步错误可定位化（约 4-6 分钟，含限流等待）
node tools/verify-120-sync-error.mjs

# 绿色版产物与实测（需先构建）
node tools/verify-120-portable.mjs

# 全量回归（1.1.9 门禁跑在 1.2.0 代码上）
node tools/verify-119-full.mjs --skip-build

# 同步链路
node tools/verify-119-sync.mjs

# GitHub 发布状态
node tools/verify-119-github.mjs --version 1.2.0 --expect="Failed to fetch,绿色版"

# 版本一致性
node tools/release-119.mjs check

# 类型检查（两道，缺一不可）
npx tsc -p tsconfig.json
cd apps/web; npx vue-tsc --noEmit -p tsconfig.json

# 单元测试
npx vitest run
```

> **限流提醒**：登录 10 次/分钟、`/api/vaults` 写 20 次/分钟。脚本已内置 429 退避重试，但连续重跑建议间隔 60 秒。
>
> **deviceId**：所有脚本固定使用常量（如 `qa-verify-119-full`），避免每跑一次在云端堆积 `index/<deviceId>.json`。

---

## 七、结论

**1.2.0 可发布，且已发布。**

- 用户报障「同步失败：Failed to fetch」的根因已定位（1.1.9 未部署 + 残留错误桶配置），**生产已部署并实测验证**（114 请求 / 0 个 OSS 直连 / 0 失败）；
- 错误提示已从「三选一自己猜」改为**点名主机与操作的定向诊断**；
- PC 端绿色版已构建（151.9MB）、本机实测 38/38、已上传 GitHub Release；
- 1.1.9 全量门禁跑在 1.2.0 代码上 110/110，**无功能回归**；
- 本报告第 5 节如实列出了 3 处已知缺陷/风险与 3 项未能验证的事项，**不以「全绿」掩盖它们**。
