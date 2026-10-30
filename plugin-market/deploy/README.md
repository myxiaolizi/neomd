# Neo MD 社区插件（50 款）发布与入库指南

本目录提供「插件商店 50 款社区插件」从本地构建产物到生产数据库（`md.zhengl.vip`）幂等入库、线上校验与安全回滚的完整工具链。

## 目录结构

```text
plugin-market/
├── PLAN.json                    # 50 款插件契约清单（唯一事实源）
├── plugins/                     # 50 款插件 ESM 源码（NN-<id>.js）
├── validate.mjs                 # 本地静态与沙箱运行校验器
├── deploy/
│   ├── build-artifacts.mjs      # 产物 1：构建 plugins-payload.json 与 manifest.json
│   ├── seed-prod.mjs            # 产物 2：生产环境 MySQL 幂等入库脚本
│   └── README.md                # 产物 3：本部署操作手册
└── dist/
    ├── plugins-payload.json     # 构建生成的待入库插件数组
    └── manifest.json            # 构建生成的 SHA-256 指纹与字节数清单
```

---

## 一、本地构建发布产物

在仓库根目录（`C:\Data\BAC\neomd\neomd-V1`）下执行：

### 1.1 先跑插件校验器（推荐）

```bash
node plugin-market/validate.mjs
```

### 1.2 构建发布包

- **严格模式（默认，正式发布必用）**：要求 `PLAN.json` 50 款插件全部存在、单文件 ≤ 12KB、含 `export default`、`id`/`name` 与契约一致且无任何非 UTF-8 字节，否则打印问题清单并以 `exit 1` 退出：

```bash
node plugin-market/deploy/build-artifacts.mjs
```

- **部分构建模式（开发/联调阶段）**：允许部分插件文件暂缺，只对已就绪插件生成产物并打印 `已就绪 X/50`：

```bash
node plugin-market/deploy/build-artifacts.mjs --allow-partial
```

构建成功后会输出两个文件的绝对路径与字节数：
- `plugin-market/dist/plugins-payload.json`：包含 `[{ pluginId, name, version, category, icon, description, readmeMd, codeJs, nn }]`
- `plugin-market/dist/manifest.json`：包含 `{ suiteVersion, generatedAt, total, items: [{ nn, pluginId, file, bytes, sha256, lines }] }`

---

## 二、上传产物与脚本到生产服务器

生产服务端位于 `/www/wwwroot/md.zhengl.vip/server`（Node 24、ESM，`node_modules` 内置 `mysql2` 3.24，同目录 `.env` 含数据库配置）。

将本地生成的 `plugins-payload.json`、`manifest.json` 以及入库脚本 `seed-prod.mjs` 上传至服务器（例如放在 `/www/wwwroot/md.zhengl.vip/server/plugin-seed/`）：

```bash
# 在本地终端执行（按实际 SSH 账号/端口替换）
ssh root@md.zhengl.vip "mkdir -p /www/wwwroot/md.zhengl.vip/server/plugin-seed"

scp plugin-market/deploy/seed-prod.mjs \
    plugin-market/dist/plugins-payload.json \
    plugin-market/dist/manifest.json \
    root@md.zhengl.vip:/www/wwwroot/md.zhengl.vip/server/plugin-seed/
```

---

## 三、入库前备份（重要：用于回滚）

在正式写库前，先在生产数据库上为 `community_plugins` 创建快照备份表（或导出 SQL），以便随时一键回滚：

```sql
-- 方式 A：在同库内创建带日期后缀的完整备份表（推荐，秒级完成）
CREATE TABLE community_plugins_bak_20261030 AS
SELECT * FROM community_plugins;
```

或使用 `mysqldump` 导出文件备份：

```bash
mysqldump -u "$DB_USER" -p "$DB_NAME" community_plugins > /www/backup/community_plugins_$(date +%Y%m%d_%H%M%S).sql
```

---

## 四、服务器上执行 Dry-Run 预演

**必须在 `/www/wwwroot/md.zhengl.vip/server` 目录下运行**（使 Node 自动解析该目录 `node_modules/mysql2` 并自动读取当前目录 `.env`）：

