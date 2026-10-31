# 1.4.0 生产部署记录

- 目标环境：<https://md.zhengl.vip>
- 部署时间：2026-10-31 08:36 - 08:43（Asia/Shanghai）
- 部署前版本：**1.3.1**
- 部署后版本：**1.4.0**
- 部署方式：宝塔 MCP（`mcp__baota__*`）+ 精简部署包

---

## 一、部署前侦察

| 项 | 值 |
|---|---|
| 项目路径 | `/www/wwwroot/md.zhengl.vip` |
| 服务目录 | `server/`（入口 `src/server.js`，监听 `127.0.0.1:3200`） |
| 前端目录 | `public/` |
| 宝塔 Node 项目 | `neomd`（Node v24.14.1，运行用户 `www`） |
| 后端 `server/package.json` version | `1.3.1` |
| `.env` SHA256 | `4fe1cfdaed22b347c63a9b2b3efaa995935efa6fb6484171cc324eea4b0cb3c9` |

---

## 二、备份（回滚依据）

备份目录：`/www/backup/neomd-140-20261031-083612`

| 文件 | 说明 |
|---|---|
| `.env.bak` | 生产环境变量（数据库 / OSS / JWT 密钥） |
| `package.json.bak` | 旧版依赖清单（1.3.1） |
| `public.bak/` | 旧前端产物 |
| `server-src.tar.gz` | 旧后端源码 |

备份大小 3.8 MB。部署前 `.env` SHA256 记录为基线，部署后复核。

---

## 三、部署包

- 本地产物：`dist-artifacts/neomd-deploy-slim-140.tar.gz`（**5.4 MB**）
- 构成：`public/`（前端产物）+ `server/src/`（35 个 .js）+ `server/package.json` + **`server/releases/NeoMD-1.4.0.apk`**
- SHA256：`5115a27332ef2bd9ef2ebb4fcc090269248613258ae5098dd4371bfcfcf189b3`
- 上传路径：`/www/server/panel/data/agent/mcp_uploads/files/key_da0cf73a8110/1xoSDWyCsQOaK7Cz/neomd-deploy-slim-140.tar.gz`

### 为什么精简包这次要**带 APK**（与 1.3.1 不同）

1.3.1 部署时用的是不含 APK 的精简包，APK 靠事后单独上传到 `server/releases/`。本次发现这留下一个隐患：**APK 只存在于生产服务器**，本地 `services/api/releases/` 与 `dist-artifacts/deploy/server/releases/` 都没有它 —— 任何人用部署包重新部署，APK 就会再次丢失、客户端 404。

本次改为：先 `cp dist-artifacts/NeoMD-1.4.0.apk services/api/releases/`（**源头**），再让 `make-deploy.mjs` 自动带进部署包，最后部署包连 APK 一起上传。**这样部署链路本身就能自愈，不依赖事后手工补。**

---

## 四、部署步骤（实际执行的）

