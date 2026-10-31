/**
 * 增量迁移 v2：在老库上补齐新增列，并写入平台默认配置与供应商目录。
 *
 * 所有 ALTER 都先用 information_schema 判断列是否已存在，
 * 因此重复执行不会报错；schema.sql 已经建好的新库会直接跳过。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execute, query, queryOne, closePool } from './pool.js';
import { migrate } from './migrate.js';
import { platformConfig } from '../lib/oss.js';
import {
  DEFAULT_CREDIT_PER_YUAN,
  DEFAULT_MODEL_PRICES,
  DEFAULT_PAYMENT_METHODS,
  PLATFORM_PROVIDERS,
} from '../lib/platform.js';

/**
 * 需要补充的列：[表名, 列名, 列定义, 列位置]
 * 列位置用 AFTER 子句，表里没有对应参考列时传 null 追加到末尾。
 */
const COLUMN_ADDITIONS = [
  ['users', 'nickname', 'VARCHAR(64) NULL DEFAULT NULL', null],
  ['users', 'avatar_url', 'VARCHAR(512) NULL DEFAULT NULL', null],
  ['users', 'credits', 'BIGINT NOT NULL DEFAULT 0', null],
  ['users', 'last_daily_grant_date', 'VARCHAR(16) NULL DEFAULT NULL', null],
  ['ai_usage', 'cost', 'BIGINT NOT NULL DEFAULT 0', null],
  ['shares', 'access_code', 'VARCHAR(64) NULL DEFAULT NULL', null],
  ['shares', 'style_json', 'TEXT NULL', null],
  ['platform_ai_providers', 'priority', 'INT NOT NULL DEFAULT 100', null],
  // 1.1.7 AI 供应商展示元数据后台可配置：申请地址 / 文档地址 / 说明 / 排序
  // 全部允许 NULL，NULL 表示回落到 lib/platform.js 的内置默认值（老库升级无需补数据）
  // sort_order 刻意不用 NOT NULL DEFAULT 100：否则「未配置」会被哨兵值掩盖，
  // 所有供应商挤在同一顺位，内置差异化排序失效。
  ['platform_ai_providers', 'signup_url', 'VARCHAR(255) NULL DEFAULT NULL', null],
  ['platform_ai_providers', 'docs_url', 'VARCHAR(255) NULL DEFAULT NULL', null],
  ['platform_ai_providers', 'note', 'VARCHAR(500) NULL DEFAULT NULL', null],
  ['platform_ai_providers', 'sort_order', 'INT NULL DEFAULT NULL', null],
  // 1.1.8 平台付费侧的模型治理：默认模型 / 每模型设置 / 兜底系统提示词
  // 同样全部允许 NULL（NULL = 未自定义，读取时回落内置默认）
  ['platform_ai_providers', 'default_model', 'VARCHAR(120) NULL DEFAULT NULL', null],
  ['platform_ai_providers', 'model_settings_json', 'MEDIUMTEXT NULL', null],
  ['platform_ai_providers', 'system_prompt', 'TEXT NULL', null],
  // 1.1.5 多仓库：仓库注册表补状态与最近同步时间
  // status 决定该仓库的 /api/storage/* 是否放行（disabled=拒绝但数据保留）
  ['user_vaults', 'status', "ENUM('active','disabled') NOT NULL DEFAULT 'active'", null],
  ['user_vaults', 'last_synced_at', 'DATETIME NULL DEFAULT NULL', null],
  ['user_vaults', 'created_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', null],
  // 1.1.8 后台看板：AI 调用的成功/失败与耗时，用于「失败率」与「平均响应时间」。
  // status 默认 'ok'：老数据视为成功（历史上没有失败记录这一维度，不能凭空制造失败）。
  ['ai_usage', 'status', "ENUM('ok','error') NOT NULL DEFAULT 'ok'", null],
  ['ai_usage', 'latency_ms', 'INT NOT NULL DEFAULT 0', null],
  ['ai_usage', 'error_code', 'VARCHAR(64) NULL DEFAULT NULL', null],
  /*
   * 1.4.0 后台用户管理：封禁（含原因与到期时间）。
   *
   * 为什么不新增 `status='banned'` 枚举值：`users.status` 已被登录鉴权、用户列表筛选、
   * `/api/auth/me` 等多处按 `ENUM('active','disabled')` 消费，改枚举属于**破坏性 schema 变更**
   * （老代码 SELECT 到 'banned' 会走 else 分支，且 ENUM 顺序变化会让既有行语义漂移）。
   * 这里改为「`status='disabled'` + `ban_reason` 非空」表达封禁，语义由本组接口维护：
   *   - 封禁 = status→disabled，写 ban_reason/banned_at/ban_until；
   *   - 解封 = status→active，三列清空；
   *   - 人工「禁用」（不填原因）不写这三列，与封禁在 UI 上区分展示。
   * 三列全部可空、无默认值，因此对既有数据零影响，可重复执行。
   */
  ['users', 'ban_reason', 'VARCHAR(255) NULL DEFAULT NULL', null],
  ['users', 'banned_at', 'DATETIME NULL DEFAULT NULL', null],
  ['users', 'ban_until', 'DATETIME NULL DEFAULT NULL', null],
  // 1.4.0 后台看板/用户列表按「最后活跃」排序：审计表按用户取 MAX(created_at) 需要复合索引
  // （老库只有 idx_audit_logs_user(user_id)，回表取时间会扫大量行）
  /*
   * 1.4.0 需求10：标识「自动登记的空壳仓库」，用于清理与限流。
   *
   * ## 为什么需要这一列
   *
   * `lib/vault-scope.js` 的 `assertVaultUsable()` 对**未登记的 (user_id, vault_id)**
   * 会无条件 `INSERT ... active` —— 于是「客户端首次带一个随机 vaultId 访问存储」
   * 就会在 `user_vaults` 里凭空登记一条。配合客户端 `openVault()` 在云端无仓库时
   * 落 `uid('vault')` 随机 id 的逻辑，每开一次新 profile / 每跑一次测试脚本
   * 就会多一条 `vaultxxx` 空壳（生产库实测：4 条真实 + 6 条空壳，全部 0 文档）。
   *
   * 加这一列的目的不是「拦住写入」（自动登记本身是必要的，否则首同步会 403），
   * 而是让**事后能准确识别**哪些是自动产生的、可以安全清理：
   *   - `auto_registered = 1` 且 `doc_count = 0` 且云端前缀无对象 → 确定是空壳；
   *   - 用户主动创建的仓库 / 有过任何文档的仓库 → `0`，永不自动清理。
   * 默认 0 保证**既有行一律被视为「非自动」**，不会被清理脚本误删（保守优先）。
   */
  ['user_vaults', 'auto_registered', 'TINYINT(1) NOT NULL DEFAULT 0', null],
  // 自动登记时间：与用户主动创建区分，也便于按时间窗口排查
  ['user_vaults', 'auto_registered_at', 'DATETIME NULL DEFAULT NULL', null],
];

