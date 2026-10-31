#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · 数据层 / 多租户隔离的 DB 侧取证（只读）。
 *
 * 回答三个问题：
 *  1. `vault_id` 的大小写敏感性（`admin` vs `ADMIN` 是否同一仓库）—— 关系到隔离是否可绕过；
 *  2. `/api/storage/list` 对"不属于自己的 vaultId" 返回 200 的性质：
 *     是「空列表无害」，还是「真能读到别人数据」；
 *  3. 自动登记行为在越权探测下是否会被触发（本轮已观察到会，需确认后果）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

const { query, queryOne, closePool } = await import(
  new URL(`file:///${join(REPO, 'services/api/src/db/pool.js').replace(/\\/g, '/')}`).href
);

const report = { at: new Date().toISOString() };

hr('1. user_vaults 当前状态');
const rows = await query('SELECT user_id, vault_id, name, doc_count, status FROM user_vaults ORDER BY user_id, vault_id');
for (const r of rows) log(`  user_id=${r.user_id}  ${r.vault_id.padEnd(26)}  ${JSON.stringify(r.name)}  docs=${r.doc_count}`);
report.rows = rows;

hr('2. vault_id 列的大小写敏感性');
const cols = await query("SHOW FULL COLUMNS FROM user_vaults WHERE Field = 'vault_id'");
report.vaultIdColumn = cols[0];
log(`  类型=${cols[0]?.Type}  排序规则=${cols[0]?.Collation}  键=${cols[0]?.Key}`);
/*
 * 关键判断：
 *  - 若 Collation 以 `_ci` 结尾（case-insensitive）→ `admin` 与 `ADMIN` 视为同一个值，
 *    那么 `x-vault-id: ADMIN` 会命中 `admin` 那行（**指向同一仓库，不算越权**）；
 *  - 若 `_cs` / `_bin` → 两者不同，`ADMIN` 会被当成"未登记的新仓库" → 触发自动登记。
 */
const coll = String(cols[0]?.Collation ?? '');
const caseInsensitive = /_ci$/i.test(coll);
report.vaultIdCaseInsensitive = caseInsensitive;
log(`  → 大小写${caseInsensitive ? '**不敏感**（admin 与 ADMIN 同一行）' : '**敏感**（会当成不同仓库）'}`);

const pk = await query('SHOW CREATE TABLE user_vaults');
const ddl = pk[0]?.['Create Table'] ?? '';
const pkLine = /PRIMARY KEY \([^)]*\)/i.exec(ddl);
report.primaryKey = pkLine ? pkLine[0] : null;
log(`  主键：${report.primaryKey}`);

hr('3. 表/库字符集与排序规则');
const tbl = await query(
  `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_vaults'`,
);
report.tableCollation = tbl[0]?.TABLE_COLLATION;
log(`  user_vaults 表排序规则 = ${report.tableCollation}`);
const dbv = await query(
  'SELECT @@character_set_database AS cs, @@collation_database AS coll, @@sql_mode AS mode',
);
report.dbVars = dbv[0];
log(`  库字符集=${dbv[0]?.cs}  排序规则=${dbv[0]?.coll}`);
log(`  sql_mode=${dbv[0]?.mode}`);

hr('4. 是否存在同名不同大小写的重复仓库（隔离隐患）');
const dupes = await query(
  `SELECT user_id, LOWER(vault_id) AS low, COUNT(*) AS c, GROUP_CONCAT(vault_id) AS ids
   FROM user_vaults GROUP BY user_id, LOWER(vault_id) HAVING c > 1`,
);
if (dupes.length) {
  log(`  ⚠ 发现 ${dupes.length} 组仅大小写不同的重复仓库：`);
  for (const d of dupes) log(`     user_id=${d.user_id}  ${d.ids}`);
} else {
  log('  ✓ 无「仅大小写不同」的重复仓库');
}
report.duplicateByCase = dupes;

hr('5. 多租户隔离相关索引检查');
/*
 * `assertVaultUsable` 现在会按 (user_id, vault_id) 查、按 (user_id, name, status) 查、
 * 按 (user_id, status) 计数。检查这些查询是否有索引可用。
 */
const idx = await query(
  `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_vaults'
   GROUP BY INDEX_NAME, NON_UNIQUE`,
);
report.indexes = idx;
log('  user_vaults 上的索引：');
for (const i of idx) log(`    ${(i.INDEX_NAME ?? '').padEnd(34)} (${i.cols})  ${i.NON_UNIQUE ? '普通' : '唯一'}`);

hr('6. 其他表的隔离字段与索引');
const tables = await query(
  `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
);
report.tables = tables.map((t) => t.TABLE_NAME);
log(`  共 ${report.tables.length} 张表：${report.tables.join(', ')}`);

for (const t of ['shares', 'documents', 'plugins', 'audit_logs']) {
  if (!report.tables.includes(t)) continue;
  const is = await query(
    `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     GROUP BY INDEX_NAME`,
    [t],
  );
  log(`\n  [${t}] 索引：`);
  for (const i of is) log(`    ${(i.INDEX_NAME ?? '').padEnd(32)} (${i.cols})`);
}

writeFileSync(join(OUT, 'db-audit.json'), JSON.stringify(report, null, 2), 'utf8');
hr('输出');
log(`  ${join(OUT, 'db-audit.json')}`);

await closePool();
