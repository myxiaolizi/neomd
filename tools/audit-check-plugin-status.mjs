/**
 * A4 管理端审计 · 检查「插件下架无二次确认」是否已造成真实数据变更（只读）。
 *
 * 背景：audit-danger-confirm.mjs 点击了插件市场第一行的「下架」按钮，
 * 因为该操作**没有二次确认**，点击即执行。必须核实：
 *   1. 现在有多少插件处于非 published 状态；
 *   2. 是否有插件的 status/updated_at 是「刚刚」被改的（即我误操作造成的）；
 *   3. 如果是，需要如实报告并给出恢复方案（审计员不擅自改回，除非明确是本次造成）。
 *
 * 用法：node tools/audit-check-plugin-status.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

console.log('='.repeat(88));
console.log('1. 插件状态分布');
console.log('='.repeat(88));
const dist = await query('SELECT status, COUNT(1) AS n FROM community_plugins GROUP BY status ORDER BY status');
for (const x of dist) console.log(`  ${String(x.status).padEnd(12)} = ${x.n}`);

console.log('');
console.log('='.repeat(88));
console.log('2. 非 published 的插件（按 updated_at 倒序，看是否有"刚刚"被改的）');
console.log('='.repeat(88));
const rows = await query(
  `SELECT id, plugin_id, name, status, updated_at, created_at
   FROM community_plugins
   WHERE status <> 'published'
   ORDER BY updated_at DESC
   LIMIT 10`,
);
if (!rows.length) console.log('  （没有非 published 插件）');
for (const x of rows) {
  console.log(`  #${String(x.id).padEnd(4)} ${String(x.plugin_id).padEnd(28)} ${String(x.name).padEnd(20)} status=${String(x.status).padEnd(10)} updated=${x.updated_at}`);
}

console.log('');
console.log('='.repeat(88));
console.log('3. 最近 30 分钟内被修改过的插件（最可能是本次审计的点击造成）');
console.log('='.repeat(88));
const recent = await query(
  `SELECT id, plugin_id, name, status, updated_at
   FROM community_plugins
   WHERE updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)
   ORDER BY updated_at DESC`,
);
if (!recent.length) {
  console.log('  ✅ 最近 30 分钟没有插件被修改 —— 本次「下架」点击未造成真实数据变更');
} else {
  for (const x of recent) {
    console.log(`  #${x.id} ${x.plugin_id} status=${x.status} updated=${x.updated_at}`);
  }
  console.log('');
  console.log('  ⚠ 有插件在最近 30 分钟内被改，需要人工确认是否为本次审计造成。');
  console.log('    恢复方式（若确认是误操作）：后台插件市场点「上架」，或调');
  console.log('    PUT /api/admin/plugins/<id>/status  body {"status":"published"}');
}

console.log('');
console.log('='.repeat(88));
console.log('4. 插件市场可见数量（published）');
console.log('='.repeat(88));
const [pub] = await query("SELECT COUNT(1) AS n FROM community_plugins WHERE status = 'published'");
const [all] = await query('SELECT COUNT(1) AS n FROM community_plugins');
console.log(`  可见（published）：${pub.n} / 总计：${all.n}`);

await closePool();
process.exitCode = 0;
