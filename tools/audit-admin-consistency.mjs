
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
 * A4 管理端审计 · 数据一致性核对（只读）。
 *
 * 目的：把「后台接口返回的数字」与「直接查生产库的权威值」逐项对照，
 * 找出统计口径错误。审计原则：不改任何数据，只读。
 *
 * 用法：node tools/audit-admin-consistency.mjs
 *      API_BASE=http://127.0.0.1:3211 node tools/audit-admin-consistency.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const mod = (rel) => pathToFileURL(path.join(apiRoot, rel)).href;

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const { query, closePool } = await import(mod('src/db/pool.js'));

let pass = 0;
const fails = [];
const rows = [];

function cmp(label, apiVal, dbVal, note = '') {
  const a = Number(apiVal ?? 0);
  const d = Number(dbVal ?? 0);
  const ok = a === d;
  if (ok) pass += 1;
  else fails.push(`${label}: 后台=${a} DB=${d} ${note}`);
  rows.push({ label, api: a, db: d, ok, note });
  console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${label.padEnd(34)} 后台=${String(a).padStart(8)}  DB=${String(d).padStart(8)}${ok ? '' : '   <<< 不一致'}${note ? `  (${note})` : ''}`);
}

/* ---------------- 登录 ---------------- */
const loginRes = await fetch(`${B}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
});
const login = await loginRes.json();
if (!login?.ok) {
  console.error(`登录失败 HTTP ${loginRes.status}: ${JSON.stringify(login).slice(0, 200)}`);
  process.exitCode = 1;
  await closePool();
  process.exit();
}
const H = { authorization: `Bearer ${login.data.accessToken}` };
const get = async (p) => (await fetch(`${B}${p}`, { headers: H }).then((r) => r.json()));
const one = async (sql) => (await query(sql))[0];

console.log('='.repeat(96));
console.log('A. 概览统计一致性（/api/admin/dashboard vs DB）');
console.log('='.repeat(96));
const dash = (await get('/api/admin/dashboard?days=7')).data;
const m = dash.metrics;

let r = await one(`SELECT COUNT(*) AS total,
  SUM(status='active') AS active, SUM(status='disabled') AS disabled, SUM(role='admin') AS admins,
  SUM(DATE(created_at)=CURDATE()) AS new_today,
  SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_week
  FROM users`);
cmp('users.total', m.users.total, r.total);
cmp('users.active', m.users.active, r.active);
cmp('users.disabled', m.users.disabled, r.disabled);
cmp('users.admins', m.users.admins, r.admins);
cmp('users.newToday', m.users.newToday, r.new_today, 'DATE(created_at)=CURDATE()');
cmp('users.newThisWeek', m.users.newThisWeek, r.new_week);

r = await one('SELECT COUNT(*) AS vaults, COALESCE(SUM(doc_count),0) AS docs FROM user_vaults');
cmp('documents.vaults', m.documents.vaults, r.vaults);
cmp('documents.total', m.documents.total, r.docs, 'SUM(doc_count)');

r = await one('SELECT COALESCE(SUM(bytes),0) AS bytes FROM user_vaults');
cmp('storage.bytes', m.storage.bytes, r.bytes);

r = await one('SELECT COUNT(*) AS calls, COALESCE(SUM(in_tokens),0) AS in_t, COALESCE(SUM(out_tokens),0) AS out_t FROM ai_usage');
cmp('ai.callsTotal', m.ai.callsTotal, r.calls);
cmp('ai.inTokensTotal', m.ai.inTokensTotal, r.in_t);
cmp('ai.outTokensTotal', m.ai.outTokensTotal, r.out_t);

r = await one('SELECT COALESCE(SUM(credits),0) AS c FROM users');
cmp('credits.circulating', m.credits.circulating, r.c);

console.log('');
console.log('='.repeat(96));
console.log('B. 概览统计一致性（/api/admin/stats vs DB）');
console.log('='.repeat(96));
const st = (await get('/api/admin/stats')).data;

r = await one('SELECT COUNT(*) AS total, SUM(status=\'active\') AS active FROM users');
cmp('stats.users.total', st.users.total, r.total);
cmp('stats.users.active', st.users.active, r.active);

r = await one('SELECT COUNT(*) AS total, SUM(revoked_at IS NULL) AS active, COALESCE(SUM(view_count),0) AS views FROM shares');
cmp('stats.shares.total', st.shares.total, r.total);
cmp('stats.shares.active', st.shares.active, r.active);
cmp('stats.shares.views', st.shares.views, r.views);

