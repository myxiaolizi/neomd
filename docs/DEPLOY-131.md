# 1.3.1 生产部署记录

- 目标环境：<https://md.zhengl.vip>
- 部署时间：2026-10-30 22:29 - 22:42（Asia/Shanghai）
- 部署前版本：**1.2.0**（生产实际运行版本）
- 部署后版本：**1.3.1**
- 部署方式：宝塔 MCP（`mcp__baota__*`）+ 精简部署包

---

## 一、部署前侦察

| 项 | 值 |
|---|---|
| 项目路径 | `/www/wwwroot/md.zhengl.vip` |
| 服务目录 | `server/`（入口 `src/server.js`，监听 `127.0.0.1:3200`） |
| 前端目录 | `public/` |
| 宝塔 Node 项目 | `neomd`（Node v24.14.1，运行用户 `www`） |
| 后端 `server/package.json` version | `1.2.0` |
| 前端 `public/index.html` mtime | `Oct 30 00:13` |
| `.env` SHA256 | `4fe1cfdaed22b347c63a9b2b3efaa995935efa6fb6484171cc324eea4b0cb3c9` |
| `server/releases/` | 10 个历史 APK（1.0.0 ~ 1.1.8） |

### ⚠️ 部署开始前发现的服务中断（已先行恢复）

侦察时 `https://md.zhengl.vip` 返回 **502**，宝塔 `NodeProjectInfo` 显示 `run: false`，`127.0.0.1:3200` 无监听。生产日志末尾显示：

```
{"level":30,"time":1793351934985,"service":"neomd-api","signal":"SIGTERM","msg":"开始优雅停机"}
{"level":30,"time":1793351934987,"service":"neomd-api","msg":"已停止"}
```

时间戳 `1793351934985` ≈ 2026-10-30 17:18:54。即**在本次工作开始前不久，生产服务被某个外部操作优雅停止**（不是崩溃、不是 OOM —— 内存 3.6G 中用 1.8G，负载 0.04）。

处置：先 `NodeProjectControl start` 恢复服务（`/api/health` 恢复 200，`version: 1.2.0`），确认线上可用后再按计划做版本升级。**未在故障状态下直接覆盖部署**，避免把「服务起不来」和「代码有问题」两个变量混在一起。

---

## 二、备份（回滚依据）

备份目录：`/www/backup/neomd-131-20261030-222943`

| 文件 | 大小 | 说明 |
|---|---|---|
| `.env.bak` | 914 B | 生产环境变量（数据库 / OSS / JWT 密钥） |
| `package.json.bak` | 642 B | 旧版依赖清单（1.2.0） |
| `public.bak/` | 3.7 MB | 旧前端产物 |
| `server-src.tar.gz` | 138 KB | 旧后端源码 |
| `releases.bak/` | 41 MB | 历史 APK |

**部署前 `.env` SHA256**：`4fe1cfdaed22b347c63a9b2b3efaa995935efa6fb6484171cc324eea4b0cb3c9`

---

## 三、部署包

- 本地产物：`dist-artifacts/neomd-deploy-slim-131.tar.gz`（**1.23 MB**）
- 构成：`public/`（前端产物）+ `server/src/`（35 个 .js）+ `server/package.json`
- **不含** `.env`（生产配置与本地不同，覆盖会导致服务连不上库）、**不含** `server/releases/`（历史 APK 由服务器保留）、**不含** `node_modules`（无新增依赖）
- 上传路径：`/www/server/panel/data/agent/mcp_uploads/files/key_da0cf73a8110/b9qjg5My3zWxnx1p/neomd-deploy-slim-131c.tar.gz`
- SHA256：`2baa912425b6bfe34b4650f799c9462743ead76cabcbc08b4d7076c01e7c1ed3`

> **为什么用精简包**：标准包 `neomd-deploy.tar.gz` 是 38.7 MB，其中绝大部分是 `server/releases/` 里的历史 APK。本次只需更新代码，不带 APK 可以把上传时间从数十秒降到 1 秒，也避免误覆盖线上 APK。

---

## 四、部署步骤（实际执行的）

