/**
 * 增量迁移 v2：在老库上补齐新增列，并写入平台默认配置与供应商目录。
 *
 * 所有 ALTER 都先用 information_schema 判断列是否已存在，
 * 因此重复执行不会报错；schema.sql 已经建好的新库会直接跳过。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execute, queryOne, closePool } from './pool.js';
import { migrate } from './migrate.js';
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
];

/**
 * 需要补充的索引：[表名, 索引名, 索引定义]
 * 索引用 information_schema.STATISTICS 判断是否已存在，可重复执行。
 */
const INDEX_ADDITIONS = [
  // 看板按「时间 + 状态」聚合失败率，加复合索引避免全表扫
  ['ai_usage', 'idx_ai_usage_created_status', '(`created_at`, `status`)'],
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
 * @returns {Promise<{columns: number, config: string[], providers: number, vaultIndexes: number, providerIndexes: number, declaredIndexes: number, knowledgeTables: number}>}
 */
export async function migrateV2() {
  const columns = await ensureColumns();
  const vaultIndexes = await ensureVaultIndexes();
  const providerIndexes = await ensureProviderIndexes();
  const declaredIndexes = await ensureDeclaredIndexes();
  const knowledgeTables = await ensureKnowledgeTokens();
  const seeded = await seedPlatformDefaults();
  return { columns, ...seeded, vaultIndexes, providerIndexes, declaredIndexes, knowledgeTables };
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
        `[db] v2 迁移完成：新增列 ${result.columns} 个，补充配置 ${result.config.length} 项，新增供应商 ${result.providers} 个，新增索引 ${(result.vaultIndexes ?? 0) + (result.providerIndexes ?? 0) + (result.declaredIndexes ?? 0)} 个，新增表 ${result.knowledgeTables ?? 0} 个`,
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