```bash
# 0. 备份（见第二节）

# 1. 解压到临时目录并核对
rm -rf /tmp/neomd140 && mkdir -p /tmp/neomd140
tar -xzf <uploaded.tar.gz> -C /tmp/neomd140
grep '"version"' /tmp/neomd140/server/package.json        # 1.4.0
ls -l /tmp/neomd140/server/releases/                       # NeoMD-1.4.0.apk 4410655 B
grep -c 'APP_VERSION' /tmp/neomd140/server/src/routes/download.js   # 5（动态推导在位）

# 2. 部署前端：先删 assets 再覆盖
cd /www/wwwroot/md.zhengl.vip
rm -rf public/assets
cp -a /tmp/neomd140/public/. public/

# 3. 部署后端源码（保留 .env 与 releases/）
rm -rf server/src
cp -a /tmp/neomd140/server/src server/src
cp -a /tmp/neomd140/server/package.json server/package.json

# 4. APK 就位（保留历史）
cp -f /tmp/neomd140/server/releases/NeoMD-1.4.0.apk server/releases/
chown -R www:www public server/src server/package.json server/releases
chmod 644 server/releases/NeoMD-1.4.0.apk

# 5. 语法自检
for f in $(find server/src -name '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 6. 依赖检查
cd server && node -e "const p=require('./package.json');const fs=require('fs');
  const m=Object.keys(p.dependencies||{}).filter(d=>!fs.existsSync('node_modules/'+d));
  console.log('missing:', m.length?m.join(','):'(none)')"

# 7. 重启（宝塔 Node 项目）
#    mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

**关键注意事项**

1. **必须先备份 `.env` 再动目录**。实测部署前后 `.env` SHA256 完全一致（`4fe1cfda...b0cb3c9`）。
2. **前端要先删 `public/assets` 再复制**。Vite 产物文件名带 contenthash，只覆盖不删除会累积旧 chunk，且可能出现「新 index.html 引用旧资源」导致白屏。
3. **`server/releases/` 必须保留**。本次是「保留历史 + 新增 1.4.0」，未删除任何历史 APK。
4. **部署前跑 `node --check` 全量语法自检** —— 服务起不来比版本旧更难排查。

---

## 五、部署后验证（逐项实测）

| 验证项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `/api/health` 版本 | `1.4.0` | `version: "1.4.0"`, `db: true` | ✅ |
| `.env` 完好 | SHA256 前后一致 | `4fe1cfda...b0cb3c9` 完全一致 | ✅ |
| `server/releases/` 完好 | 保留历史 + 新增 1.4.0 | 历史 APK 全在 + NeoMD-1.4.0.apk | ✅ |
| 全部 JS 语法 | 0 失败 | 35 个文件全通过 | ✅ |
| 依赖完整性 | 无缺失 | `missing: (none)` | ✅ |
| **下载清单** | 三项均为 1.4.0 | zip / exe / apk 全部 1.4.0 | ✅ |
| **APK 直下** | 200 + 字节数一致 | `200`，`4,410,655` B | ✅ |
| Windows 安装包 | 302 到 OSS | `302` + 预签名 URL | ✅ |
| 首页 | 200 | `200` | ✅ |
| 应用页 `/app` | 200 | `200` | ✅ |
| 生产库连接 | `db: true` | 是 | ✅ |

### 生产健康快照

```json
{"ok":true,"db":true,"uptime":72,"version":"1.4.0","env":"production","time":"2026-10-31T00:42:30.345Z"}
```

### 下载清单实测输出

```json
{"ok":true,"data":{"files":[
  {"file":"NeoMD-1.4.0-win-x64.zip","title":"Windows x64 绿色版","platform":"windows","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.4.0-win-x64.zip"},
  {"file":"NeoMD-1.4.0-setup.exe","title":"Windows x64 安装包","platform":"windows","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.4.0-setup.exe"},
  {"file":"NeoMD-1.4.0.apk","title":"Android APK","platform":"android","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.4.0.apk"}
]}}
```

> `size` 为 `null` 是有意为之：真实大小由响应头 `content-length` 给出，清单只做展示与白名单（1.3.1 起就不再写死字节数，避免每次发版手改漏改）。

---

## 六、数据库 schema 变更验证

本版 schema 变更全部是**幂等增量**，启动时由 `migrate-v2.js` 自动执行。实测验证（直连生产库 `information_schema`）：

```
users 新增列：ban_reason, banned_at, ban_until          ✅ 三列全部存在
release_downloads 表：EXISTS                            ✅
新增索引：
  audit_logs.idx_audit_logs_user_created
  audit_logs.idx_audit_logs_action_created
  community_plugins.idx_community_plugins_category
  community_plugins.idx_community_plugins_status        ✅ 全部存在
user_vaults 行数：4                                      ✅（1.4.0 清理后保持）
```

**幂等性自证**（在本地库上跑过两次）：
```
第一次：columns=3, declaredIndexes=3, releaseDownloadTables=1
第二次：columns=0, declaredIndexes=0, releaseDownloadTables=0
```

**零数据改动自证**：迁移前后逐表行数完全一致（users 3 / community_plugins 53 / audit_logs 3231 / user_vaults 10 / shares 10 / ai_usage 17）。

---

## 七、OSS 产物分发

```powershell
# 凭据从 services/api/.env 读取（PROJECT_CONTEXT.md 里记录的是旧 AK，已失效）
$env:OSS_AK = <services/api/.env 的 OSS_AK>
$env:OSS_SK = <services/api/.env 的 OSS_SK>
node tools/publish-releases.mjs
```

实测输出：
```
发布版本：1.4.0
产物：NeoMD-1.4.0-win-x64.zip / NeoMD-1.4.0-setup.exe / NeoMD-1.4.0.apk
2. 上传安装包
   OK NeoMD-1.4.0-win-x64.zip (151.98 MB)
   OK NeoMD-1.4.0-setup.exe (107.98 MB)
   OK NeoMD-1.4.0.apk (4.21 MB)