r = await one('SELECT COUNT(*) AS total, SUM(revoked_at IS NULL) AS active FROM publishes');
cmp('stats.publishes.total', st.publishes.total, r.total);
cmp('stats.publishes.active', st.publishes.active, r.active);

r = await one('SELECT COUNT(*) AS total, SUM(status=\'hidden\') AS hidden FROM share_comments');
cmp('stats.comments.total', st.comments.total, r.total);
cmp('stats.comments.hidden', st.comments.hidden, r.hidden);

r = await one('SELECT COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(doc_count),0) AS docs, COUNT(*) AS vaults FROM user_vaults');
cmp('stats.storage.bytes', st.storage.bytes, r.bytes);
cmp('stats.storage.documents', st.storage.documents, r.docs);
cmp('stats.storage.vaults', st.storage.vaults, r.vaults);

r = await one('SELECT COUNT(*) AS requests, COALESCE(SUM(in_tokens),0) AS in_t, COALESCE(SUM(out_tokens),0) AS out_t FROM ai_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)');
cmp('stats.ai.requests24h', st.ai.requests24h, r.requests, 'stats 用 NOW()');
cmp('stats.ai.inTokens24h', st.ai.inTokens24h, r.in_t, 'stats 用 NOW()');
cmp('stats.ai.outTokens24h', st.ai.outTokens24h, r.out_t, 'stats 用 NOW()');

console.log('');
console.log('='.repeat(96));
console.log('C. 账本一致性（/api/admin/ledger vs credit_ledger）');
console.log('='.repeat(96));
const led = (await get('/api/admin/ledger?page=1&pageSize=20')).data;
r = await one('SELECT COUNT(*) AS total FROM credit_ledger');
cmp('ledger.total', led.total, r.total);
r = await one('SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) AS inflow, COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) AS outflow FROM credit_ledger');
cmp('ledger.summary.inflow', led.summary.inflow, r.inflow);
cmp('ledger.summary.outflow', led.summary.outflow, r.outflow);

console.log('');
console.log('='.repeat(96));
console.log('D. AI 用量一致性（/api/admin/ai-analytics vs ai_usage）');
console.log('='.repeat(96));
const ai = (await get('/api/admin/ai-analytics?days=7')).data;
if (ai) {
  const totalCalls = (ai.byDay ?? []).reduce((s, x) => s + Number(x.calls ?? 0), 0);
  r = await one('SELECT COUNT(*) AS calls FROM ai_usage WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)');
  cmp('ai-analytics.byDay 合计', totalCalls, r.calls, '7 天窗口，用 UTC_TIMESTAMP 对齐');
  console.log(`  （ai-analytics 顶层字段：${Object.keys(ai).join(', ')}）`);
}

console.log('');
console.log('='.repeat(96));
console.log('E. 用户列表统计一致性');
console.log('='.repeat(96));
const ul = (await get('/api/admin/users?page=1&pageSize=50')).data;
r = await one('SELECT COUNT(*) AS total FROM users');
cmp('users 列表 total', ul.total, r.total);
for (const u of ul.items) {
  const dbr = await one(`SELECT
    (SELECT COUNT(*) FROM shares s WHERE s.user_id=${u.id} AND s.revoked_at IS NULL) AS share_count,
    (SELECT COUNT(*) FROM publishes p WHERE p.user_id=${u.id} AND p.revoked_at IS NULL) AS publish_count,
    (SELECT COALESCE(SUM(v.doc_count),0) FROM user_vaults v WHERE v.user_id=${u.id}) AS doc_count,
    (SELECT COALESCE(SUM(v.bytes),0) FROM user_vaults v WHERE v.user_id=${u.id}) AS storage_bytes`);
  cmp(`  user#${u.id}.shareCount`, u.shareCount, dbr.share_count);
  cmp(`  user#${u.id}.publishCount`, u.publishCount, dbr.publish_count);
  cmp(`  user#${u.id}.documentCount`, u.documentCount, dbr.doc_count);
  cmp(`  user#${u.id}.storageBytes`, u.storageBytes, dbr.storage_bytes);
}

console.log('');
console.log('='.repeat(96));
console.log(`结果：通过 ${pass} 项，不一致 ${fails.length} 项`);
if (fails.length) {
  console.log('不一致明细：');
  for (const f of fails) console.log(`  - ${f}`);
}
console.log('='.repeat(96));

await closePool();
process.exitCode = fails.length === 0 ? 0 : 1;