```bash
# 0. 备份（见第二节）

# 1. 解压到临时目录并核对版本
rm -rf /tmp/neomd131c && mkdir -p /tmp/neomd131c
tar -xzf <uploaded.tar.gz> -C /tmp/neomd131c
grep '"version"' /tmp/neomd131c/server/package.json      # 应为 1.3.1

# 2. 确认包内确实含本次修复（关键！见第六节踩坑）
grep -c 'APP_VERSION' /tmp/neomd131c/server/src/routes/download.js   # 应为 5

# 3. 部署前端：先删 assets 再覆盖
cd /www/wwwroot/md.zhengl.vip
rm -rf public/assets
cp -a /tmp/neomd131c/public/. public/

# 4. 部署后端源码（保留 .env 与 releases/）
rm -rf server/src
cp -a /tmp/neomd131c/server/src server/src
cp -a /tmp/neomd131c/server/package.json server/package.json

# 5. 权限
chown -R www:www public server/src server/package.json

# 6. 语法自检
for f in $(find server/src -name '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 7. 依赖检查（本次无新增依赖）
cd server && node -e "const p=require('./package.json');const fs=require('fs');
  const m=Object.keys(p.dependencies||{}).filter(d=>!fs.existsSync('node_modules/'+d));
  console.log('missing:', m.length?m.join(','):'(none)')"

# 8. APK 就位（服务端直出，OSS 拦截 .apk）
cp -f <uploaded.apk> server/releases/NeoMD-1.3.1.apk
chown www:www server/releases/NeoMD-1.3.1.apk && chmod 644 server/releases/NeoMD-1.3.1.apk

# 9. 重启（宝塔 Node 项目）
#    mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

**关键注意事项**

1. **必须先备份 `.env` 再动目录**。部署包里的 `.env` 是按本地配置生成的，线上数据库/OSS 配置与本地不同，覆盖会导致服务连不上库。实测本次部署前后 `.env` SHA256 完全一致。
2. **前端要先删 `public/assets` 再复制**。Vite 产物文件名带 contenthash，只覆盖不删除会累积旧 chunk；更严重的是若 `index.html` 更新而旧 assets 未清，会出现白屏。
3. **`server/releases/` 必须保留**。APK 由服务端直出（阿里云 OSS 默认域名拦截 `.apk` 下载），删掉会导致客户端下载页 404。
4. **部署前跑 `node --check` 全量语法自检** —— 服务起不来比版本旧更难排查。

---

## 五、部署后验证（逐项实测）

| 验证项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `/api/health` 版本 | `1.3.1` | `version: "1.3.1"`, `db: true` | ✅ |
| `.env` 完好 | SHA256 前后一致 | `4fe1cfda...b0cb3c9` 完全一致 | ✅ |
| `server/releases/` 完好 | 保留历史 APK | 10 个历史 APK + 新增 1.3.1 | ✅ |
| 全部 JS 语法 | 0 失败 | 35 个文件全通过 | ✅ |
| 依赖完整性 | 无缺失 | `missing deps: (none)` | ✅ |
| 前端资源引用 | 无 404 | 3 个 asset 全部存在 | ✅ |
| 首页 | 200 | `200` | ✅ |
| 应用页 `/app` | 200 | `200` | ✅ |
| **下载清单** | 三项均为 1.3.1 | zip / exe / apk 全部 1.3.1 | ✅ |
| **APK 直下** | 200 + 字节数一致 | `200`，`4,363,947` B（SHA256 一致） | ✅ |
| **历史 APK 仍可下** | 200 | `NeoMD-1.1.8.apk` → `200`，`4,338,972` B | ✅ |
| Windows 安装包 | 302 到 OSS 且可下 | `302` → 实下 `113,187,877` B | ✅ |
| Windows 绿色版 | 302 到 OSS 且可下 | `206`（分段请求）`1,048,576` B | ✅ |
| 生产库连接 | `db: true` | 是 | ✅ |

### 生产健康快照

```json
{"ok":true,"db":true,"uptime":44,"version":"1.3.1","env":"production","time":"2026-10-30T14:34:55.122Z"}
```

### 下载清单实测输出

```json
{"ok":true,"data":{"files":[
  {"file":"NeoMD-1.3.1-win-x64.zip","title":"Windows x64 绿色版","platform":"windows","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.3.1-win-x64.zip"},
  {"file":"NeoMD-1.3.1-setup.exe","title":"Windows x64 安装包","platform":"windows","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.3.1-setup.exe"},
  {"file":"NeoMD-1.3.1.apk","title":"Android APK","platform":"android","size":null,"url":"https://md.zhengl.vip/api/download/NeoMD-1.3.1.apk"}
]}}
```

> `size` 为 `null` 是**有意为之**：旧实现把字节数写死在代码里，每次发版都要手改（正是 1.2.0 APK 404 的根因）。现在真实大小由响应头 `content-length` 给出，清单只做展示与白名单。

---

## 六、部署过程中踩的两个坑（如实记录）

### 坑1：APK 仍 404 —— 根因是代码里的硬编码清单，不是部署失误

第一次部署完成后 `/api/download/NeoMD-1.3.1.apk` 返回 **404**，且 `NeoMD-1.3.1-setup.exe` 的 302 指向的 OSS 对象不存在。

排查发现 `services/api/src/routes/download.js` 的 `DOWNLOAD_FILES` **硬编码 1.1.8** 的文件名，而下载入口 `findFile()` 用它做**白名单** —— 清单里没有的文件，即使磁盘上真有也永远 404。

**这正是 1.2.0 发布时「APK 缺失」的真正原因**（当时的发布日志记的是「缺少 1 个必需产物：NeoMD-1.2.0.apk」，其实 APK 已放进 `server/releases/`，只是清单没登记）。

修复后清单从 `services/api/package.json` 的 `version` 推导，并把磁盘上的历史 APK 动态登记为「仅放行白名单」的条目（旧链接继续可用，又不污染下载页卡片）。

### 坑2：重新打包时 `Copy-Item` 把 `src` 目录嵌套了

修完 `download.js` 后重新打包，用 PowerShell：

```powershell
Copy-Item services\api\src "$stage\server\src" -Recurse -Force
```

因为 `$stage\server\src` **已存在**，PowerShell 会把源目录**整个放进目标目录内部**，得到 `server/src/src/...`。

结果：上传的包**不含修复**，部署后 APK 依然 404。

**发现方式**（关键）：部署后执行

```bash
grep -c 'APP_VERSION' server/src/routes/download.js
```

得到 `0`（期望 `5`）。修正打包方式（显式建目录 + 复制**内容**）后二次部署才生效。

> **教训**：**部署后必须验证「产物里真的有这次修复」**，不能只看「命令成功 + health 版本对」。版本号对上只证明 `package.json` 到了位，**不证明业务代码到了位**。1.1.2 那次事故（构建时间早于源码落盘时间）是同一个教训的另一面。

---

## 七、OSS 产物分发

由于本地 `.env` 里的阿里云 AK 已轮换（`PROJECT_CONTEXT.md` 记录的是旧 AK，实测 `InvalidAccessKeyId`），**改用服务器端脚本从 `server/.env` 读凭据上传**，凭据不出服务器。

上传结果：

```
版本: 1.3.1
✓ 已上传 NeoMD-1.3.1-win-x64.zip 151.9 MB
✓ 已上传 NeoMD-1.3.1-setup.exe 107.9 MB
✓ 已上传 NeoMD-1.3.1.apk 4.2 MB
```

对象键：`mdadmin/releases/NeoMD-1.3.1-*`（与下载页 302 目标一致）。

> **凭据轮换提醒**：`PROJECT_CONTEXT.md` 第三节记录的 OSS AccessKeyId（`LTAI5tA5eb88...`）/ Secret 已失效。下次在本机跑 `tools/publish-releases.mjs` 前需先更新为当前有效凭据（当前有效值见 `services/api/.env` 的 `OSS_AK` / `OSS_SK`，以 `LTAI5t6DX1...` 开头）。

---

## 八、回滚方法

```bash
BK=/www/backup/neomd-131-20261030-222943
cd /www/wwwroot/md.zhengl.vip

