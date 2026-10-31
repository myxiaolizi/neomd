
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
 * A4 管理端审计 · AI 运营分析 / 转化率口径核查（只读）。
 *
 * 背景：/api/admin/ai-analytics 的 `conversion.creditedUsers` 实测返回 26，
 * 而全库只有 3 个用户 —— 明显超界。本脚本定位它的计算口径与真实数据分布，
 * 判断这是「口径错误」还是「僵尸数据」。
 *
 * 用法：node tools/audit-analytics-conversion.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const login = await fetch(`${B}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
}).then((r) => r.json());
const H = { authorization: `Bearer ${login.data.accessToken}` };

console.log('='.repeat(90));
console.log('1. 接口返回的 conversion');
console.log('='.repeat(90));
const ai = await fetch(`${B}/api/admin/ai-analytics?days=7`, { headers: H }).then((r) => r.json());
console.log(JSON.stringify(ai.data.conversion, null, 2));

console.log('');
console.log('='.repeat(90));
console.log('2. 按接口那条 SQL 的口径直接查库');
console.log('='.repeat(90));
const sql = `SELECT
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind IN ('recharge','grant')) AS credited,
  (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind = 'recharge') AS paying
`;
const [row] = await query(sql);
console.log('SQL:', sql.replace(/\s+/g, ' ').trim());
console.log('结果:', JSON.stringify(row));

console.log('');
console.log('='.repeat(90));
console.log('3. credit_ledger 里到底有哪些 user_id（是否含已删除用户）');
console.log('='.repeat(90));
const perUser = await query(
  `SELECT l.user_id, u.username, u.status,
          COUNT(*) AS entries,
          SUM(CASE WHEN l.kind IN ('recharge','grant') THEN 1 ELSE 0 END) AS credit_entries
   FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id
   GROUP BY l.user_id, u.username, u.status
   ORDER BY l.user_id`,
);
console.log('user_id | username | status | entries | credit_entries');
for (const x of perUser) {
  console.log(`  ${String(x.user_id).padStart(4)} | ${String(x.username ?? '(已删除)').padEnd(16)} | ${String(x.status ?? '-').padEnd(8)} | ${String(x.entries).padStart(5)} | ${String(x.credit_entries).padStart(5)}`);
}

console.log('');
console.log('='.repeat(90));
console.log('4. 孤儿账本（user_id 在 users 表里不存在）');
console.log('='.repeat(90));
const orphan = await query(
  `SELECT l.user_id, COUNT(*) AS entries, MIN(l.created_at) AS first_at, MAX(l.created_at) AS last_at
   FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id
   WHERE u.id IS NULL GROUP BY l.user_id ORDER BY l.user_id`,
);
if (!orphan.length) console.log('  无孤儿账本');
else for (const o of orphan) console.log(`  user_id=${o.user_id}  ${o.entries} 条  首次=${o.first_at}  末次=${o.last_at}`);

console.log('');
console.log('='.repeat(90));
console.log('5. 判定');
console.log('='.repeat(90));
const totalUsers = Number(row.users);
const credited = Number(row.credited);
if (credited > totalUsers) {
  console.log(`  ❌ 口径缺陷确认：creditedUsers=${credited} > 全库用户数=${totalUsers}`);
  console.log('     根因：COUNT(DISTINCT user_id) FROM credit_ledger 统计的是「账本里出现过的 user_id」，');
  console.log('     而这些 user_id 中包含已被删除的测试账号（credit_ledger 没有外键级联删除）。');
  console.log('     正确口径应为「现存的、有充值/赠送记录的用户数」，需 JOIN users 过滤。');
  console.log(`     影响：转化率 = payingUsers/creditedUsers 被稀释（当前 ${credited} 当分母）。`);
} else {
  console.log(`  ✅ 口径正常：creditedUsers=${credited} <= 全库用户数=${totalUsers}`);
}

await closePool();
process.exitCode = 0;
