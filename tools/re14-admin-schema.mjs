/**
 * Neo MD 1.4 · 后台组 T2 · schema 变更前快照 + 变更后断言（只读 + 幂等迁移驱动）。
 *
 * 用途（对应 Lead 对 schema 变更的硬约束 2）：
 *   1. `--dump`     执行前 dump 相关表结构（SHOW CREATE TABLE）到 docs/shots-140/ 之外的日志文件；
 *   2. `--apply`    执行 migrate-v2.js 的幂等增量迁移（唯一入口，不手写 ALTER）；
 *   3. `--verify`   用 information_schema 断言列/表/索引存在；
 *   4. `--data`     只读统计既有数据行数，证明「没改、没删既有数据」。
 *
 * 用法：
 *   node tools/re14-admin-schema.mjs --dump
 *   node tools/re14-admin-schema.mjs --apply --verify --data
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..', 'services', 'api');
process.chdir(apiRoot);

/** Windows 下动态 import 必须用 file:// URL，直接传盘符路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME */
const modUrl = (rel) => pathToFileURL(path.join(apiRoot, rel)).href;

const argv = new Set(process.argv.slice(2));
const want = (flag) => argv.has(flag);

const { query, queryOne, closePool } = await import(modUrl('src/db/pool.js'));

/** 本次 1.4.0 新增/触及的表与列（断言清单，唯一事实源） */
const EXPECTED_COLUMNS = [
  ['users', 'ban_reason'],
  ['users', 'banned_at'],
  ['users', 'ban_until'],
];
const EXPECTED_TABLES = ['release_downloads'];
const EXPECTED_INDEXES = [
  ['audit_logs', 'idx_audit_logs_user_created'],
  ['audit_logs', 'idx_audit_logs_action_created'],
  ['community_plugins', 'idx_community_plugins_category'],
  ['release_downloads', 'idx_release_downloads_day'],
];

/** 既有数据基线：这些表的行数在迁移前后必须完全一致（证明没动数据） */
const BASELINE_TABLES = ['users', 'community_plugins', 'audit_logs', 'user_vaults', 'shares', 'ai_usage'];

const DUMP_TABLES = ['users', 'audit_logs', 'community_plugins'];

let failures = 0;
function check(cond, label, extra) {
  if (cond) {
    console.log(`  PASS  ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? `  [${extra}]` : ''}`);
  }
}

async function columnExists(table, column) {
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(row?.total ?? 0) > 0;
}

async function tableExists(table) {
  const row = await queryOne(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return Number(row?.total ?? 0) > 0;
}

async function indexExists(table, index) {
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return Number(row?.total ?? 0) > 0;
}

async function countRows(table) {
  try {
    const row = await queryOne(`SELECT COUNT(*) AS total FROM \`${table}\``);
    return Number(row?.total ?? 0);
  } catch {
    return null;
  }
}

async function snapshotCounts() {
  const out = {};
  for (const t of BASELINE_TABLES) out[t] = await countRows(t);
  return out;
}

if (want('--dump')) {
  console.log('===== 变更前 schema 快照 =====');
  const lines = [];
  for (const t of DUMP_TABLES) {
    if (!(await tableExists(t))) {
      lines.push(`-- ${t}: 表不存在`);
      continue;
    }
    const row = await queryOne(`SHOW CREATE TABLE \`${t}\``);
    const ddl = row?.['Create Table'] ?? JSON.stringify(row);
    lines.push(`-- ===== ${t} =====\n${ddl};`);
  }
  const baseline = await snapshotCounts();
  lines.push(`-- 基线行数：${JSON.stringify(baseline)}`);
  const file = path.join(here, '.re14-admin-schema-before.sql');
  fs.writeFileSync(file, `${lines.join('\n\n')}\n`, 'utf8');
  console.log(`已写入 ${file}`);
  console.log(lines.join('\n\n').slice(0, 4000));
  console.log(`\n基线行数：${JSON.stringify(baseline)}`);
}

if (want('--apply')) {
  const before = await snapshotCounts();
  console.log('\n===== 执行幂等增量迁移（migrate-v2.js）=====');
  console.log(`迁移前行数：${JSON.stringify(before)}`);
  const mod = await import(modUrl('src/db/migrate-v2.js'));
  const result = await mod.migrateV2();
  console.log(`迁移结果：${JSON.stringify(result)}`);

  const after = await snapshotCounts();
  console.log(`迁移后行数：${JSON.stringify(after)}`);
  console.log('\n--- 幂等性：第二次执行应为 0 变更 ---');
  const second = await mod.migrateV2();
  console.log(`第二次结果：columns=${second.columns} tables=${(second.knowledgeTables ?? 0) + (second.releaseDownloadTables ?? 0)} indexes=${(second.vaultIndexes ?? 0) + (second.providerIndexes ?? 0) + (second.declaredIndexes ?? 0)}`);
  check(second.columns === 0, '第二次执行新增列 == 0');
  check((second.releaseDownloadTables ?? 0) === 0, '第二次执行 release_downloads 建表 == 0');
  check(
    (second.vaultIndexes ?? 0) + (second.providerIndexes ?? 0) + (second.declaredIndexes ?? 0) === 0,
    '第二次执行新增索引 == 0',
  );
  const stable = BASELINE_TABLES.every((t) => before[t] === after[t]);
  check(stable, '既有数据行数未变（未改未删）', JSON.stringify(after));
}

if (want('--verify')) {
  console.log('\n===== information_schema 断言 =====');
  for (const [t, c] of EXPECTED_COLUMNS) check(await columnExists(t, c), `列 ${t}.${c} 存在`);
  for (const t of EXPECTED_TABLES) check(await tableExists(t), `表 ${t} 存在`);
  for (const [t, i] of EXPECTED_INDEXES) check(await indexExists(t, i), `索引 ${t}.${i} 存在`);
  // 新列必须可空（可空 = 对既有数据零影响）
  for (const [t, c] of EXPECTED_COLUMNS) {
    const row = await queryOne(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [t, c],
    );
    check(String(row?.IS_NULLABLE ?? '').toUpperCase() === 'YES', `列 ${t}.${c} 可空（对既有行零影响）`);
  }
}

if (want('--data')) {
  console.log('\n===== 既有数据只读统计 =====');
  for (const t of BASELINE_TABLES) console.log(`  ${t}: ${await countRows(t)} 行`);
  const bans = await queryOne(
    "SELECT COUNT(*) AS total FROM users WHERE ban_reason IS NOT NULL AND ban_reason <> ''",
  );
  console.log(`  已封禁用户（ban_reason 非空）：${Number(bans?.total ?? 0)} 人`);
  const stats = await queryOne('SELECT COUNT(*) AS rows_, COALESCE(SUM(count),0) AS total FROM release_downloads').catch(() => null);
  console.log(`  release_downloads：${Number(stats?.rows_ ?? 0)} 行 / 累计 ${Number(stats?.total ?? 0)} 次下载`);
}

await closePool();
console.log(failures === 0 ? '\n全部断言通过' : `\n有 ${failures} 项断言失败`);
process.exit(failures === 0 ? 0 : 1);
