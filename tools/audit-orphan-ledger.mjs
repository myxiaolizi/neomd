/**
 * A4 管理端审计 · 孤儿账本溯源（只读）。
 *
 * 目的：确认 credit_ledger 里的「user_id 对应用户已不存在」的记录来自哪里、
 * 有多少是本轮 1.4.0 验收脚本产生的（诚实说明自己造成的污染）。
 *
 * 用法：node tools/audit-orphan-ledger.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

console.log('='.repeat(88));
console.log('1. 孤儿账本按 user_id 明细与来源分类');
console.log('='.repeat(88));
const rows = await query(
  `SELECT l.user_id, COUNT(*) AS n, MIN(l.created_at) AS t0, MAX(l.created_at) AS t1,
          GROUP_CONCAT(DISTINCT l.kind) AS kinds
   FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id
   WHERE u.id IS NULL
   GROUP BY l.user_id ORDER BY l.user_id`,
);

/** 本轮 1.4.0（我）的验收脚本创建又删除的临时用户 id 区间 */
const MINE_MIN = 11;
const MINE_MAX = 31;

let mineEntries = 0;
let otherEntries = 0;
const mineIds = [];
const otherIds = [];
for (const r of rows) {
  const id = Number(r.user_id);
  const isMine = id >= MINE_MIN && id <= MINE_MAX;
  if (isMine) {
    mineEntries += Number(r.n);
    mineIds.push(id);
  } else {
    otherEntries += Number(r.n);
    otherIds.push(id);
  }
  console.log(
    `  user_id=${String(id).padStart(3)}  条数=${String(r.n).padStart(2)}  ` +
      `${r.t0} → ${r.t1}  kinds=${r.kinds}  ${isMine ? '<<< 1.4.0 验收脚本残留（我）' : '（更早，他人/历史）'}`,
  );
}

console.log('');
console.log(`  我的 1.4.0 验收残留：${mineEntries} 条，user_id=[${mineIds.join(',')}]`);
console.log(`  其他历史孤儿：${otherEntries} 条，user_id=[${otherIds.join(',')}]`);

console.log('');
console.log('='.repeat(88));
console.log('2. 现存用户');
console.log('='.repeat(88));
const users = await query('SELECT id, username, email, credits FROM users ORDER BY id');
for (const u of users) console.log(`  id=${u.id}  ${String(u.username).padEnd(12)} ${String(u.email).padEnd(24)} credits=${u.credits}`);

console.log('');
console.log('='.repeat(88));
console.log('3. 该缺陷对指标的实际影响');
console.log('='.repeat(88));
const [a] = await query(
  `SELECT
     (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind IN ('recharge','grant')) AS credited_buggy,
     (SELECT COUNT(DISTINCT l.user_id) FROM credit_ledger l JOIN users u ON u.id = l.user_id
        WHERE l.kind IN ('recharge','grant')) AS credited_correct,
     (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind = 'recharge') AS paying_buggy,
     (SELECT COUNT(DISTINCT l.user_id) FROM credit_ledger l JOIN users u ON u.id = l.user_id
        WHERE l.kind = 'recharge') AS paying_correct,
     (SELECT COUNT(*) FROM users) AS total_users`,
);
console.log(`  creditedUsers（当前实现，含孤儿） : ${a.credited_buggy}`);
console.log(`  creditedUsers（JOIN users 正确值）: ${a.credited_correct}`);
console.log(`  payingUsers（当前实现）           : ${a.paying_buggy}`);
console.log(`  payingUsers（JOIN users 正确值）  : ${a.paying_correct}`);
console.log(`  全库真实用户数                    : ${a.total_users}`);
console.log('');
const buggyRate = Number(a.credited_buggy) > 0 ? Number(a.paying_buggy) / Number(a.credited_buggy) : 0;
const correctRate = Number(a.credited_correct) > 0 ? Number(a.paying_correct) / Number(a.credited_correct) : 0;
console.log(`  conversion.rate 当前实现: ${buggyRate}`);
console.log(`  conversion.rate 正确实现: ${correctRate}`);
console.log('');
console.log('  ❌ 缺陷确认：creditedUsers 统计了「账本里出现过的 user_id」，未 JOIN users 过滤已删除账号。');
console.log('     分子 payingUsers 同样有此问题（只是当前恰好为 0 才没暴露）。');
console.log('     这是统计口径缺陷，会让运营看到一个超过全库用户数的「已充值用户数」（26 > 3）。');
console.log('     修复方向：两处 COUNT(DISTINCT ...) 都应 JOIN users u ON u.id = l.user_id。');

await closePool();
process.exitCode = 0;