```bash
cd /www/wwwroot/md.zhengl.vip/server

node plugin-seed/seed-prod.mjs plugin-seed/plugins-payload.json --dry-run
```

Dry-Run 会：
1. 读取环境变量 `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`（未设置时自动解析当前工作目录下的 `.env`）；
2. 连接数据库并查询 `SELECT plugin_id FROM community_plugins`；
3. 逐条打印将要写入的 `plugin_id`、`codeJs` 字节数、动作类型（`新增` 或 `更新`），**不执行任何写操作**；
4. 末尾打印预演统计与当前表内总数。

---

## 五、正式执行幂等入库

确认 Dry-Run 输出的 50 款插件清单无误后，去掉 `--dry-run` 正式入库：

```bash
cd /www/wwwroot/md.zhengl.vip/server

node plugin-seed/seed-prod.mjs plugin-seed/plugins-payload.json \
  --user-id 1 \
  --author "Neo MD 官方团队"
```

### 说明
- 脚本采用 `INSERT INTO community_plugins (...) VALUES (...) ON DUPLICATE KEY UPDATE ...` 幂等语句：
  - 若 `plugin_id` 不存在，则新增记录，初始 `status='published'`、`downloads=0`、`stars=0`；
  - 若 `plugin_id` 已存在，则更新 `name` / `version` / `category` / `icon` / `description` / `readme_md` / `code_js` / `status='published'` / `updated_at=NOW()`，**保留已有的 `downloads` 与 `stars` 统计不重置**。
- 若只需单独更新某几款插件，可附加 `--only 01,12` 或 `--only daily-standup-log`。
- 全程绝不回显数据库明文密码。

---

## 六、线上接口复核

入库完成后，使用 `curl` 请求线上公开插件市场接口验证返回数据：

```bash
# 1. 检查接口返回状态与已上架插件总数
curl -sS https://md.zhengl.vip/api/plugins/market | jq '{
  total: (.data.items | length),
  sample: (.data.items[:3] | map({pluginId, name, version, category, status}))
}'

# 2. 按关键词检索某款具体插件复核内容
curl -sS "https://md.zhengl.vip/api/plugins/market?search=todo-progress-rollup" | jq '.data.items[0] | {pluginId, name, version, category, icon, codeLen: (.codeJs | length)}'
```

确认：
- `total` 不少于 50（若原本含内置示例插件则为 `50 + 原有非重名插件数`）；
- 抽查插件的 `version` 为 `"1.0.0"`、`status` 为 `"published"`、`codeJs` 非空。

---

## 七、回滚方式（备份表 SQL）

若上线后发现异常需要回滚，可按以下两种场景执行 SQL：

### 场景 A：仅撤回本次新增的 50 款插件（或精确还原至入库前状态）

若入库前执行了第三节的 `CREATE TABLE community_plugins_bak_20261030 AS SELECT * FROM community_plugins;`：

```sql
START TRANSACTION;

-- 1. 清空当前表数据
DELETE FROM community_plugins;

-- 2. 从备份表完整恢复入库前的所有记录（保留原主键 id、downloads、stars 与时间戳）
INSERT INTO community_plugins
  (id, plugin_id, user_id, author_name, name, version, category, icon,
   description, readme_md, manifest_json, code_js, status, downloads, stars, created_at, updated_at)
SELECT
  id, plugin_id, user_id, author_name, name, version, category, icon,
  description, readme_md, manifest_json, code_js, status, downloads, stars, created_at, updated_at
FROM community_plugins_bak_20261030;

COMMIT;
```

### 场景 B：紧急下架某一款或全部官方套件插件（不删数据）

```sql
-- 紧急下架单款插件
UPDATE community_plugins
SET status = 'disabled', updated_at = NOW()
WHERE plugin_id = 'todo-progress-rollup';

-- 或按作者批量下架本次发布的插件
UPDATE community_plugins
SET status = 'disabled', updated_at = NOW()
WHERE author_name = 'Neo MD 官方团队' AND version = '1.0.0';
```
