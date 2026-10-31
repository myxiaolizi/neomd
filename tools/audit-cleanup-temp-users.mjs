/**
 * A4 管理端审计 · 清理本轮审计产生的临时账号（只删明显的测试残留）。
 *
 * 本轮审计多次注册临时用户（前缀 perm_ / dgr_ / link1_ / vprobe_ / rc_），
 * 部分因脚本异常退出而未走到 finally。这里统一清扫，
 * **只匹配本审计使用的固定前缀**，绝不触碰真实账号。
 *
 * 用法：node tools/audit-cleanup-temp-users.mjs
 *      node tools/audit-cleanup-temp-users.mjs --dry-run
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const dryRun = process.argv.includes('--dry-run');

/** 本轮审计脚本使用过的用户名前缀（与真实账号 admin/my/tester01 无交集） */
const PREFIXES = ['perm_', 'dgr_', 'link1_', 'vprobe_', 'rc_', 'vg_'];

console.log('='.repeat(88));
console.log(dryRun ? '扫描（dry-run，不删除）' : '扫描并清理');
console.log('='.repeat(88));

const all = await query('SELECT id, username, email, role, created_at FROM users ORDER BY id');
console.log(`\n当前全部用户（${all.length} 个）：`);
const targets = [];
for (const u of all) {
  const hit = PREFIXES.some((p) => String(u.username).startsWith(p));
  if (hit) targets.push(u);
  console.log(`  ${hit ? '临时' : '保留'} id=${String(u.id).padStart(4)} ${String(u.username).padEnd(28)} ${String(u.email).padEnd(36)} role=${u.role}`);
}

// 安全断言：真实账号绝不能出现在待删列表
const REAL = ['admin', 'my', 'tester01'];
const danger = targets.filter((t) => REAL.includes(String(t.username)));
if (danger.length) {
  console.error(`\n❌ 安全检查失败：真实账号出现在待删列表（${danger.map((d) => d.username).join(',')}），中止`);
  await closePool();
  process.exit(1);
}

console.log(`\n待清理临时用户：${targets.length} 个`);
if (!targets.length) {
  console.log('  无需清理');
  await closePool();
  process.exit(0);
}

if (dryRun) {
  console.log('  （--dry-run，未执行删除）');
  await closePool();
  process.exit(0);
}

for (const t of targets) {
  /*
   * 先清关联数据再删用户。
   * 特别注意 credit_ledger —— 1.4.0 期间就是因为「只删 users 不删账本」，
   * 导致 /api/admin/ai-analytics 的 creditedUsers 统计出 26 个「已删除用户」（AUDIT-01）。
   */
  await execute('DELETE FROM credit_ledger WHERE user_id = ?', [t.id]).catch(() => {});
  await execute('DELETE FROM ai_usage WHERE user_id = ?', [t.id]).catch(() => {});
  await execute('DELETE FROM user_vaults WHERE user_id = ?', [t.id]).catch(() => {});
  await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [t.id]).catch(() => {});
  await execute('DELETE FROM user_settings WHERE user_id = ?', [t.id]).catch(() => {});
  await execute('UPDATE shares SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [t.id]).catch(() => {});
  await execute('UPDATE publishes SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [t.id]).catch(() => {});
  await execute('DELETE FROM users WHERE id = ?', [t.id]).catch(() => {});
  console.log(`  已删除 ${t.username} (id=${t.id})`);
}

console.log('');
console.log('='.repeat(88));
console.log('清理后核验');
console.log('='.repeat(88));
const after = await query('SELECT id, username FROM users ORDER BY id');
console.log(`  剩余用户：${after.length} 个`);
for (const u of after) console.log(`    id=${u.id} ${u.username}`);

const orphan = await query(
  `SELECT COUNT(*) AS n FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE u.id IS NULL`,
);
console.log(`  孤儿账本（user_id 无对应用户）：${orphan[0]?.n} 条`);

await closePool();
process.exitCode = 0;
