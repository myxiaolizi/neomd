# @neomd/api — Neo MD 服务端

Neo MD 的账号、设置同步、分享、发布、上传与 AI 代理服务。纯 JavaScript ESM（无 TypeScript、无构建步骤），运行在 Node.js ≥ 20.19，Fastify 5 + MySQL 8。

## 目录结构

```
services/api/
├── .env                 实际部署配置（已被 .gitignore 忽略）
├── .env.example         配置模板，生产默认 DB_HOST=127.0.0.1
├── .env.local           本地联调覆盖项（可选，优先级高于 .env）
├── package.json         dev / start 脚本，入口 src/server.js
└── src/
    ├── config.js        极简 dotenv 加载 + 必需变量校验
    ├── server.js        装配插件、路由、静态托管、错误处理与优雅停机
    ├── db/
    │   ├── pool.js      mysql2 连接池、query/queryOne/execute、tx 事务封装
    │   ├── schema.sql   全部建表语句（CREATE TABLE IF NOT EXISTS，可重复执行）
    │   └── migrate.js   启动时建表 + 首次初始化管理员（口令只打印一次）
    ├── lib/
    │   ├── crypto.js    argon2 口令哈希、AES-256-GCM、sha256、随机令牌、IP 指纹
    │   ├── jwt.js       访问令牌 15m / 刷新令牌 30d 的签发与校验
    │   ├── lru.js       带 TTL 的进程内 LRU 缓存（无 Redis）
    │   ├── s3.js        node:crypto 手写 AWS SigV4 的 S3 客户端与预签名
    │   ├── oss.js       平台桶路径规则与高层封装
    │   ├── markdown.js  markdown-it 渲染（禁用裸 HTML）与纯文本摘要
    │   ├── export-css.js 导出/发布共用的排版 CSS 与独立 HTML 模板
    │   ├── http.js      统一响应工具与 HttpError
    │   ├── validate.js  zod 校验封装与通用字段
    │   └── audit.js     审计日志写入与客户端 IP 解析
    ├── middleware/
    │   ├── auth.js      authenticate / optionalAuth / requireAdmin 装饰器
    │   └── rate.js      登录/注册/评论/AI 配额与全局限流配置
    └── routes/
        ├── auth.js      注册、登录、刷新、登出、当前用户、改密
        ├── settings.js  设置的读写与版本仲裁（敏感字段加密存储）
        ├── shares.js    分享创建/列表/撤销 + 游客阅读、评论、浏览量
        ├── publish.js   发布为独立 HTML 到对象存储，/p/:slug 对外输出
        ├── upload.js    中转上传、直传预签名、存储连通性自检
        ├── ai.js        OpenAI 兼容接口的 SSE 流式代理与用量记录
        ├── admin.js     管理后台的用户/分享/发布/评论/审计/概览
        └── health.js    GET /api/health
```

## 运行

```bash
# 开发（文件变更自动重启）
pnpm --filter @neomd/api dev

# 生产
pnpm --filter @neomd/api start

# 仅初始化数据库（建表 + 首次创建管理员）
node services/api/src/db/migrate.js
```

启动流程：加载配置 → 校验必需变量 → 执行 `schema.sql`（幂等）→ 无管理员时创建初始管理员并打印一次性口令 → 监听端口。进程收到 `SIGINT`/`SIGTERM` 时先停止接收请求、关闭连接池再退出。

## 配置

全部配置来自 `.env`（可选 `.env.local` 覆盖，真实进程环境变量优先级最高）。必需项：`DB_USER`、`DB_PASSWORD`、`DB_NAME`、`JWT_SECRET`（≥32 字符）、`JWT_REFRESH_SECRET`（≥32 字符）、`SECRETS_KEY`（32 字节 base64）、`OSS_BUCKET`、`OSS_AK`、`OSS_SK`。

注意 `OSS_ENDPOINT` 的取值：阿里云 OSS 的 S3 兼容端点格式是 `https://s3.oss-<region>.aliyuncs.com`（例如广州 `https://s3.oss-cn-guangzhou.aliyuncs.com`），虚拟主机风格的实际请求域名为 `<bucket>.s3.oss-<region>.aliyuncs.com`。

