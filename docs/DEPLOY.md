# Neo MD 部署与运维手册

## 一、线上信息

| 项 | 值 |
| --- | --- |
| 站点 | <https://md.zhengl.vip> |
| 登录 | <https://md.zhengl.vip/login>（首页右上角也可弹窗登录） |
| 后台 | <https://md.zhengl.vip/admin>（仅管理员） |
| 分享页 | `https://md.zhengl.vip/s/<token>`（免登录） |
| 发布页 | `https://md.zhengl.vip/p/<slug>` |
| 服务器目录 | `/www/wwwroot/md.zhengl.vip` |
| 后端端口 | `127.0.0.1:3200` |
| 面板项目 | Node 项目 `neomd`，Node v24.14.1，运行用户 `www` |
| 数据库 | `neomd` @ `127.0.0.1:3306`（utf8mb4） |
| 对象存储 | 阿里云 OSS 桶 `zhengle`，前缀 `mdadmin/`，自定义域 `mdadmin.zhengl.vip` |

## 二、目录结构（服务器）

```
/www/wwwroot/md.zhengl.vip/
├─ public/          # 前端静态产物（Nginx 直出 / 后端 SPA 回退）
├─ server/          # 后端服务
│  ├─ src/          # 源码（纯 ESM）
│  ├─ node_modules/
│  └─ .env          # 生产配置（600，含密钥）
└─ DEPLOY.md
```

## 三、发版流程

1. 本机执行 `pnpm --filter @neomd/web build`。
2. `node tools/make-deploy.mjs` 生成 `dist-artifacts/neomd-deploy.tar.gz`。
3. 用宝塔 MCP 的 `Upload` 上传，然后在服务器：

```bash
cd /www/wwwroot/md.zhengl.vip
tar -xzf <上传路径> -C .
chown -R www:www public server
chmod -R u+rwX public server && chmod 600 server/.env
```

4. 前端为静态产物，覆盖即生效；后端改动需在面板重启 `neomd` 项目。

> 站点已关闭 Nginx 反向代理缓存（`proxy_cache off`），并给入口 HTML 加 `no-cache`，发版后无需手动清缓存。

## 四、环境配置（`server/.env`）

```ini
NODE_ENV=production
PORT=3200
HOST=127.0.0.1
WEB_ROOT=/www/wwwroot/md.zhengl.vip/public

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=neomd
DB_PASSWORD=***
DB_NAME=neomd

JWT_SECRET=***            # 访问令牌签名
JWT_REFRESH_SECRET=***    # 刷新令牌签名
SECRETS_KEY=***           # AES-256-GCM 密钥，加密用户 API Key

OSS_ENDPOINT=https://s3.oss-cn-guangzhou.aliyuncs.com
OSS_REGION=cn-guangzhou
OSS_BUCKET=zhengle
OSS_AK=***
OSS_SK=***
OSS_PUBLIC_DOMAIN=https://mdadmin.zhengl.vip
OSS_PREFIX=mdadmin/
OSS_PUBLIC_READ=false     # 私有桶：发布页由服务端代理输出

PUBLIC_BASE_URL=https://md.zhengl.vip
```

修改 `.env` 后必须重启 Node 项目。`SECRETS_KEY` 一旦更换，已加密存储的用户密钥将无法解密，需用户重新填写。

## 五、Nginx 关键配置

- `listen 80` + `listen 443 ssl`，证书 `/www/server/panel/vhost/cert/md.zhengl.vip/`（通配符 `*.zhengl.vip`，2027-01-13 到期）。
- `location /` 反向代理到 `127.0.0.1:3200`，并设置 `proxy_cache off`。
- 静态资源由后端 `@fastify/static` 托管，非 `/api`、`/p/` 的 GET 回退到 `index.html`。

> 注意：`/www/server/panel/vhost/rewrite/node_neomd.conf` 属于本站点伪静态，曾被其他部署写入跳转到 `md2.zhengl.vip` 的规则。如后台再次出现跳转，检查该文件是否被覆盖。

## 六、健康检查

```bash
curl -s https://md.zhengl.vip/api/health
# {"ok":true,"db":true,"uptime":...,"version":"1.0.0","env":"production"}
```

本机自动化：

```bash
node tools/smoke-api.mjs                     # 后端全链路（可设 SMOKE_BASE）
node tools/test-web.mjs                      # 浏览器端到端（27 项）
node tools/test-s3-prep.mjs && node tools/test-s3.mjs   # 真实 OSS 读写与签名
node tools/test-sync.mjs                     # 三方合并逻辑
```

## 七、账号与权限

- 管理员：`admin`（`admin@zhengl.vip`），口令在首次建库时生成并打印一次；遗失可在后台或数据库重置。
- 普通用户可在 `/login` 自助注册；管理员可在后台禁用、改角色、重置密码、删除。
- 登录限流：10 次/分钟/IP；注册 5 次/小时/IP；评论 20 次/小时/IP；AI 30 次/分钟/用户。

## 八、对象存储

- 平台桶为**私有**，`OSS_PUBLIC_READ=false`：发布页由服务端签名读取后输出 HTML，上传接口返回 7 天预签名地址。
- 若后续把桶改为公共读，将 `OSS_PUBLIC_READ` 改为 `true` 可切回 302 直链，降低服务器带宽。
- 用户目录规范：图片 `us/<用户名>/tupian/<yyyyMM>/`，备份 `us/<用户名>/bk/`，其他 `us/<用户名>/ot/`，管理员个人区 `admin/`。

## 九、常见问题

| 现象 | 排查 |
| --- | --- |
| 页面 502 | 面板确认 `neomd` 项目运行中；`tail /www/wwwlogs/nodejs/neomd.log` |
| 后台跳转到 md2 | 检查 `vhost/rewrite/node_neomd.conf` 是否被写入 302 规则 |
| 发版后仍是旧页面 | 确认 `proxy_cache off` 生效，浏览器强刷 |
| 上传/发布失败 | 核对 `OSS_*` 与 `s3.oss-<region>.aliyuncs.com` 端点；跑 `test-s3.mjs` |
| 分享页 404 | 链接被撤销或过期；后台「分享」可查看状态 |