/**
 * 需要补充的索引：[表名, 索引名, 索引定义]
 * 索引用 information_schema.STATISTICS 判断是否已存在，可重复执行。
 */
const INDEX_ADDITIONS = [
  // 看板按「时间 + 状态」聚合失败率，加复合索引避免全表扫
  ['ai_usage', 'idx_ai_usage_created_status', '(`created_at`, `status`)'],
  /*
   * 1.4.0 后台用户管理「最后活跃 / 登录记录」：
   * 按用户聚合 MAX(created_at) 与按 (user_id, action) 过滤登录流水。
   * 老库只有 idx_audit_logs_user(user_id)，取时间要回表逐行读，用户多了会明显变慢。
   */
  ['audit_logs', 'idx_audit_logs_user_created', '(`user_id`, `created_at`)'],
  ['audit_logs', 'idx_audit_logs_action_created', '(`action`, `created_at`)'],
  /*
   * 1.4.0 后台插件市场按「状态 + 更新时间」翻页；市场列表按 downloads DESC 排序已有
   * idx_community_plugins_status(status, downloads)，后台默认按 id DESC 也可用主键。
   * 但「按分类筛选 + 翻页」缺少前缀索引，这里补一条。
   */
  ['community_plugins', 'idx_community_plugins_category', '(`category`, `status`)'],
  /*
   * 1.4.0 需求10：自动登记空壳的清理与限流查询。
   *
   * 清理脚本按 `(user_id, auto_registered, created_at)` 筛「某用户的自动登记空壳」；
   * `assertVaultUsable()` 的「同 name 复用」查询按 `(user_id, name, status)` 走。
   * 生产库 user_vaults 目前只有 10 行，索引收益不大，但这是**防复发**的一部分：
   * 上限校验每次自动登记都要数一次 active 数量，没有索引在仓库数增长后会变慢。
   */
  ['user_vaults', 'idx_user_vaults_user_auto', '(`user_id`, `auto_registered`, `created_at`)'],
  ['user_vaults', 'idx_user_vaults_user_name', '(`user_id`, `name`, `status`)'],
];

