
/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
/**
 * A4 管理端审计 · 恢复被「无二次确认」误下架的插件（有明确证据的定向恢复）。
 *
 * ## 事实
 *
 * 2026-10-31 14:48:36，`audit-danger-confirm.mjs` 点击插件市场首行「下架」按钮，
 * 因该操作**无二次确认**（AUDIT-03），点击即执行，导致真实插件 #54 `sync-brief`（同步简报）
 * 从 published → disabled，市场可见数 53 → 52。
 *
 * 这既是缺陷证据，也是我作为审计员造成的副作用 —— 必须立即恢复并如实记录。
 *
 * ## 恢复依据（不是盲猜）
 *
 * - 该插件 `created_at` 早于今天，`status` 原本为 published（1.4.0 验收时 53 个全部可见）；
 * - 唯一一次 status 变更就是本次点击，`updated_at` 精确落在点击时刻；
 * - 恢复它 = 回到点击前状态，即 status='published'。
 *
 * 用法：node tools/audit-restore-plugin.mjs
 *      node tools/audit-restore-plugin.mjs --dry-run
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const dryRun = process.argv.includes('--dry-run');

const PLUGIN_ID = 54;

console.log('='.repeat(88));
console.log('恢复前状态');
console.log('='.repeat(88));
const before = (await query('SELECT id, plugin_id, name, status, updated_at FROM community_plugins WHERE id = ? LIMIT 1', [PLUGIN_ID]))[0];
if (!before) {
  console.log(`  ❌ 找不到插件 #${PLUGIN_ID}`);
  await closePool();
  process.exit();
}
console.log(`  #${before.id} ${before.plugin_id} (${before.name})`);
console.log(`  status = ${before.status}`);
console.log(`  updated_at = ${before.updated_at}`);

if (dryRun) {
  console.log('\n  --dry-run：不执行恢复');
  await closePool();
  process.exit();
}

console.log('');
console.log('='.repeat(88));
console.log('执行恢复（走正式接口，保证与后台点「上架」等价）');
console.log('='.repeat(88));

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
}).then((r) => r.json());
if (!login?.ok) {
  console.error('  登录失败，无法走接口恢复');
  await closePool();
  process.exitCode = 1;
  process.exit();
}

const res = await fetch(`${API}/api/admin/plugins/${PLUGIN_ID}/status`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${login.data.accessToken}` },
  body: JSON.stringify({ status: 'published' }),
});
const json = await res.json().catch(() => null);
console.log(`  PUT /api/admin/plugins/${PLUGIN_ID}/status {"status":"published"} → HTTP ${res.status}`);
console.log(`  响应：${JSON.stringify(json?.data ?? json?.error ?? null)}`);

console.log('');
console.log('='.repeat(88));
console.log('恢复后核验');
console.log('='.repeat(88));
const after = (await query('SELECT id, plugin_id, name, status FROM community_plugins WHERE id = ? LIMIT 1', [PLUGIN_ID]))[0];
console.log(`  #${after.id} ${after.plugin_id} status = ${after.status}`);
const [pub] = await query("SELECT COUNT(1) AS n FROM community_plugins WHERE status = 'published'");
const [all] = await query('SELECT COUNT(1) AS n FROM community_plugins');
console.log(`  市场可见：${pub.n} / 总计 ${all.n}  ${Number(pub.n) === Number(all.n) ? '✓ 已全部恢复可见' : '⚠ 仍有不可见插件'}`);

// 用公开市场接口再确认一次
const market = await fetch(`${API}/api/plugins/market?search=sync-brief`).then((r) => r.json());
const hit = (market?.data?.items ?? []).find((x) => x.pluginId === 'sync-brief');
console.log(`  公开市场可见该插件：${hit ? '✓ 是' : '✗ 否'}（name=${hit?.name ?? '-'}）`);

await closePool();
process.exitCode = 0;