3. 验证匿名下载
   FAIL ... => 403
```

> **403 是预期的**：线上 `OSS_PUBLIC_READ=false`，桶策略明确禁止匿名访问。所有客户端下载都走 `/api/download/:file` → 302 预签名直链（大文件）或服务端直出（APK）。脚本第 3 步的匿名探测因此必然 403，**不影响下载功能** —— 真正的可达性由 `re14-release-gate.mjs` 的 HEAD 探测（走 `/api/download/`）验证，实测三端全部 OK。

---

## 八、回滚方法

```bash
BK=/www/backup/neomd-140-20261031-083612
cd /www/wwwroot/md.zhengl.vip

rm -rf public && cp -a "$BK/public.bak" public
rm -rf server/src && tar -xzf "$BK/server-src.tar.gz" -C server
cp -a "$BK/package.json.bak" server/package.json
cp -a "$BK/.env.bak" server/.env
chown -R www:www public server
# mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

回滚后 `curl https://md.zhengl.vip/api/health` 应返回 `version: "1.3.1"`。

**schema 不回滚**：新增的 3 列 / 1 表 / 3 索引对 1.3.1 完全兼容（1.3.1 不读它们），保留即可。回滚应用代码后「封禁/下载统计」功能不可用，但账号与数据不受影响。

---

## 九、遗留事项与环境风险

1. **🔴 生产服务反复非预期停机 —— 已定位到高度可疑的外部脚本（本次最重要的运维发现）**

   **现象**：1.4.0 部署完成、验证全绿后，约 7 分钟服务再次消失，公网 502。日志只有 `已停止`（优雅停机），没有崩溃堆栈、没有 OOM（服务器内存 31.5G / 空闲充足）。

   **排查过程与证据**：
   - 服务器上存在一个**每分钟执行的宝塔计划任务**：
     ```
     */1 * * * * /www/server/cron/0739fa5f5c7249b8e742e6fa02717fae
       → bash /www/wwwroot/jdy-push/watchdog.sh
     ```
   - `watchdog.sh` 是**另一个项目（jdy-push）**的进程守护脚本，第 2 步「清理残留进程」做两件事：
     ```bash
     OLD_PID=$(cat /www/server/nodejs/vhost/pids/jdy-push.pid)
     kill -TERM "$OLD_PID"; sleep 3; kill -9 "$OLD_PID"   # ← 危险点 1
     pkill -f "/www/wwwroot/jdy-push/src/server.js"        # ← 危险点 2
     ```
   - **危险点 1（PID 复用）**：它按 pid 文件里的数字直接 `kill -TERM`。如果那个 PID 在进程退出后**被系统复用**给 neomd，就会把 neomd 优雅停掉 —— **完美解释「SIGTERM + 优雅停机」而非崩溃**。实测当前 `jdy-push.pid` 内容为 `968207`，而 neomd 的 pid 是 `995723`，两者都是「宝塔 Node 项目」共用同一个 `pids/` 目录，写文件时机一旦交错就可能张冠李戴。
   - **危险点 2（模式过宽）**：`pgrep -af 'src/server.js'` 实测**同时命中 jdy-push 与 neomd 两个进程**。虽然当前脚本带完整路径前缀、暂时不会误杀 neomd，但只要有人把它简化成 `pkill -f "src/server.js"`（这是很自然的修改），就会**立刻杀掉所有同类 Node 项目**。

   **这是运维问题，不是代码缺陷**。建议（需在宝塔面板操作，属另一个项目的运维范围）：
   1. `watchdog.sh` 的 `kill` 前加**进程身份校验**（`/proc/$PID/cmdline` 是否含本项目路径），不匹配则跳过；
   2. `pkill -f` 改成 `pgrep -f` + 校验 cwd/端口后再 kill；
   3. 给 neomd 也配独立守护（或改 systemd），避免依赖「没人碰它」的脆弱状态。

