/**
 * B06 复核：插件代码编辑的语法校验是否**真的**生效。
 *
 * ## 为什么要单独复核
 *
 * QA 门禁 B06 报「合法 PUT 200、非法 PUT 也 200」，而 T2 组自测报「7/7 全过」。
 * 两边结论相反，必须用**直接 HTTP 调用**判定，不能只信任一侧。
 *
 * ## 判据
 *
 * 对同一个插件连续 PUT 三种 codeJs：
 *   - 合法                       → 期望 200
 *   - 括号不闭合                 → 期望 4xx
 *   - `export default { = }`     → 期望 4xx
 *
 * 全部用 `codeJs` 字段（不是 `code`），与前端编辑弹窗一致。
 * 结束时把合法原文写回，不残留测试数据。
 */
const API = process.env.RE14_API || 'http://127.0.0.1:3200';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

async function main() {
  const lr = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  const lj = await lr.json();
  const tk = lj?.data?.accessToken ?? lj?.data?.access;
  if (!tk) {
    console.log('登录失败', JSON.stringify(lj).slice(0, 200));
    process.exit(2);
  }
  const auth = { authorization: `Bearer ${tk}`, 'content-type': 'application/json' };

  const mr = await fetch(`${API}/api/admin/plugins?page=1&pageSize=3`, { headers: auth });
  const mj = await mr.json();
  const items = mj?.data?.items ?? mj?.data?.plugins ?? [];
  if (!items.length) {
    console.log('没有可测插件');
    process.exit(2);
  }
  const target = items[0];
  console.log('目标插件:', target.id, target.pluginId, target.name);

  // 取原始 codeJs 以便还原
  const gr = await fetch(`${API}/api/admin/plugins/${target.id}`, { headers: auth });
  const gj = await gr.json();
  const original = gj?.data?.plugin?.codeJs ?? gj?.data?.codeJs ?? '';
  console.log('原始 codeJs 长度:', String(original).length);

  const GOOD = 'export default { id: "b06-probe", name: "B06 探针", version: "1.0.0", setup() {} };';
  const cases = [
    ['合法', GOOD, [200]],
    ['括号不闭合', 'export default { id: "b06-probe", name: ', [400, 422]],
    ['非法表达式', 'export default { = };', [400, 422]],
    ['require 黑名单', 'const fs = require("fs"); export default { id: "x", name: "x", setup(){} };', [400, 422]],
  ];

  let fail = 0;
  for (const [label, code, expect] of cases) {
    const r = await fetch(`${API}/api/admin/plugins/${target.id}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ codeJs: code }),
    });
    const body = await r.text();
    const ok = expect.includes(r.status);
    if (!ok) fail += 1;
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${label.padEnd(12)} status=${r.status}（期望 ${expect.join('/')}）  ${body.slice(0, 100).replace(/\s+/g, ' ')}`);
  }

  // 还原
  if (original) {
    const rr = await fetch(`${API}/api/admin/plugins/${target.id}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ codeJs: original }),
    });
    console.log('还原原始 codeJs:', rr.status);
  }

  console.log(fail ? `\nB06 复核失败：${fail} 项不符` : '\nB06 复核通过：语法校验确实生效');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