# 1. 还原前端
rm -rf public && cp -a "$BK/public.bak" public

# 2. 还原后端源码
rm -rf server/src && tar -xzf "$BK/server-src.tar.gz" -C server

# 3. 还原 package.json 与 .env
cp -a "$BK/package.json.bak" server/package.json
cp -a "$BK/.env.bak" server/.env

# 4. 权限与重启
chown -R www:www public server
# mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

回滚后 `curl https://md.zhengl.vip/api/health` 应返回 `version: "1.2.0"`。

**回滚不会回退的数据**：本版无数据库 schema 变更，无需数据回滚。`pruneVersions` 默认策略放宽（30/50 → 180/200）只影响未来行为，已产生的版本文件不回删。

---

## 九、遗留事项

1. **生产管理员密码 `6655` 出现在公开仓库的测试脚本里**（`tools/verify-119-full.mjs` 等 8 个已跟踪文件，属**既有**惯例，本版沿用了同一模式新增若干 `re121-*.mjs`）。若仓库为公开仓库，这是**真实凭据泄露**，建议：
   - 立即把生产管理员密码改为强密码；
   - 测试凭据统一改从环境变量读取（`SMOKE_PASS`），代码里不留默认值；
   - 后续新建测试账号专用于门禁，与生产管理员解耦。
2. **`PROJECT_CONTEXT.md` 的 OSS AK/SK 已过期**，需要更新为当前有效值（该文件已在 `.gitignore` 中，不进公开仓库）。
3. **`server/releases/` 累积了 11 个 APK（约 46 MB）**，可考虑只保留最近 3 个版本的本地缓存（历史版本由 OSS 承载），但需同步调整 `download.js` 的历史放行逻辑。
4. **Android APK 未做真机安装验证**：本次只验证了 `BUILD SUCCESSFUL` 与产物字节数/SHA256，未在真机或模拟器上安装启动。
