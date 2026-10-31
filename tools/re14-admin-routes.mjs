/**
 * 后台 1.4.0 接口路由存在性 + 市场分页边界 —— 快速探针。
 *
 * 用途：QA 基线曾报告 batch / :id/status / :id/overview 返回 404，
 * 本脚本用真实请求逐条确认路由是否存在（区分「路由不存在 404」与「参数校验 400」）。
 *
 * 用法：node tools/re14-admin-routes.mjs
 */
const B = (process.env.API_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');

const login = await fetch(`${B}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: '6655' }),
}).then((r) => r.json());
const token = login.data.accessToken;
const H = { authorization: `Bearer ${token}` };
const Hj = { ...H, 'content-type': 'application/json' };

console.log('=== 路由存在性（404 才是缺失；400/200 都说明路由存在）===');
const probes = [
  ['POST', '/api/admin/users/batch', '{}'],
  ['PUT', '/api/admin/users/1/status', '{"status":"active"}'],
  ['GET', '/api/admin/users/1/overview', null],
  ['GET', '/api/admin/users/export', null],
  ['GET', '/api/admin/users/export.csv', null],
  ['GET', '/api/admin/users/1/logins', null],
  ['POST', '/api/admin/users/1/ban', '{"reason":"x"}'],
  ['POST', '/api/admin/users/1/unban', null],
  ['POST', '/api/admin/users/1/role', '{"role":"user"}'],
  ['GET', '/api/admin/releases', null],
  ['GET', '/api/admin/plugins/1', null],
  ['PUT', '/api/admin/plugins/1', '{}'],
];

let missing = 0;
for (const [m, p, body] of probes) {
  const r = await fetch(`${B}${p}`, { method: m, headers: body ? Hj : H, body: body ?? undefined });
  const is404 = r.status === 404;
  // 注意：/api/admin/users/1 若用户不存在也会 404，但那属于业务 404，不是路由缺失。
  // 这里用「响应体里有没有 route not found 语义」区分：我们只报告状态码供人工判读。
  if (is404) missing += 1;
  console.log(`  ${m.padEnd(4)} ${p.padEnd(36)} -> HTTP ${r.status}${is404 ? '   <<< 404' : ''}`);
}

console.log('\n=== 市场分页边界（需求3）===');
for (const [q, label] of [
  ['?page=1&pageSize=20', 'page=1（期望 20 条）'],
  ['?page=2&pageSize=20', 'page=2（期望 20 条）'],
  ['?page=3&pageSize=20', 'page=3（期望 13 条，53-40）'],
  ['?page=4&pageSize=20', 'page=4（期望 0 条 + hasMore=false）'],
  ['', '不传参（向后兼容：全量 53）'],
]) {
  const j = await fetch(`${B}/api/plugins/market${q}`).then((r) => r.json());
  const d = j.data;
  console.log(
    `  ${label.padEnd(30)} items=${String(d.items.length).padStart(2)}  total=${d.total}  page=${d.page}  hasMore=${d.hasMore}`,
  );
}

console.log(`\n404 路由数：${missing}`);
process.exitCode = missing === 0 ? 0 : 1;