/**
 * 说明：设置的多端分区同步（global 强一致 + platform 差异化）
 * 直接复用 `user_settings.payload_json` / `payload_enc` 的 JSON 结构，不新增表或列，
 * 因此这里不需要任何迁移动作；旧行的平铺结构在读取时整体视为 global。
 */

/** 列是否已存在 */
async function columnExists(table, column) {
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(row?.total ?? 0) > 0;
}

/** 表是否已存在 */
async function tableExists(table) {
  const row = await queryOne(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return Number(row?.total ?? 0) > 0;
}

/** 补齐缺失列，返回实际执行的 ALTER 语句数量 */
export async function ensureColumns() {
  let applied = 0;
  for (const [table, column, definition, after] of COLUMN_ADDITIONS) {
    if (!(await tableExists(table))) continue;
    if (await columnExists(table, column)) continue;
    const position = after && (await columnExists(table, after)) ? ` AFTER \`${after}\`` : '';
    await execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}${position}`);
    applied += 1;
  }
  return applied;
}

/**
 * 补齐 1.1.5 多仓库所需的索引（幂等）。
 *
 * 为什么需要：仓库列表按 `(user_id, status)` 过滤，仓库多了以后
 * 不加索引会走全表扫；`idx_user_vaults_user_status` 在 schema.sql 的新建表里已有，
 * 但老库是 `CREATE TABLE IF NOT EXISTS` 跳过的，必须在这里补。
 *
 * @returns {Promise<number>} 实际创建的索引数
 */
async function ensureVaultIndexes() {
  if (!(await tableExists('user_vaults'))) return 0;
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_vaults' AND INDEX_NAME = ?`,
    ['idx_user_vaults_user_status'],
  );
  if (Number(row?.total ?? 0) > 0) return 0;
  await execute('ALTER TABLE `user_vaults` ADD KEY `idx_user_vaults_user_status` (`user_id`, `status`)');
  return 1;
}

/**
 * 补齐 1.1.7 AI 供应商展示排序所需的索引（幂等）。
 *
 * 后台与前台都按 `sort_order` 升序展示供应商，列刚补上时没有索引；
 * schema.sql 的新建表里已有 `idx_platform_ai_sort`，但老库是
 * `CREATE TABLE IF NOT EXISTS` 跳过的，必须在这里补。
 *
 * @returns {Promise<number>} 实际创建的索引数
 */
async function ensureProviderIndexes() {
  if (!(await tableExists('platform_ai_providers'))) return 0;
  if (!(await columnExists('platform_ai_providers', 'sort_order'))) return 0;
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_ai_providers' AND INDEX_NAME = ?`,
    ['idx_platform_ai_sort'],
  );
  if (Number(row?.total ?? 0) > 0) return 0;
  await execute('ALTER TABLE `platform_ai_providers` ADD KEY `idx_platform_ai_sort` (`sort_order`)');
  return 1;
}

/**
 * 补齐 INDEX_ADDITIONS 中声明的索引（幂等）。
 *
 * 为什么需要：schema.sql 里新建表已带这些索引，但老库是
 * `CREATE TABLE IF NOT EXISTS` 直接跳过的，必须在这里补。
 * 判断依据是 information_schema.STATISTICS，可重复执行。
 *
 * @returns {Promise<number>} 实际创建的索引数
 */