`OSS_PUBLIC_READ` 决定发布页输出方式：`true` 时 `/p/<slug>` 302 跳转到 `OSS_PUBLIC_DOMAIN`，`false`（私有桶的默认取值）时由服务端带签名读取并直接输出 HTML，同时上传接口返回预签名读取地址。

## 响应约定

- 成功：`{ "ok": true, "data": ... }`
- 失败：`{ "ok": false, "error": { "code": "...", "message": "..." } }`
- 例外：`GET /api/health` 直接返回 `{ ok, db, uptime, version }`，`/p/<slug>` 返回 HTML。

所有请求体用 zod 校验，失败返回 400 与可读中文提示；口令哈希、原始 API Key 永不出现在响应里。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 探活，含数据库 `SELECT 1` |
| POST | `/api/auth/register` | 注册（10 分钟 5 次/IP） |
| POST | `/api/auth/login` | 登录（10 次/分钟/IP） |
| POST | `/api/auth/refresh` | 刷新令牌，旧令牌立即作废 |
| POST | `/api/auth/logout` | 登出（可按设备或全设备） |
| GET | `/api/auth/me` | 当前用户与用量统计 |
| PUT | `/api/auth/password` | 修改口令，全设备下线 |
| GET/PUT | `/api/settings` | 读取/写入设置，版本冲突返回 409 |
| GET | `/api/settings/version` | 轻量轮询云端版本 |
| POST/GET | `/api/shares` | 创建分享 / 我的分享 |
| DELETE | `/api/shares/:id` | 撤销分享 |
| GET | `/api/public/shares/:token` | 游客读取快照与评论（含批注） |
| POST | `/api/public/shares/:token/comments` | 游客评论（20 次/小时/IP） |
| POST | `/api/public/shares/:token/view` | 浏览量 +1 |
| POST/GET | `/api/publish` | 发布文档 / 我的发布 |
| DELETE | `/api/publish/:id` | 撤销发布并删除对象 |
| GET | `/p/:slug` | 对外发布页 |
| POST | `/api/upload` | multipart 上传（≤25MB） |
| POST | `/api/upload/presign` | 直传预签名 |
| POST | `/api/oss/probe` | 对象存储连通性自检 |
| POST | `/api/ai/chat` | SSE 流式对话代理（30 次/分钟/用户） |
| GET | `/api/ai/providers` | 预设供应商与模型列表 |
| GET | `/api/admin/stats` | 概览与近 14 天注册趋势 |
| GET/PUT/DELETE | `/api/admin/users[/:id]` | 用户管理 |
| POST | `/api/admin/users/:id/reset-password` | 重置口令（新口令只返回一次） |
| GET/DELETE | `/api/admin/shares[/:id]` | 分享治理 |
| GET/DELETE | `/api/admin/publishes[/:id]` | 发布治理 |
| GET | `/api/admin/audit` | 审计日志分页查询 |
| GET/PUT | `/api/admin/comments[/:id]` | 评论列表与隐藏/恢复 |

## 数据与安全

- 全部表使用 InnoDB + `utf8mb4_0900_ai_ci`，建表语句幂等，可随进程启动反复执行。
- 用户设置分两段存储：`payload_json` 存公开设置，`payload_enc` 用 AES-256-GCM 加密存储密钥与 AI Key。
- 刷新令牌只保存 sha256 哈希，轮换登录即作废旧令牌。
- 分享快照与发布页的 Markdown 渲染禁用裸 HTML，避免脚本注入；评论记录 IP 指纹而非明文 IP。
- 管理员的所有写操作与认证事件写入 `audit_logs`。
- 对象存储布局：平台资源 `mdadmin/...`、管理员个人目录 `admin/...`、用户图片 `us/<用户名>/tupian/<yyyyMM>/...`、用户备份 `us/<用户名>/bk/...`、用户其它数据 `us/<用户名>/ot/...`。

## 前端托管

`WEB_ROOT` 指向 SPA 构建产物目录。命中真实文件时按文件返回；非 `/api`、非 `/p/` 的 GET 一律回退 `index.html`，交给前端路由处理。目录不存在时服务仍可启动，仅跳过静态托管并给出告警。