2. **`PROJECT_CONTEXT.md` 的 OSS AK/SK 已过期**（`LTAI5tA5eb88...` → 实测 `InvalidAccessKeyId`）。当前有效值见 `services/api/.env`（`LTAI5t6DX1...`）。该文件已在 `.gitignore` 中，不进公开仓库。

3. **生产管理员密码 `6655` 出现在公开仓库的测试脚本里**（多个 `tools/*.mjs`，属既有惯例）。若仓库公开，这是真实凭据泄露 —— 建议改强密码 + 测试凭据改环境变量 + 为门禁单独建测试账号。

4. **`server/releases/` 已累积 12 个 APK（约 47 MB）**，可考虑只保留最近 3 个版本的本地缓存（历史版本由 OSS 承载），但需同步调整 `download.js` 的历史放行逻辑。

5. **Android APK 未做真机安装验证**：只验证了构建成功（`BUILD SUCCESSFUL`）与产物字节数/SHA256，未在真机或模拟器上安装启动。

---

## 十、发布后补修（如实记录）

部署完成、门禁全绿之后，仍发现并修掉两个问题：

### 10.1 根 `package.json` 被误覆盖（门禁直接瘫痪）

**现象**：跑最终门禁时 `vue-tsc` / `tsc` 双双报 `error TS2688: Cannot find type definition file for 'node'`。

**根因**：工作区的**根 `package.json` 被 `apps/desktop/package.json` 的内容覆盖**，只剩
```json
{ "name": "@neomd/desktop", "version": "1.4.0", "private": true, "type": "module", "main": "main.cjs" }
```
丢掉了 `name`/`description`/`engines`/`scripts`/`repository` **以及 `devDependencies`（含 `@types/node`）**。而 `apps/web/tsconfig.json` 的 `types: ["vite/client","node"]` 依赖它 → 类型解析失败。

**为什么会被提交**：`git add -A` 在跑完构建/打包之后执行，`electron-builder` 一类工具链会动 `package.json`，`-A` 把脏文件静默一起提交了。

**影响面**：**不影响已发布产物** —— 三个包在 8:19 构建完成，污染发生在 9:52 之后；GitHub Release 上的资产 SHA256 与构建产物一致。只影响本地门禁。

**修复**：从正确的 1.4.0 提交取回原内容写回 + `pnpm install` 恢复依赖。实测恢复后 `@types/node 22.19.1` 就位、`vue-tsc` 与 `tsc` 均 `EXIT=0`、五个 `package.json` 版本与 name 全部正确。

**教训**：`git add -A` 在构建之后是危险的。发布前必须 `git diff --cached --stat` 并**逐个核对关键配置文件**（`package.json` / `pnpm-lock.yaml` / `.gitignore`），不要盲提。

> 附带发现：用 `git show > file` 恢复时，PowerShell 的 `>` 重定向把 UTF-8 写成了 **UTF-16**（文件出现 `ÿþ` BOM，Node 报 `ERR_INVALID_PACKAGE_CONFIG`）。最终改用 Node 的 `execSync(encoding:'utf8')` + `fs.writeFileSync(..., 'utf8')`。**本仓库「禁止用 shell 重定向写含中文的文件」这条红线，对恢复配置文件同样适用。**

### 10.2 `verify-119-github.mjs` 仓库标识解析 bug（验收假失败）

**现象**：发布验收报「仓库 API 不可读 HTTP 404 / main 分支不存在 / tag v1.4.0 未找到 / Release 404」—— 看起来像发布完全失败。

**根因**：
```js
const repoParts = args.repo ? /^([\w.-]+)\/([\w.-]+)$/.exec(args.repo) : parseRepoField(pkg.repository);
const { owner, repo } = repoParts;   // ← 对象解构
```
两个分支返回的**类型不同**：`exec()` 返回**数组** `[全串, owner, repo]`，`parseRepoField()` 返回**字符串** `'owner/repo'`。对象解构对两者都取不到 `.owner`/`.repo` → 双双 `undefined` → 所有请求变成 `/repos/undefined/undefined/...` → 404。

**修复**：统一规范成 `owner/repo` 字符串再按字符串切分。实测 20/20 通过（tag 指向 main 最新提交、Release body 含全部小标题与关键字、三资产大小一致且均可下载）。

**教训**：**「验收脚本报失败」不等于「发布失败」** —— 先看脚本自己拼出的 URL / 打印的中间变量，再判断产品状态。