async function ensureDeclaredIndexes() {
  let applied = 0;
  for (const [table, indexName, definition] of INDEX_ADDITIONS) {
    if (!(await tableExists(table))) continue;
    const row = await queryOne(
      `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, indexName],
    );
    if (Number(row?.total ?? 0) > 0) continue;
    await execute(`ALTER TABLE \`${table}\` ADD KEY \`${indexName}\` ${definition}`);
    applied += 1;
  }
  return applied;
}

/**
 * 补齐 1.1.8 知识库访问令牌表（幂等）。
 *
 * schema.sql 里已用 `CREATE TABLE IF NOT EXISTS` 建表，新库直接就有；
 * 但老库是靠启动时执行 schema.sql 才补上的，而有些部署（例如只跑 migrate-v2.js、
 * 或用精简版 schema）可能跳过。这里显式再建一次，保证「升级即用」。
 *
 * 列定义必须与 schema.sql 保持一致，避免两处漂移。
 *
 * @returns {Promise<number>} 实际创建的表数（0 或 1）
 */
async function ensureKnowledgeTokens() {
  if (await tableExists('knowledge_tokens')) return 0;
  await execute(
    `CREATE TABLE IF NOT EXISTS \`knowledge_tokens\` (
       \`id\` BIGINT NOT NULL AUTO_INCREMENT,
       \`user_id\` BIGINT NOT NULL,
       \`name\` VARCHAR(80) NOT NULL,
       \`token_hash\` CHAR(64) NOT NULL,
       \`token_prefix\` VARCHAR(16) NOT NULL DEFAULT '',
       \`scope\` ENUM('read','write') NOT NULL DEFAULT 'read',
       \`expires_at\` DATETIME NULL DEFAULT NULL,
       \`last_used_at\` DATETIME NULL DEFAULT NULL,
       \`revoked_at\` DATETIME NULL DEFAULT NULL,
       \`created_at\` DATETIME NOT NULL,
       PRIMARY KEY (\`id\`),
       UNIQUE KEY \`uk_knowledge_tokens_hash\` (\`token_hash\`),
       KEY \`idx_knowledge_tokens_user\` (\`user_id\`, \`revoked_at\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );
  return 1;
}

/**
 * 补齐 1.4.0 客户端安装包下载统计表（幂等）。
 *
 * ## 为什么需要这张表
 *
 * 需求要求后台「客户端分发」能看到每个安装包的**下载次数**。这个数据在 1.4.0 之前
 * 完全没有采集：`download.js` 只负责 302 跳转 / 流式代理，没有任何计数落库，
 * 而对象存储的访问日志不对本服务开放。所以必须先有地方存，后端才能在后台读出来。
 *
 * ## 为什么按 (file, day) 聚合而不是每次下载插一行
 *
 * 明细表会随下载量线性膨胀（每次发版预热都是几百次下载），而运营真正需要的只有
 * 「总数」与「近 7 天趋势」。按天聚合把写入摊平成 UPSERT，行数上界是
 * `文件数 × 天数`，十年也就几千行，永远不会成为负担。需要明细时再查审计日志。
 *
 * ## 幂等性
 *
 * `CREATE TABLE IF NOT EXISTS` + 主键 `(file, day)`，重复启动无副作用；
 * 新库由 schema.sql 建同一张表（两处定义保持一致，避免漂移）。
 *
 * @returns {Promise<number>} 实际创建的表数（0 或 1）
 */
async function ensureReleaseDownloadStats() {
  if (await tableExists('release_downloads')) return 0;
  await execute(
    `CREATE TABLE IF NOT EXISTS \`release_downloads\` (
       \`file\` VARCHAR(190) NOT NULL,
       \`day\` DATE NOT NULL,
       \`count\` INT NOT NULL DEFAULT 0,
       \`last_at\` DATETIME NULL DEFAULT NULL,
       PRIMARY KEY (\`file\`, \`day\`),
       KEY \`idx_release_downloads_day\` (\`day\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );
  return 1;
}

/**
 * 【只读检测，绝不改数据】扫描残留的错误对象存储配置（1.1.9）。
 *
 * 背景：生产库曾有账号的云端设置里存着 `bucket: "zhenglob"`（真实桶名是 `zhengle`）
 * 且 accessKeyId 正好等于平台内置 AK 的配置，前端会据此直连一个不存在的桶，
 * 是「同步失败：Failed to fetch」的来源之一。
 *
 * 为什么只检测、不在这里清理（重要）：
 *  1. 这段代码跑在**服务启动期**，每次启动都会执行；一旦清理逻辑有偏差，
 *     就会在所有用户的加密设置上做不可逆改写（用户自建 S3 / 自建 AI Key 全部丢失）；
 *  2. `payload_enc` 是 AES-256-GCM 密文，启动期做「解密 → 改 → 重加密 → 写回」的
 *     失败模式极难在部署现场发现，风险远大于收益；
 *  3. 实际影响已由前端的「已登录永不直连自建 S3」不变量消除，残留配置不会再被使用；
 *  4. 清理应当由**用户主动触发**（设置页「重置对象存储配置」按钮走 resetStorageConfig()），
 *     这才是正确的授权边界。
 *
 * 因此本函数只做两件事：精确条件匹配 + 打印日志，**不含任何 UPDATE**。
 *
 * 精确判据（两者同时满足才报告，避免误伤真实的自建 S3）：
 *  - `storage.bucket === 'zhenglob'`（一个不可能存在的拼写错误）
 *  - `storage.accessKeyId` 非空且等于平台内置 AK
 *
 * @returns {Promise<{scanError?: string, suspicious: Array<{userId:number, bucket:string}>}>}
 */
async function detectStaleZhenglobStorage() {
  const result = { suspicious: [] };
  let rows;
  try {
    rows = await query('SELECT user_id, payload_json FROM user_settings');
  } catch (err) {
    // 老库可能还没有 user_settings 表：不阻断迁移，如实记录
    result.scanError = err?.message ?? String(err);
    return result;
  }

  const platformKey = platformStorageKey();
  // 平台 AK 读不到时直接放弃扫描：空串会让匹配条件失去意义，宁可漏报也不误报
  if (!platformKey) return result;

  for (const row of rows) {
    let payload = null;
    try {
      payload = row.payload_json ? JSON.parse(String(row.payload_json)) : null;
    } catch {
      continue;
    }
    for (const storage of collectStorageGroups(payload)) {
      if (!storage || typeof storage !== 'object') continue;
      const bucket = String(storage.bucket ?? '').trim();
      const ak = String(storage.accessKeyId ?? '').trim();
      if (bucket !== 'zhenglob') continue;
      if (!ak || ak !== platformKey) continue;
      result.suspicious.push({ userId: Number(row.user_id), bucket });
      break;
    }
  }
  return result;
}

/**
 * 收集一条设置里的全部 storage 分组（兼容 v2 的 global + 各 platform 分区与旧版平铺）。
 * @param {unknown} payload
 * @returns {unknown[]}
 */
function collectStorageGroups(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  const push = (group) => {
    if (group && typeof group === 'object' && group.storage) out.push(group.storage);
  };
  if (payload.global || payload.platform) {
    push(payload.global);
    if (payload.platform && typeof payload.platform === 'object') {
      for (const group of Object.values(payload.platform)) push(group);
    }
  } else {
    // 旧版平铺结构：整体视为一个分组
    push(payload);
  }
  return out;
}

/**
 * 平台内置对象存储的 AccessKeyId（只读配置，不含 Secret）。
 * @returns {string}
 */
function platformStorageKey() {
  try {
    const cfg = platformConfig();
    return String(cfg?.accessKeyId ?? '').trim();
  } catch {
    return '';
  }
}

/** 缺失时写入一条 platform_config 默认值 */
async function seedConfig(key, value) {
  const existing = await queryOne('SELECT cfg_key FROM platform_config WHERE cfg_key = ? LIMIT 1', [key]);
  if (existing) return false;
  await execute('INSERT INTO platform_config (cfg_key, cfg_value, updated_at) VALUES (?, ?, NOW())', [
    key,
    String(value),
  ]);
  return true;
}

/** 补充供应商目录：已存在的行一律不改，避免覆盖管理员配置 */
async function seedProviders() {
  let created = 0;
  for (const def of PLATFORM_PROVIDERS) {
    const existing = await queryOne('SELECT provider FROM platform_ai_providers WHERE provider = ? LIMIT 1', [def.provider]);
    if (existing) continue;
    await execute(
      `INSERT INTO platform_ai_providers (provider, base_url, api_key_enc, models_json, enabled, updated_at)
       VALUES (?, ?, NULL, ?, 0, NOW())`,
      [def.provider, def.baseUrl, JSON.stringify(def.models)],
    );
    created += 1;
  }
  return created;
}

/** 写入平台默认配置与供应商 */
export async function seedPlatformDefaults() {
  const details = { config: [], providers: 0 };
  if (await seedConfig('credit_per_yuan', String(DEFAULT_CREDIT_PER_YUAN))) details.config.push('credit_per_yuan');
  if (await seedConfig('model_prices', JSON.stringify(DEFAULT_MODEL_PRICES))) details.config.push('model_prices');
  if (await seedConfig('payment_methods', JSON.stringify(DEFAULT_PAYMENT_METHODS))) details.config.push('payment_methods');
  details.providers = await seedProviders();
  return details;
}

/**
 * 执行 v2 迁移。
 * @returns {Promise<{columns: number, config: string[], providers: number, vaultIndexes: number, providerIndexes: number, declaredIndexes: number, knowledgeTables: number, staleStorage: number}>}
 */
export async function migrateV2() {
  const columns = await ensureColumns();
  const vaultIndexes = await ensureVaultIndexes();
  const providerIndexes = await ensureProviderIndexes();
  const declaredIndexes = await ensureDeclaredIndexes();
  const knowledgeTables = await ensureKnowledgeTokens();
  const releaseDownloadTables = await ensureReleaseDownloadStats();
  const seeded = await seedPlatformDefaults();

  /*
   * 只读体检：扫描残留的错误对象存储配置，打印到日志供运维跟进。
   * 刻意**不在这里清理**（理由见 detectStaleZhenglobStorage 的注释）：
   * 启动期改写用户的加密设置风险不可控，清理应由用户在设置页主动触发。
   */
  let staleStorage = 0;
  try {
    const stale = await detectStaleZhenglobStorage();
    if (stale.scanError) {
      console.warn(`[migrate] 残留存储配置扫描跳过：${stale.scanError}`);
    } else if (stale.suspicious.length > 0) {
      staleStorage = stale.suspicious.length;
      const ids = stale.suspicious.map((s) => s.userId).join(',');
      console.warn(
        `[migrate] 检测到 ${staleStorage} 条残留 zhenglob 存储配置 user_id=[${ids}]（不自动清理；` +
          `请在设置页「对象存储」点「重置对象存储配置」，或由用户自行改桶名）`,
      );
    } else {
      console.log('[migrate] 未检测到残留的 zhenglob 存储配置');
    }
  } catch (err) {
    // 体检失败绝不能阻断启动
    console.warn(`[migrate] 残留存储配置扫描异常：${err?.message ?? String(err)}`);
  }

  return {
    columns,
    ...seeded,
    vaultIndexes,
    providerIndexes,
    declaredIndexes,
    knowledgeTables,
    releaseDownloadTables,
    staleStorage,
  };
}

// 允许直接运行：node src/db/migrate-v2.js
// 单独运行会先走一遍 schema.sql 建表，再执行增量迁移，因此新库老库都能用。
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  migrate()
    .then(() => migrateV2())
    .then(async (result) => {
      console.log(
        `[db] v2 迁移完成：新增列 ${result.columns} 个，补充配置 ${result.config.length} 项，新增供应商 ${result.providers} 个，新增索引 ${(result.vaultIndexes ?? 0) + (result.providerIndexes ?? 0) + (result.declaredIndexes ?? 0)} 个，新增表 ${(result.knowledgeTables ?? 0) + (result.releaseDownloadTables ?? 0)} 个`,
      );
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[db] v2 迁移失败：', err.message);
      try {
        await closePool();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
}

export default { migrateV2, ensureColumns, seedPlatformDefaults };
