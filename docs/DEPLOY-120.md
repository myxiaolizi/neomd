# 1.2.0 生产部署记录

- 目标环境：https://md.zhengl.vip
- 部署时间：2026-10-30 00:23（Asia/Shanghai）
- 部署前版本：**1.1.8**
- 部署后版本：**1.2.0**

---

## 一、为什么要这次部署

用户报障「同步失败：无法连接到服务器（Failed to fetch）」在生产环境可 100% 复现。根因不是新 bug，而是 **1.1.9 的修复从未部署上线**——`/api/health` 当时返回 `version: 1.1.8`，而 1.1.9 里「已登录永不直连自建 S3」的不变量只存在于源码中。

实测重现：登录 admin → 点同步 → 唯一失败请求发往
`https://zhenglob.oss-cn-guangzhou.aliyuncs.com/?list-type=2...` → `TypeError: Failed to fetch`

`zhenglob` 是拼错的桶名（真实桶 `zhengle`），1.1.8 的分支顺序让「自建 S3」判断排在「已登录」之前。

---

## 二、部署前侦察结果

| 项 | 值 |
|---|---|
| 项目路径 | `/www/wwwroot/md.zhengl.vip` |
| 后端 `server/package.json` version | `1.1.8` |
| 前端 `public/index.html` mtime | `Oct 28 16:05` |
| 磁盘可用 | 45G / 70G（37% 使用） |
| Node 版本 | v24.14.1 |
| CORS `allowedHeaders` | 已含 `x-vault-id` / `x-object-key` / `x-object-content-type` |
| 运行用户 | www |

> 注：CORS 白名单在 1.1.8 就已补全，所以本次故障**不是** CORS 问题——这也解释了为什么笼统提示里的「② 浏览器拦截了跨域请求」是误导项。

---

## 三、备份（回滚依据）

备份目录：`/www/backup/neomd-120-20261030-001541`

| 文件 | 大小 | 说明 |
|---|---|---|
| `.env.bak` | 914 B | 生产环境变量（含数据库/OSS/JWT 密钥） |
| `package.json.bak` | 642 B | 旧版依赖清单 |
| `public.bak/` | 3.7 MB | 旧前端产物 |
| `server-src.tar.gz` | 124 KB | 旧后端源码 |

---

## 四、部署包

- 本地产物：`dist-artifacts/neomd-deploy-slim.tar.gz`（**1.2 MB**）
- 构成：`public/`（3.2 MB 前端产物）+ `server/src/` + `server/package.json`
- **不含** `.env`、不含 `server/releases/`（历史 APK）、不含 `node_modules`

> 为什么做「精简包」：`tools/make-deploy.mjs` 生成的标准包有 38.7 MB，其中 41 MB 是 `server/releases/` 里的历史 APK。本次只需更新代码，不带 APK 可以把上传时间从数十秒降到 1 秒，也避免误覆盖。

上传路径：`/www/server/panel/data/agent/mcp_uploads/files/key_da0cf73a8110/Kum-zgIBeXwxXQdy/neomd-deploy-slim.tar.gz`
SHA256：`13d8a9223fa76598281367e88f44a06032d3df08da1cf84e33a59eac588d7921`

---

## 五、部署步骤（实际执行的）

```bash
# 1. 解压到临时目录并核对
rm -rf /tmp/neomd120 && mkdir -p /tmp/neomd120
tar -xzf <uploaded.tar.gz> -C /tmp/neomd120
cat /tmp/neomd120/server/package.json | grep version   # 应为 1.2.0

# 2. 部署前端（先删 assets 再覆盖，避免旧 chunk 残留导致「新 index.html 引用旧资源」）
cd /www/wwwroot/md.zhengl.vip
rm -rf public/assets
cp -a /tmp/neomd120/public/. public/

# 3. 部署后端源码（保留 .env 与 releases/）
rm -rf server/src
cp -a /tmp/neomd120/server/src server/src
cp -a /tmp/neomd120/server/package.json server/package.json

# 4. 权限
chown -R www:www public server/src server/package.json

# 5. 语法自检（关键：避免上线后起不来）
for f in $(find server/src -name '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 6. 依赖检查（本次无新增依赖）
node -e "const p=require('./server/package.json');const fs=require('fs');
  const m=Object.keys(p.dependencies||{}).filter(d=>!fs.existsSync('server/node_modules/'+d));
  console.log('missing:', m.length?m.join(','):'(none)')"

# 7. 重启（宝塔 Node 项目）
#    mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

**关键注意事项**

1. **必须先备份 `.env` 再动目录**。部署包里的 `.env` 是按本地配置生成的，线上数据库/OSS 配置与本地不同，覆盖会导致服务连不上库。
2. **前端要先删 `public/assets` 再复制**。Vite 产物文件名带 contenthash，只覆盖不删除会累积旧 chunk；更严重的是若 `index.html` 更新而旧 assets 未清，会出现「白屏」。
3. **`server/releases/` 必须保留**。APK 由服务端直出（阿里云 OSS 默认域名拦截 `.apk` 下载），删掉会导致客户端下载页 404。
4. 部署前跑 `node --check` 全量语法自检——服务起不来比版本旧更难排查。

---

## 六、部署后验证（逐项实测）

| 验证项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `/api/health` 版本 | `1.2.0` | `version: "1.2.0"`, `db: true` | ✅ |
| `.env` 完好 | 存在且可读 | `.env intact` | ✅ |
| `server/releases/` 完好 | 存在 | `releases intact` | ✅ |
| 全部 JS 语法 | 0 失败 | `all syntax OK` | ✅ |
| `config.version` | 1.2.0 | `config version: 1.2.0` | ✅ |
| 平台代付组不泄露 baseUrl | 0 个含 baseUrl | 8 个 platform provider，**0** 个含 baseUrl | ✅ |
| 登录 | 200 | token 253 字符 | ✅ |
| `/api/vaults` | 正常 | 2 个仓库 | ✅ |
| **浏览器真实同步** | 0 个直连 OSS | 114 次请求，**0 个 aliyuncs.com**，**0 失败** | ✅ |
| 同步后状态 | 「已同步」 | `已自动同步 (刚刚)` | ✅ |
| 服务端 `lastSyncedAt` 回写 | 非空 | `admin: 2026-10-29 16:26:44`，108 篇文档 | ✅ |

**最关键的一条**：修复前登录点同步，唯一失败请求发往 `zhenglob.oss-cn-guangzhou.aliyuncs.com`；修复后 114 次请求里 **0 个**发往 `aliyuncs.com`，全部走 `/api/storage/*` 服务端代理，全部成功。

---

## 七、回滚方法

```bash
BK=/www/backup/neomd-120-20261030-001541
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

回滚后 `curl https://md.zhengl.vip/api/health` 应返回 `version: "1.1.8"`。

---

## 八、遗留事项

1. **admin 账号云端设置里仍残留 `bucket:"zhenglob"`**。1.2.0 已保证「已登录永不直连自建 S3」，所以这条配置**不再影响同步**；但它会持续误导排查。清理入口是设置页「对象存储 → 重置对象存储配置」（用户主动触发，服务端不做自动改写——在迁移脚本里解密改写用户加密设置的风险远大于收益）。
2. `migrate-v2` 每次启动会打一条 warn 日志指出这条残留配置，属预期行为。
3. 移动端 APK 与 Windows 安装包需另行构建发布（`server/releases/` 里仍是旧版文件）。
