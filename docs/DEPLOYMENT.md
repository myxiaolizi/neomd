# Neo MD 自建部署指南

本文面向**在自己服务器上部署 Neo MD 服务端与前端**的运维 / 开发者。按本文完成后，你会得到一个可访问的站点，并能让 PC 客户端通过「设置 → 服务器」指向它（见 [SELF_HOSTING.md](./SELF_HOSTING.md)）。

- 适用版本：`1.0.x`（`1.0.2` 实测）
- 部署目标：Linux（本文以宝塔面板 CentOS / Ubuntu 为例，命令在 Debian 系与 RHEL 系通用；systemd 路径差异会单独标注）
- Windows Server 亦可部署，差异见 [第十三节](#十三常见问题)

**目录**

1. [部署前必读](#一部署前必读)
2. [服务器要求](#二服务器要求)
3. [准备数据库](#三准备数据库mysql-8)
4. [获取代码与安装依赖](#四获取代码与安装依赖)
5. [配置环境变量](#五配置环境变量serverenv)
6. [构建前端](#六构建前端)
7. [首次启动与管理员账号](#七首次启动与管理员账号)
8. [用宝塔面板托管 Node 项目](#八用宝塔面板托管-node-项目)
9. [Nginx 反向代理](#九nginx-反向代理)
10. [对象存储配置](#十对象存储配置)
11. [验证部署](#十一验证部署)
12. [升级与回滚](#十二升级与回滚)
13. [常见问题](#十三常见问题)
14. [知识库 API](#十四知识库-api)

---

## 一、部署前必读

### 1.1 部署形态

Neo MD 是 **前后端一体的单站点应用**：

| 组成 | 技术 | 作用 |
| --- | --- | --- |
| 前端 | Vue 3 SPA（静态产物） | 编辑器、个人中心、管理后台、分享页 |
| 后端 | Fastify 5（Node ESM，**无构建步骤**） | 认证、账号、积分、设置、分享、发布、上传、AI 代理、插件、后台 |

后端本身可以直接托管前端静态产物（`@fastify/static` + SPA 回退），因此**最简部署只需要一个 Node 进程 + 一个 MySQL**。

### 1.2 必须准备的资源

| 资源 | 是否必需 | 说明 |
| --- | --- | --- |
| 域名 + HTTPS 证书 | 强烈建议 | 客户端与服务端跨域通信、分享链接、OAuth 回调都依赖稳定域名 |
| Linux 服务器 | 必需 | 2 核 4 GB 起步，见第二节 |
| MySQL 8.0 | 必需 | 账号、分享、发布、审计、平台 AI 配置等 17 张表 |
| S3 兼容对象存储 | **必需（启动强制校验）** | 见 1.4 |
| 宝塔面板 | 可选 | 用于进程守护与 Nginx 管理；不用面板可走 systemd + 手写 Nginx |

### 1.3 插件市场不支持私有化

> **明确声明**：**插件市场（应用商店）始终使用官方统一服务，不支持私有化部署。**
>
> 自建服务端只接管**数据平面**：账号与登录、云端设置、对象存储密钥、积分、分享、发布、审计。插件市场的浏览、下载计数、发布与审核仍由官方服务提供。即使你把 PC 端「设置 → 服务器」指向自己的地址，也不影响这一行为。

### 1.4 对象存储为什么是必填

服务端在**进程启动时**读取配置并做强校验（`services/api/src/config.js`）：

```js
bucket: required('OSS_BUCKET'),
accessKeyId: required('OSS_AK'),
accessKeySecret: required('OSS_SK'),
```

缺失任一项，`buildConfig()` 会在模块加载阶段抛出异常，进程立即退出。**这意味着没有对象存储时服务端起不来。**

如果只是本地试用、暂时不想接入对象存储，可以先填占位值（例如 `OSS_BUCKET=placeholder`、`OSS_AK=placeholder`、`OSS_SK=placeholder`）让进程启动，但以下功能会失败：

- 头像上传
- 云端备份
- 分享页 / 发布页的 HTML 与静态资源读写
- 客户端安装包（`.zip` / `.exe` / `.apk`）分发
- 用户自带 Key 的对象存储连通性探测

**生产环境请务必配置真实的 S3 兼容存储**，见[第十节](#十对象存储配置)。

---

## 二、服务器要求

### 2.1 硬件

| 规模 | 配置建议 |
| --- | --- |
| 个人 / 小团队（≤ 20 人） | 2 核 CPU / 4 GB 内存 / 40 GB SSD |
| 部门级（≤ 200 人） | 4 核 CPU / 8 GB 内存 / 100 GB SSD |
| 更大规模 | 前后端分离部署，MySQL 独立实例，对象存储承担全部静态与附件流量 |

对象存储承载附件与安装包后，服务器主要承担 API 与 SPA 静态文件，磁盘压力很小。

### 2.2 软件

| 组件 | 版本 | 校验方式 |
| --- | --- | --- |
| Node.js | **≥ 20.19**（推荐 24.x LTS） | `node -v` |
| pnpm | **12.x** | `pnpm -v` |
| MySQL | **8.0**（`utf8mb4`） | `mysql -V` |
| Nginx | ≥ 1.20（用宝塔时自带） | `nginx -v` |
| 编译工具链 | `python3` + `make` + `g++` | 仅当 `argon2` 无预编译包时需要 |

> `argon2` 是原生模块。官方在主流 Linux x64 / arm64 上提供预编译二进制，通常无需本地编译；若安装阶段出现 `node-gyp` 报错，安装 `build-essential python3` 后重试。

### 2.3 网络与端口

| 端口 | 用途 | 对外开放 |
| --- | --- | --- |
| 80 | HTTP（跳转 HTTPS / ACME 校验） | 是 |
| 443 | HTTPS | 是 |
| 3200 | Fastify 监听端口 | **否**，只允许 `127.0.0.1` |

`HOST=127.0.0.1` 是默认值，也是推荐值 —— 后端只监听回环地址，由 Nginx 统一入口并终止 TLS。

---

## 三、准备数据库（MySQL 8）

`schema.sql` 只包含 `CREATE TABLE IF NOT EXISTS`（17 张表），**不包含 `CREATE DATABASE`**，因此数据库与账号需要先手工创建。

```sql
-- 用 root 登录 MySQL 后执行
CREATE DATABASE `neomd`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'neomd'@'127.0.0.1' IDENTIFIED BY 'change-me-strong-db-password';

GRANT ALL PRIVILEGES ON `neomd`.* TO 'neomd'@'127.0.0.1';
FLUSH PRIVILEGES;
```

要点：

- **字符集必须是 `utf8mb4`**，否则中文、emoji 与部分符号会写入失败或被截断。
- 账号主机用 `127.0.0.1`（走 TCP）而不是 `localhost`（可能走 socket），与服务端 `DB_HOST=127.0.0.1` 保持一致。
- 上面 `change-me-strong-db-password` 是占位符，请替换为你自己的强密码，并同步写入 `.env`。
- 建表、增量补列与管理员初始化由服务端**启动时自动完成**，无需手工导入 SQL。

如果数据库在另一台机器，请把 `'neomd'@'127.0.0.1'` 换成实际来源 IP 或网段，并确认防火墙放行。

---

## 四、获取代码与安装依赖

```bash
# 1. 拉取代码（把 <repo-url> 换成你的仓库地址）
git clone <repo-url> neomd
cd neomd

# 2. 安装全部工作区依赖
pnpm install

# 3. 如只部署服务端，可只装后端依赖
pnpm --filter @neomd/api install --prod
```

后端是纯 ESM JavaScript，**没有编译步骤**（`services/api/package.json` 的 `build` 脚本只打印一句提示）。前端是 Vite 构建产物。

仓库根目录结构见 [README 目录结构](../README.md#目录结构)。

---

## 五、配置环境变量（`server/.env`）

### 5.1 创建文件

```bash
cd services/api
cp .env.example .env
chmod 600 .env        # 仅属主可读写
```

配置读取优先级（`services/api/src/config.js`）：

```text
真实进程环境变量  >  .env.local  >  .env
```

即 `.env.local` 会覆盖 `.env`，而 `pm2` / `systemd` / 宝塔注入的环境变量优先级最高。

### 5.2 字段全表

下表与代码实现一一对应（含 `.env.example` 中未列出的隐藏字段）。

#### 基础

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 否 | `development` | 生产环境填 `production`，影响日志级别、`trustProxy` 默认值与静态资源缓存策略 |
| `PORT` | 否 | `3200` | 监听端口，取值 1–65535 |
| `HOST` | 否 | `127.0.0.1` | 监听地址。**不要改成 `0.0.0.0`**，除非你明确要用防火墙直连后端 |
| `TRUST_PROXY` | 否 | 生产为 `true` | 位于 Nginx 之后时必须为 `true`，否则限流会把所有访客识别成 Nginx 的 IP |
| `WEB_ROOT` | 否 | `<services/api>/public` | 前端静态产物目录，生产建议绝对路径 |
| `PUBLIC_BASE_URL` | 否 | `http://127.0.0.1:3200` | 对外访问基址，**分享链接与发布链接据此拼接**，生产必须填真实域名（不带结尾斜杠） |
| `LOG_LEVEL` | 否 | 生产 `info` / 开发 `debug` | Fastify（pino）日志级别 |

#### 数据库

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DB_HOST` | 否 | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | 否 | `3306` | MySQL 端口 |
| `DB_USER` | **是** | 无 | 数据库账号 |
| `DB_PASSWORD` | **是** | 无 | 数据库密码，**不要写进任何文档或提交到仓库** |
| `DB_NAME` | **是** | 无 | 数据库名 |
| `DB_POOL_SIZE` | 否 | `10` | 连接池上限，取值 1–100 |

#### 密钥

| 变量 | 必填 | 格式 | 说明 |
| --- | --- | --- | --- |
| `JWT_SECRET` | **是** | 字符串，**≥ 32 字符**（推荐 64 位十六进制） | 访问令牌（Access Token）签名密钥，有效期固定 15 分钟 |
| `JWT_REFRESH_SECRET` | **是** | 同上 | 刷新令牌签名密钥，有效期固定 30 天 |
| `SECRETS_KEY` | **是** | **恰好 32 字节的 base64** | AES-256-GCM 主密钥，用于加密存储用户的对象存储 / AI 密钥 |

> **`SECRETS_KEY` 一旦更换，已加密存储的用户密钥将无法解密**，所有用户都需要重新填写对象存储与 AI 密钥。请把它纳入备份。

### 5.3 生成安全随机值

不要手写密钥。任选一组命令：

```bash
# Linux / macOS：64 位十六进制（32 字节）用于两个 JWT 密钥
openssl rand -hex 32

# Linux / macOS：32 字节 base64（SECRETS_KEY 必须是这个格式）
openssl rand -base64 32
```

```bash
# Node 备选（跨平台）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```powershell
# Windows PowerShell 备选
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 })).ToLower()
```

> 校验口径：`JWT_SECRET` / `JWT_REFRESH_SECRET` 长度不足 32 字符会直接抛错；`SECRETS_KEY` 经 base64 解码后不是 32 字节也会直接抛错。

#### 对象存储（S3 兼容）

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `OSS_ENDPOINT` | 否 | `https://s3.cn-guangzhou.aliyuncs.com` | S3 兼容端点。阿里云 OSS 用 `https://s3.oss-<region>.aliyuncs.com` |
| `OSS_REGION` | 否 | `cn-guangzhou` | 签名 Region，必须与端点匹配 |
| `OSS_BUCKET` | **是** | 无 | 桶名 |
| `OSS_AK` | **是** | 无 | AccessKeyId |
| `OSS_SK` | **是** | 无 | AccessKeySecret |
| `OSS_PUBLIC_DOMAIN` | 否 | 空 | 桶的自定义访问域名，用于拼接公开 URL；私有桶可留空 |
| `OSS_PREFIX` | 否 | `mdadmin/`（代码默认值） | 平台数据根前缀，自动补结尾 `/`。用户数据位于 `<prefix>neomd/users/<username>/`。**自建建议改成自己的前缀**（如 `neomd/`），避免与他人共用同一桶时冲突 |
| `OSS_PUBLIC_READ` | 否 | `false` | `true`：桶允许匿名读，发布页 302 跳到公共域名；`false`：由服务端签名代理输出 |
| `OSS_PRIVATE` | 否 | `!OSS_PUBLIC_READ` | 显式标记私有桶；一般无需设置 |
| `OSS_URL_STYLE` | 否 | `virtual-hosted` | URL 风格，可选 `path` / `virtual-hosted`。**阿里云 S3 兼容端点必须用 `virtual-hosted`**，否则报 `SecondLevelDomainForbidden` |

#### 管理员与 CORS

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | 否 | 代码内置的官方默认邮箱 | **初始管理员邮箱，自建请务必改成自己的**（默认值指向官方域，继续沿用会导致管理员账号落在示例邮箱上） |
| `ADMIN_USERNAME` | 否 | `admin` | 初始管理员用户名 |
| `ADMIN_PASSWORD` | 否 | 空 | 初始管理员密码。**留空或少于 8 字符时，系统自动生成 20 位随机密码并仅在首次启动时打印一次** |
| `CORS_ORIGINS` | 否 | 见下 | 允许的跨域来源，逗号分隔 |

`CORS_ORIGINS` 默认值（代码内置，含官方站点域名与两个本地开发端口）：

```text
https://<官方站点域名>,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173
```

> 官方站点域名是**内建放行**的（`services/api/src/server.js` 中的 `builtinOrigins`），即使你在 `CORS_ORIGINS` 里不写它也不会被拦。自建时请把你的域名加进去。

跨域放行规则（`services/api/src/server.js`）：

- 无 `Origin` 的请求、`Origin: null`、`file://` 一律放行；
- `CORS_ORIGINS` 中的来源放行；
- **`localhost` / `127.0.0.1` / `[::1]` 的任意端口**自动放行（方便本地开发）；
- Electron / Capacitor 自定义协议（`neomd://`、`capacitor://`、`ionic://`、`app://`）自动放行；
- 其余来源拒绝。

> **自建站点的前端域名必须加进 `CORS_ORIGINS`**，否则浏览器端登录与所有 API 调用都会被跨域拦截。例如：
>
> ```ini
> CORS_ORIGINS=https://md.example.com
> ```

### 5.4 一份完整示例

```ini
# ---------- 基础 ----------
NODE_ENV=production
PORT=3200
HOST=127.0.0.1
TRUST_PROXY=true
WEB_ROOT=/www/wwwroot/md.example.com/public
PUBLIC_BASE_URL=https://md.example.com
LOG_LEVEL=info

# ---------- 数据库 ----------
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=neomd
DB_PASSWORD=change-me-db-password
DB_NAME=neomd
DB_POOL_SIZE=10

# ---------- 密钥（用 openssl rand 生成，不要照抄） ----------
JWT_SECRET=replace-with-64-hex-chars
JWT_REFRESH_SECRET=replace-with-another-64-hex-chars
SECRETS_KEY=replace-with-32-bytes-base64

# ---------- 对象存储 ----------
OSS_ENDPOINT=https://s3.oss-cn-hangzhou.aliyuncs.com
OSS_REGION=cn-hangzhou
OSS_BUCKET=change-me-bucket
OSS_AK=change-me-access-key-id
OSS_SK=change-me-access-key-secret
OSS_PUBLIC_DOMAIN=https://oss.example.com
OSS_PREFIX=mdadmin/
OSS_PUBLIC_READ=false
OSS_URL_STYLE=virtual-hosted

# ---------- 管理员与 CORS ----------
ADMIN_EMAIL=admin@example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
CORS_ORIGINS=https://md.example.com
```

---

## 六、构建前端

在**仓库根目录**执行：

```bash
pnpm --filter @neomd/web build
```

产物位于 `apps/web/dist/`。把它复制到 `WEB_ROOT` 指向的目录：

```bash
# 示例：/www/wwwroot/md.example.com/public
sudo mkdir -p /www/wwwroot/md.example.com/public
sudo rsync -a --delete apps/web/dist/ /www/wwwroot/md.example.com/public/
sudo chown -R www:www /www/wwwroot/md.example.com/public
```

> 前端**不需要**配置 API 地址：默认情况下浏览器同源请求走相对路径 `/api/...`。只有当你要把前端静态托管在与 API 不同源的位置时，才需要在构建前设置 `VITE_API_BASE`（例如 `VITE_API_BASE=https://api.example.com pnpm --filter @neomd/web build`）。

---

## 七、首次启动与管理员账号

### 7.1 手工首次启动（推荐先跑一次看日志）

```bash
cd services/api
node src/server.js
```

首次启动会依次完成：

1. 连接 MySQL；
2. 执行 `schema.sql` 的 17 条建表语句（幂等）；
3. 执行 v2 增量迁移（补列、写入平台默认配置与内置 AI 供应商）；
4. 若无管理员则创建初始管理员，并**在控制台打印一次密码**；
5. 监听 `127.0.0.1:3200`。

第一次启动的输出形如：

```text
[db] 已执行 17 条建表语句（幂等）
[db] v2 增量迁移：新增列 N 个，补充平台配置 N 项，新增 AI 供应商 N 个
==========================================================
  Neo MD 初始管理员已创建（该口令只显示这一次，请立即保存）
  用户名：admin
  邮箱  ：admin@example.com
  密码  ：<20 位随机口令>
==========================================================
[api] 监听地址：http://127.0.0.1:3200
[api] 对外地址：https://md.example.com
```

**立刻保存这串密码**。它只在首次创建时打印一次。若已错过，见 [13.3](#133-忘记管理员密码)。

确认健康检查：

```bash
curl -s http://127.0.0.1:3200/api/health
# {"ok":true,"db":true,"uptime":...,"version":"1.0.x","env":"production",...}
```

按 `Ctrl+C` 停止，进入下一节做进程守护。

### 7.2 只想跑数据库初始化

```bash
cd services/api
node src/db/migrate.js
```

### 7.3 管理员密码规则

- `ADMIN_PASSWORD` 给的值 **≥ 8 字符**时才会被采用；
- 留空或少于 8 字符 → 自动生成 20 位随机密码并打印一次；
- 管理员没有独立后台密码，直接使用该账号登录后访问 `/admin`。

---

## 八、用宝塔面板托管 Node 项目

如果你使用宝塔面板（推荐，与官方生产环境一致的托管方式）：

| 配置项 | 值 |
| --- | --- |
| 项目类型 | Node 项目 |
| 项目名称 | `neomd`（可自定义） |
| 项目目录 | `/www/wwwroot/<域名>` |
| 启动选项 | `server`（自定义命令） |
| 启动命令 | `node src/server.js` |
| 运行目录 | `/www/wwwroot/<域名>/server` |
| Node 版本 | 24.x（≥ 20.19） |
| 运行用户 | `www` |
| 端口 | `3200` |
| 开机自启 | 开启 |

推荐目录布局：

```text
/www/wwwroot/md.example.com/
├─ public/          # 前端静态产物（WEB_ROOT）
└─ server/          # services/api 的部署副本
   ├─ src/          # 纯 ESM 源码，无需构建
   ├─ node_modules/
   ├─ releases/     # 可选：客户端安装包本地缓存（APK 等）
   └─ .env          # 600 权限，含全部密钥
```

部署步骤：

```bash
cd services/api
pnpm install --prod
cd ..

# 组装
sudo mkdir -p /www/wwwroot/md.example.com/server
sudo rsync -a --delete services/api/ /www/wwwroot/md.example.com/server/ \
  --exclude node_modules --exclude .env
sudo cp services/api/.env /www/wwwroot/md.example.com/server/.env
sudo chown -R www:www /www/wwwroot/md.example.com
sudo chmod 600 /www/wwwroot/md.example.com/server/.env
```

之后在面板里启动项目，日志默认位于 `/www/wwwlogs/nodejs/neomd.log`。

> **升级时务必先备份 `server/.env`**：覆盖式解压很容易把生产配置一起冲掉。

如果不使用宝塔，用 systemd：

```ini
# /etc/systemd/system/neomd-api.service
[Unit]
Description=Neo MD API
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/md.example.com/server
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
User=www
Group=www
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neomd-api
sudo systemctl status neomd-api
sudo journalctl -u neomd-api -f
```

---

## 九、Nginx 反向代理

### 9.1 方案 A：全站反代（推荐，与官方一致）

后端已内置 `@fastify/static` 与 SPA 回退（非 `/api`、非 `/p/` 的 GET 未命中真实文件时返回 `index.html`），所以 Nginx 只需做 TLS 终止与整体转发。

```nginx
server {
    listen 80;
    server_name md.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name md.example.com;

    ssl_certificate     /www/server/panel/vhost/cert/md.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/md.example.com/privkey.pem;

    # 上传接口上限（服务端 bodyLimit 12MB / multipart 25MB）
    client_max_body_size 32m;

    # 发送真实 IP，配合后端 TRUST_PROXY=true
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # AI 流式对话必须关闭缓冲
    location /api/ai/ {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_cache off;              # 发版后立即生效，避免旧页面
        proxy_read_timeout 120s;
    }
}
```

> **SSE 是最容易踩的坑**：`/api/ai/*` 若开启 `proxy_buffering`，AI 输出会整段卡住最后一次性吐出，表现为「一直在转圈」。

### 9.2 方案 B：Nginx 直出静态 + API 反代

想让 Nginx 直接托管静态文件（减少 Node 压力）时：

```nginx
root /www/wwwroot/md.example.com/public;

location /api/ {
    proxy_pass http://127.0.0.1:3200;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /p/ {
    # 发布页由后端签名读取对象存储后输出，必须走后端
    proxy_pass http://127.0.0.1:3200;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# SPA 前端路由回退
location / {
    try_files $uri $uri/ /index.html;
}

# 带 hash 的静态资源可长缓存
location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

注意：方案 B 下 `WEB_ROOT` 可以留空或指向同一目录（后端仍会尝试托管，但请求已被 Nginx 截获）。

### 9.3 HTTPS 证书

宝塔面板：站点设置 → SSL → Let's Encrypt，勾选域名后申请，并开启「强制 HTTPS」。

命令行（certbot）：

```bash
sudo certbot --nginx -d md.example.com
```

### 9.4 宝塔安装位置参考

| 文件 | 典型路径 |
| --- | --- |
| 站点 Nginx 配置 | `/www/server/panel/vhost/nginx/<name>.conf` |
| 站点伪静态 | `/www/server/panel/vhost/rewrite/<name>.conf` |
| 证书 | `/www/server/panel/vhost/cert/<domain>/` |
| Node 项目日志 | `/www/wwwlogs/nodejs/<name>.log` |
| Nginx 日志 | `/www/wwwlogs/<domain>.log`、`<domain>.error.log` |

> ⚠️ 站点伪静态文件（`vhost/rewrite/*.conf`）可能被其他部署流程写入额外的 302 跳转规则，导致访问被跳到别的域名。若出现异常跳转，先检查该文件是否被覆盖。

---

## 十、对象存储配置

### 10.1 阿里云 OSS（S3 兼容端点）

1. 创建 Bucket（地域建议与服务器同区域以降低延迟）。
2. 创建 RAM 子账号，只授予该 Bucket 的读写权限，**不要用主账号 AK**。
3. 记下 AccessKeyId / AccessKeySecret。
4. 填入 `.env`：

```ini
OSS_ENDPOINT=https://s3.oss-cn-hangzhou.aliyuncs.com   # 注意是 s3.oss-<region>
OSS_REGION=cn-hangzhou
OSS_BUCKET=change-me-bucket
OSS_AK=change-me-access-key-id
OSS_SK=change-me-access-key-secret
OSS_PREFIX=mdadmin/
OSS_PUBLIC_READ=false
OSS_URL_STYLE=virtual-hosted
```

> 阿里云 OSS 的 S3 兼容端点格式是 `s3.oss-<region>.aliyuncs.com`，**不是** `oss-<region>.aliyuncs.com`。且必须使用 `virtual-hosted` 风格，否则会报 `SecondLevelDomainForbidden`。

### 10.2 其他 S3 兼容存储

| 服务 | Endpoint 形态 | 备注 |
| --- | --- | --- |
| 腾讯云 COS | `https://cos.<region>.myqcloud.com` | 需开启 S3 兼容 |
| 火山引擎 TOS | 见官方 S3 兼容文档 | |
| 百度云 BOS | 见官方 S3 兼容文档 | |
| 金山云 KS3 | 见官方文档 | |
| MinIO（自建） | `https://minio.example.com` | 通常需要 `OSS_URL_STYLE=path` |

### 10.3 私有桶 vs 公共读

| 模式 | 配置 | 行为 |
| --- | --- | --- |
| 私有桶（推荐） | `OSS_PUBLIC_READ=false` | 发布页由服务端签名读取后代理输出；上传接口返回预签名地址；安装包下载走 `/api/download/:file` 的 302 预签名直链 |
| 公共读 | `OSS_PUBLIC_READ=true` | 发布页 302 跳到 `OSS_PUBLIC_DOMAIN`，直接由对象存储出流量，节省服务器带宽 |

公共读模式下记得在 Bucket 策略中只开放读，禁止匿名写与列举。

### 10.4 CORS 说明

服务端所有对象存储操作都在**后端**执行（包括连通性探测 `/api/oss/probe`），浏览器不直连对象存储，因此**一般不需要给 Bucket 配置 CORS**。若你自行在浏览器端扩展了直传逻辑，才需要把站点域名加入 Bucket 的 CORS 规则。

---

## 十一、验证部署

```bash
# 1. 健康检查（含数据库连通性）
curl -s https://md.example.com/api/health

# 2. 首页
curl -sI https://md.example.com/ | head -n 1        # 期望 HTTP/2 200

# 3. SPA 深链接回退
curl -sI https://md.example.com/login | head -n 1   # 期望 200（不是 404）

# 4. 未登录访问受保护接口
curl -s https://md.example.com/api/profile         # 期望 401 + {"ok":false,...}
```

浏览器侧：

1. 打开 `https://md.example.com`，确认营销首页正常渲染；
2. 用第七节的管理员账号登录；
3. 访问 `/admin`，确认后台可进入；
4. 个人中心 → 对象存储，点击「测试」确认探针全部通过；
5. 新建一篇文档并保存，然后创建分享链接，用无痕窗口打开验证。

---

## 十二、升级与回滚

### 12.1 升级

```bash
# 1. 备份环境变量（最重要）
cp /www/wwwroot/md.example.com/server/.env /root/neomd-env-$(date +%Y%m%d).bak

# 2. 备份数据库
mysqldump -u neomd -p --single-transaction --routines neomd \
  > /root/neomd-db-$(date +%Y%m%d).sql

# 3. 拉取新代码并安装依赖
git pull
pnpm install
pnpm --filter @neomd/web build

# 4. 覆盖前端与后端（排除 .env 和 node_modules）
rsync -a --delete apps/web/dist/ /www/wwwroot/md.example.com/public/
rsync -a --delete services/api/src/ /www/wwwroot/md.example.com/server/src/

# 5. 重启 Node 项目
```

数据库结构升级由启动时的 `migrate.js` + `migrate-v2.js` 自动完成（补列不删数据）。升级后：
- 校验 `.env` 未被覆盖（可用 `sha256sum` 与备份对比）；
- 打开 `/api/health` 确认 `ok: true`。

### 12.2 回滚

```bash
# 代码回滚
git checkout <上一个可用 tag>
pnpm install
pnpm --filter @neomd/web build
rsync -a --delete apps/web/dist/ /www/wwwroot/md.example.com/public/

# 数据库回滚（会丢失回滚点之后的数据）
mysql -u neomd -p neomd < /root/neomd-db-<日期>.sql

# 环境变量回滚
cp /root/neomd-env-<日期>.bak /www/wwwroot/md.example.com/server/.env
chmod 600 /www/wwwroot/md.example.com/server/.env

# 重启
```

---

## 十三、常见问题

### 13.1 启动即退出，日志出现「缺少必需的环境变量」

`config.js` 对 `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `JWT_SECRET` / `JWT_REFRESH_SECRET` / `SECRETS_KEY` / `OSS_BUCKET` / `OSS_AK` / `OSS_SK` 做必填校验。按提示补齐对应项即可。

### 13.2 启动报 `SECRETS_KEY 必须是 32 字节的 base64 字符串`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

把输出整行写入 `SECRETS_KEY`，不要加引号以外的任何字符，也不要使用 `openssl rand -hex 32` 的结果（那是 32 个**字节的十六进制表示**，base64 解码后长度不对）。

### 13.3 忘记管理员密码

方式一（推荐）：直接在数据库里把某个已有账号提升为管理员。

```sql
UPDATE users SET role = 'admin', status = 'active' WHERE username = '你的账号';
```

方式二：用 `ADMIN_PASSWORD` 重新播种。注意 `seedAdmin()` 只在**不存在任何管理员**时才创建，因此需要先降级或删除现有管理员：

```sql
-- 确认当前管理员
SELECT id, username, email, role FROM users WHERE role = 'admin';
-- 降级后再重启服务，会用 .env 里的 ADMIN_* 重新创建
UPDATE users SET role = 'user' WHERE role = 'admin';
```

然后设置 `ADMIN_PASSWORD`（≥ 8 字符）并重启。

### 13.4 页面 502 Bad Gateway

```bash
# 后端是否在跑
curl -s http://127.0.0.1:3200/api/health

# 宝塔 Node 项目日志
tail -n 100 /www/wwwlogs/nodejs/neomd.log

# systemd 部署
sudo journalctl -u neomd-api -n 100 --no-pager
```

常见原因：MySQL 未启动 / 密码错误 / 端口被占用 / `.env` 权限导致读不到。

### 13.5 登录、注册全部失败，浏览器控制台报跨域

把前端域名加入 `CORS_ORIGINS` 并重启服务：

```ini
CORS_ORIGINS=https://md.example.com
```

### 13.6 上传头像或创建分享时报对象存储错误

1. 个人中心 → 对象存储 → 点击「测试」，看四步（list / put / get / delete）哪一步失败；
2. 核对 `OSS_ENDPOINT` 是否为 `s3.oss-<region>.aliyuncs.com` 形态；
3. 核对 `OSS_REGION` 与端点一致；
4. 阿里云必须 `OSS_URL_STYLE=virtual-hosted`；
5. 确认 RAM 子账号对该 Bucket 有 `GetObject` / `PutObject` / `ListObjects` / `DeleteObject` 权限。

### 13.7 AI 对话一直转圈，最后一次性输出

Nginx 未关闭 SSE 缓冲。参考 [9.1](#91-方案-a全站反代推荐与官方一致) 中 `/api/ai/` 的 `proxy_buffering off;`。

### 13.8 分享链接里的域名是 `127.0.0.1:3200`

`PUBLIC_BASE_URL` 未设置。填成 `https://md.example.com` 后重启。

### 13.9 分享页 `/p/<slug>` 返回 404

- 私有桶模式下发布页由服务端签名读取，检查 `OSS_*` 是否可用；
- 若在 Nginx 里给 `/` 配了 `try_files` 却没有为 `/p/` 单独反代，请参考 [9.2](#92-方案-bnginx-直出静态--api-反代)。

### 13.10 安装包下载 404

- `windows` 的 `.zip` / `.exe` 通过 `/api/download/:file` 302 到对象存储，需确认对象存储中 `<OSS_PREFIX>releases/` 下存在对应文件；
- `.apk` 由服务端直接流式返回，需确认 `server/releases/NeoMD-<version>.apk` 存在且有读权限（`chmod 644`）；
- 部分对象存储会拦截 `.apk` 的直接下载，这也是 APK 走服务端直发的原因。

### 13.11 中文变成乱码

数据库字符集必须是 `utf8mb4`；Nginx 与后端已统一 `charset=utf-8`。若只有历史数据乱码，说明建库时用了 `latin1` 或 `utf8`（3 字节），需要重新建库并迁移。

### 13.12 Windows Server 部署差异

- 命令改用 PowerShell；
- 进程守护用 [NSSM](https://nssm.cc/) 或计划任务，参数为 `node src/server.js`，工作目录指向 `server`；
- Nginx for Windows 可用，但**不支持** `proxy_buffering off` 之外的某些指令行为差异，SSE 建议改用 Caddy 或直接暴露 3200 端口；
- `argon2` 在 Windows 上通常需要预编译包，若失败请安装 Visual Studio Build Tools。

### 13.13 插件市场打不开 / 提示连不上

插件市场**始终连接官方统一服务，不随自建服务端变化**。请检查客户端到官方域名的网络连通性，这不是自建服务端的配置问题。详见 [SELF_HOSTING.md](./SELF_HOSTING.md#五插件市场的边界)。

---

## 十四、知识库 API

1.1.0 引入的 **AI 知识库**在服务端只占两个接口。理解它们的边界，比知道怎么调用更重要。

### 14.1 架构定位：知识库不落库存储用户文档

> **服务端不接收、不存储、不索引用户的文档内容。** 知识库是**纯前端实现**。

| 环节 | 执行位置 | 说明 |
| --- | --- | --- |
| 扫描仓库、读取 `.md` | 客户端 | 桌面端走本机文件系统，网页端走云端仓库 / IndexedDB |
| 切片（chunking） | 客户端 | 五种颗粒度全部在浏览器内计算 |
| 建索引 | 客户端 | 倒排索引，可序列化后随仓库同步 |
| 检索与打分 | 客户端 | 返回 `topK` 个片段与 `score` |
| **转发 AI 请求** | **服务端** | **仅此一步经过服务器** |

因此：

- 数据库**没有**任何知识库相关表（`schema.sql` 仍是原有的 17 张表）；
- 请求体中的文本片段只在**单次请求的内存生命周期**内转发给 AI 供应商，不写数据库、不写磁盘；
- 服务端日志不记录片段正文（只记录请求 ID、耗时、token 用量等元数据）；
- 用户在设置中同步到云端的 `knowledge` 配置**只有参数**（颗粒度、`topK`、`minScore` 等），**不含任何文档正文**。

这与产品「本地优先」的定位一致：你的笔记不需要上传，就能被自己的 AI 用上。

### 14.2 `POST /api/knowledge/chat`

**用途**：知识库问答的 AI 代理。客户端先在本地检索出相关片段，把「用户问题 + 选中的片段」发到服务端，服务端按当前用户配置的 AI 供应商（平台积分模式）或用户自带的 Key（BYOK 模式）发起上游请求，并以 **SSE 流式**把回答返回。

**鉴权**：`Authorization: Bearer <access_token>`（与其它业务接口一致）。

- Access Token 有效期 15 分钟，过期用刷新令牌换取；桌面端 / Android 端同样适用；
- **BYOK 模式**额外携带请求头 `x-user-ai-key`（自带 Key 不上传落库，仅随本次请求透传）；
- 未登录 → `401`；令牌过期 → `401`（客户端应自动刷新后重试一次）；
- `knowledge.enabled = false` 时，客户端的检索与服务端调用全部返回空，不会发起该请求。

**限流**：30 次 / 分钟 / 用户（与 `/api/ai` 同档，见 [SECURITY.md](../SECURITY.md#34-限流与配额)）。

**请求 / 响应形态**（示意，字段以实际实现为准）：

```http
POST /api/knowledge/chat
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "messages": [{ "role": "user", "content": "我上季度对同步冲突是怎么定的？" }],
  "context": [
    { "docId": "...", "title": "同步设计", "text": "同一 docId 以 updatedAt 大者为准……", "score": 0.82 }
  ]
}
```

响应为 `text/event-stream`。部署侧关键点：**Nginx 必须对该路径关闭缓冲**，否则回答会卡住到最后一次性吐出——参考 [9.1](#91-方案-a全站反代推荐与官方一致) 中 `/api/ai/` 的 `proxy_buffering off;`，把路径一并覆盖即可。

### 14.3 `GET /api/knowledge/stats`

**用途**：返回当前用户的知识库使用统计，供客户端展示与运维排障。典型内容为调用次数、token 用量、平均耗时与最近调用时间。

**鉴权**：`Authorization: Bearer <access_token>`，只能读**自己**的统计；管理员通过后台接口查看全局用量。

**用途边界**：该接口**不返回任何文档内容、片段原文或索引信息**，只有聚合数字。即使被越权访问，也不会泄露笔记正文。

### 14.4 部署注意事项

| 事项 | 说明 |
| --- | --- |
| 额外组件 | **不需要**。无需搭建 Elasticsearch / Milvus / Qdrant 等检索引擎或向量库 |
| 数据库 | 无需新增表，无需迁移 |
| 反向代理 | `/api/knowledge/chat` 走 SSE，需关闭 `proxy_buffering`；`/api/knowledge/stats` 为普通 GET |
| 带宽 | 摘要与片段在客户端与服务器之间传输，长文本检索建议把 `topK` 调低、`maxContextChunks` 调小 |
| 完全离线 | 开启 PC 端「数据私有化」（`privacyMode`）后不连服务器，本地检索仍可用，仅 AI 问答不可用 |
| 计费 | 平台积分模式下按所选供应商的计费方式扣除，与普通 AI 对话同一套账 |

### 14.5 与自建 / 私有化的关系

- **自建服务端**：这两个接口随你的部署自动可用，AI 供应商密钥在**你的**管理后台配置；
- **数据私有化模式**：`privacyMode=true` 时客户端完全不连服务器，知识库退化为纯本地检索，不产生任何网络请求（也就不会扣积分）；
- **插件市场**不受影响，仍走官方统一服务，见 [SELF_HOSTING.md](./SELF_HOSTING.md#五插件市场的边界)。

---

## 十五、版本发布流程（同步到 GitHub 与 Releases）

本节说明如何把「版本发布」与「本次更新记录」一起同步到 GitHub 仓库和 GitHub Releases。
目标：任何一次发布之后，**GitHub 的 Release 页面就是这一版更新记录的权威副本**，访客能直接看到改了什么、下载哪个安装包。

### 15.1 发布产物一览

一次完整发布会产生三端产物，全部落在 `dist-artifacts/`：

| 产物 | 文件名 | 说明 |
| --- | --- | --- |
| Windows 安装包 | `NeoMD-<版本>-setup.exe` | NSIS 安装程序，含自动更新配置 |
| Windows 免安装包 | `NeoMD-<版本>-win-x64.zip` | 解压即用便携版 |
| Android 安装包 | `NeoMD-<版本>.apk` | 移动端 |
| 增量更新索引（可选） | `NeoMD-<版本>-setup.exe.blockmap` | electron-updater 差分更新用，存在就一起上传 |

### 15.2 发布前准备的固定顺序

**顺序不能颠倒**，尤其第 2 步与第 3 步：产物必须由「已包含本次全部修改的源码」构建出来。
历史上曾两次出现「产物落后于源码」（1.1.1 → 重发 1.1.2、1.1.5 → 重发 1.1.6），原因都是构建时间早于最后一处修复落盘。

#### 第 1 步：更新 `CHANGELOG.md`

在文件最上方（`# 更新日志` 的说明段之后、上一个版本之前）插入新版本段：

```markdown
## [1.1.7] - 2026-10-27

一句话概括这一版做了什么。

### Added

- 新增了什么，解决了谁的什么问题。

### Fixed

- 修了什么缺陷，原来的表现是什么，现在是什么。

### Changed

- 行为有什么变化，老用户需要注意什么。
```

要点：

- **标题格式必须是 `## [x.y.z] - YYYY-MM-DD`** —— 发布脚本靠这个正则定位版本段，格式错了会提取不到。
- 版本段之间有 `---` 分隔线是惯例，脚本会自动剥掉结尾的 `---`，不会出现在 Release 正文里。
- `### Added / Fixed / Changed / Security` 这些二级标题会被原样保留到 Release 页面，GitHub 会渲染成小标题，保持这个层级即可。

#### 第 2 步：升级版本号

**需要同步修改的文件清单**（漏改会导致「安装包版本对、应用内显示版本旧」）：

| 文件 | 字段 | 说明 |
| --- | --- | --- |
| `package.json` | `version` | **主版本的唯一来源**，发布脚本从这里读 |
| `apps/desktop/package.json` | `version` | Electron 打包版本号 |
| `apps/web/package.json` | `version` | 前端包版本（供内嵌显示） |
| `apps/android/app/build.gradle` | `versionName` / `versionCode` | `versionCode` 必须**递增整数**，否则无法覆盖安装 |

> `versionCode` 规则：`1.1.7` → `10107`（主 × 10000 + 次 × 100 + 修订）。只增不减。

#### 第 3 步：构建三端产物

```bash
# Windows 安装包 + 免安装包（在仓库根目录）
pnpm build:web
pnpm build:desktop

# Android APK
pnpm build:android
```

构建完成后确认 `dist-artifacts/` 下三件套齐全，且**时间戳晚于最后一次源码修改**：

```bash
# Linux / macOS / Git Bash
ls -l --time-style=full-iso dist-artifacts/NeoMD-<版本>-*
```

```powershell
# Windows PowerShell
Get-ChildItem dist-artifacts -Filter "*<版本>*" | Select-Object Name, Length, LastWriteTime
```

### 15.3 发布到 GitHub Releases

#### 15.3.1 先演练（强烈建议）

演练模式不联网、不需要 token，只打印「识别到的版本、Release 正文首末行、要上传哪些文件及大小」：

```bash
node tools/publish-github-release.mjs --dry-run
```

正常输出应类似：

```
版本号      : 1.1.7
Git tag     : v1.1.7
Release 名  : Neo MD v1.1.7
── Release 说明（取自 CHANGELOG）──
标题行      : ## [1.1.7] - 2026-10-27
正文行数    : 42 行（1580 字符）
首行        : 一句话概括这一版做了什么。
末行        : > 未签名安装包在 Windows 上可能触发 SmartScreen 提示…
── 待上传资产 ──
  ✓ NeoMD-1.1.7-setup.exe       107.9 MB  Windows 安装包
  ✓ NeoMD-1.1.7-win-x64.zip     151.8 MB  Windows 免安装包
  ✓ NeoMD-1.1.7.apk               4.1 MB  Android 安装包
```

**演练阶段会主动告警三类问题**，看到就回去改，不要硬发：

| 告警 | 含义 | 处理 |
| --- | --- | --- |
| `没有找到版本 x.y.z 的段落` | CHANGELOG 标题格式不对或忘了写 | 回第 1 步 |
| `CHANGELOG 的最新版本是 A，与待发布版本 B 不一致` | 忘了升 `package.json` 版本，或忘了写日志 | 对齐两者 |
| `缺少 N 个必需产物` | `dist-artifacts/` 里没有对应版本的安装包 | 回第 3 步重新构建 |

#### 15.3.2 配置凭据

!!! 安全红线

    **绝对不要把 token 写进任何文件**（脚本、`.env`、CI 配置、文档）。
    只通过环境变量传入，用完即失效或手动撤销。

在 GitHub 生成 Personal Access Token（Fine-grained 或 Classic 均可）：

- Classic：勾选 `repo` 权限（私有仓库）或 `public_repo`（公开仓库）。
- Fine-grained：目标仓库 → `Contents: Read and write`。

然后**在当前终端会话里**设置（三种 shell 任选）：

```powershell
# Windows PowerShell
$env:GITHUB_TOKEN = "ghp_xxxxxxxx"    # 粘贴你自己的 token
$env:GITHUB_REPO  = "owner/repo"
```

```bat
:: Windows CMD
set GITHUB_TOKEN=ghp_xxxxxxxx
set GITHUB_REPO=owner/repo
```

```bash
# Linux / macOS / Git Bash
export GITHUB_TOKEN="ghp_xxxxxxxx"
export GITHUB_REPO="owner/repo"
```

`GITHUB_REPO` 可以省略 —— 如果 `package.json` 里有 `repository` 字段，脚本会自动解析：

```json
{ "repository": "owner/repo" }
```

也支持完整写法 `https://github.com/owner/repo.git` 或 `git@github.com:owner/repo.git`，脚本会自动清洗。

#### 15.3.3 执行发布

```bash
node tools/publish-github-release.mjs
```

脚本会自动完成：

1. 查 `v<版本>` 这个 tag 是否已有 Release —— **有则更新说明，没有则创建**（幂等，可反复跑）。
2. 逐个上传产物；**同名资产先删除再上传**，所以重复执行不会因为 422 失败。
3. 在 Release 正文末尾追加「安装包」表格（文件名 + 大小），访客不用展开 Assets 折叠区就能看到该下哪个。

常用参数：

| 参数 | 用途 |
| --- | --- |
| `--dry-run` | 只演练，不联网 |
| `--skip-assets` | 只同步 Release 说明，不上传安装包（产物还没构建好时用） |
| `--draft` | 发成草稿，先在页面预览再手动发布 |
| `--prerelease` | 标记为预发布（不会顶到 Latest） |
| `--version=1.1.7` | 覆盖版本号（默认读 `package.json`） |
| `--tag=v1.1.7` | 覆盖 tag 名（默认 `v<版本号>`） |
| `--repo=owner/repo` | 覆盖仓库标识 |
| `--help` | 查看全部选项 |

#### 15.3.4 把 tag 与 CHANGELOG 推送到仓库

!!! 注意：本机 `git` 不在 PATH

    当前开发机未把 `git` 加入 PATH（`Get-Command git` 无结果），因此下面的提交与推送需要
    **在装有 Git 的机器上执行**，或先把 Git 加入 PATH（Git for Windows 默认路径
    `C:\Program Files\Git\bin`，本机实测该目录存在，只是没进 PATH）。

Release 创建后，`CHANGELOG.md` 的本次改动还必须**随代码一起进主分支**，否则仓库里的更新日志会落后于 Release 页面：

```bash
# 1) 提交本次发布的文件变更
git add CHANGELOG.md package.json apps/desktop/package.json apps/web/package.json apps/android/app/build.gradle
git commit -m "chore(release): v1.1.7"

# 2) 推到主分支（更新日志先进主干）
git push origin main

# 3) 打 tag 并推送（这一步会触发 .github/workflows/release.yml 的自动发布）
git tag -a v1.1.7 -m "Neo MD v1.1.7"
git push origin v1.1.7
```

推送 tag 之后，GitHub Actions 会自动做两件事：

1. **verify**：跑 `vue-tsc` 类型检查 + `vitest` 单元测试 + 发布脚本 `--dry-run` 自检。任一失败则**不会**创建 Release。
2. **release**：调用发布脚本创建 Release 并上传产物。

所以有两种等效的发布路径，选一种即可：

- **路径 A（推荐，全自动）**：推 tag → CI 校验 → CI 自动发布。
- **路径 B（手动兜底）**：本地 `node tools/publish-github-release.mjs` 直接发；后续推 tag 时 CI 会走幂等分支更新同一份 Release，不会重复创建。

#### 15.3.5 验证发布结果

发布完成后按这个清单逐项确认：

- [ ] 打开 `https://github.com/<owner>/<repo>/releases`，最新一条标题是 `Neo MD v<版本>`。
- [ ] 正文包含本次 `CHANGELOG` 段落，`### Added / ### Fixed` 等小标题渲染正常，没有乱码。
- [ ] 正文末尾的「安装包」表格里，三个文件的大小与实际文件一致。
- [ ] 展开页面底部的 Assets，三个安装包都在，且都能点击下载（建议真下一个 APK 验证）。
- [ ] 仓库主分支上的 `CHANGELOG.md` 已包含本次版本段（对照网页版确认，不是只看本地）。
- [ ] 若是 `--prerelease` 或 `--draft`，确认 Latest 仍指向稳定版。

### 15.4 常见问题

#### 15.4.1 `HTTP 401 Unauthorized`

Token 无效或已过期。重新生成并更新环境变量。注意 token 只在**当前终端会话**有效，新开窗口要重设。

#### 15.4.2 `HTTP 403` 且提示 rate limit

触发 API 限流。未认证请求是 60 次/小时，认证后 5000 次/小时 —— 出现这个通常是 token 没被带上（检查变量名是否写成 `GITHUB_TOKEN`，别写成 `GH_TOKEN` 或 `GITHUB_API_TOKEN`）。

#### 15.4.3 `HTTP 422 Validation Failed` 且提到 `<file> already_exists`

同名资产已存在。正常情况下脚本会先删除再传，出现这个说明并发跑了两份发布（比如同时手动跑了一次、CI 又跑了一次）。等前一个跑完再重试即可。

#### 15.4.4 `HTTP 404` 找不到仓库

`GITHUB_REPO` 写错，或 token 没有该仓库的访问权限（Fine-grained token 需要在「Repository access」里显式勾选该仓库）。

#### 15.4.5 上传到一半断开

脚本是「逐个资产」处理的，断点处已上传的资产在远端保留。**直接重跑同一条命令即可**，已完成的会被识别、同名的会先删再传，不会产生重复条目。

#### 15.4.6 Release 正文里出现「未找到 x.y.z 的更新记录」

`CHANGELOG.md` 里没有对应版本段，或标题格式不是 `## [x.y.z] - 日期`。补好后重跑（幂等，会更新已有 Release 的正文）。

#### 15.4.7 想撤销一次发布

在 GitHub 网页上删除该 Release（tag 可保留），或改用 `--draft` 重新发一份。脚本本身不提供删除命令 —— 删除是不可逆操作，刻意留给人工在网页确认。

---

## 附录：部署产物清单

| 路径 | 内容 |
| --- | --- |
| `apps/web/dist/` | 前端构建产物 → 复制到 `WEB_ROOT` |
| `services/api/src/` | 后端源码（纯 ESM）→ 复制到 `server/src` |
| `services/api/.env.example` | 环境变量模板 |
| `services/api/src/db/schema.sql` | 17 张表的幂等建表语句 |
| `services/api/src/db/migrate.js` | 启动时自动迁移 + 管理员播种 |
| `services/api/src/db/migrate-v2.js` | 增量补列 + 平台默认配置种子 |

相关文档：

- [用户指南 →](./USER_GUIDE.md)（Obsidian 迁移 / AI 知识库 / 思维导图与流程图）
- [自建服务端与 PC 端联动 →](./SELF_HOSTING.md)
- [插件开发指南 →](../PLUGIN_DEVELOPMENT_GUIDE.md)
- [更新日志 →](../CHANGELOG.md)
- [贡献指南 →](../CONTRIBUTING.md)
- [安全策略 →](../SECURITY.md)
