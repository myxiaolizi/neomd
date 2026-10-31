/**
 * B6 语法校验专项探针（对真实接口发请求，验证「后台不可能存进跑不起来的代码」）。
 *
 * 用法：node tools/re14-admin-b6-probe.mjs
 *      API_BASE=http://127.0.0.1:3200 node tools/re14-admin-b6-probe.mjs
 */
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');

const login = await fetch(`${API_BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: '6655' }),
}).then((r) => r.json());
const token = login.data.accessToken;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const pluginId = `b6probe-${Date.now()}`;
const cr = await fetch(`${API_BASE}/api/plugins`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    pluginId,
    name: 'B6 语法校验探针',
    version: '1.0.0',
    category: 'writing',
    description: 'B6 语法校验探针插件，测试结束即删除。',
    codeJs: 'export default { setup() {} };',
  }),
}).then((r) => r.json());
const id = cr?.data?.plugin?.id;
console.log(`临时插件 id=${id} pluginId=${pluginId}\n`);

const CASES = [
  ['合法代码', 'export default { setup(){} };', 200],
  ['括号不闭合', 'export default { name: "坏" ', 400],
  ['引号未闭合', 'export default { name: "a };', 400],
  ['function 缺右括号', 'function f( { return 1 } export default {};', 400],
  ['require()', 'const a = require("fs"); export default {};', 400],
  ['child_process', 'import cp from "child_process"; export default {};', 400],
  ['process.binding', 'process.binding("x"); export default {};', 400],
];

let pass = 0;
const fails = [];
for (const [label, code, expect] of CASES) {
  const res = await fetch(`${API_BASE}/api/admin/plugins/${id}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ codeJs: code }),
  });
  const json = await res.json().catch(() => null);
  const ok = res.status === expect;
  if (ok) pass += 1;
  else fails.push(`${label}: 期望 ${expect} 实际 ${res.status}`);
  const detail = res.status === 400 ? ` ← ${String(json?.error?.message ?? '').slice(0, 80)}` : '';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} HTTP ${res.status} (期望 ${expect})${detail}`);
}

// 清理
/*
 * DELETE 不能带 content-type: application/json 而 body 为空 ——
 * Fastify 的 JSON 解析器会直接回 400「请求体不是合法的 JSON」，导致删除静默失败、
 * 临时插件残留（本项目实测踩过）。只带 authorization 即可。
 */
const delHeaders = { authorization: `Bearer ${token}` };
const delRes = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(pluginId)}`, {
  method: 'DELETE',
  headers: delHeaders,
});
if (delRes.status >= 400) {
  console.log(`  删除失败 HTTP ${delRes.status}: ${JSON.stringify(await delRes.json().catch(() => null))}`);
}
const after = await fetch(`${API_BASE}/api/admin/plugins?page=1&pageSize=20&search=${encodeURIComponent(pluginId)}`, {
  headers: delHeaders,
}).then((r) => r.json());
const leftover = (after?.data?.items ?? []).length;
console.log(`\n清理：剩余 ${leftover} 条（应为 0）`);

console.log(`\n通过 ${pass} / ${CASES.length}，失败 ${fails.length}`);
for (const f of fails) console.log(`  - ${f}`);
process.exitCode = fails.length === 0 && leftover === 0 ? 0 : 1;
