
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
 * A4 管理端审计 · L2.4 复核：仓库停用后存储接口是否真的被拒（只读探测，自清理）。
 *
 * ## 为什么单独复核
 *
 * 第一轮 audit-admin-linkage.mjs 里 L2.4 返回 200（未拒绝），但我不确定是
 * 「真漏洞」还是「我的探测 payload 没带对字段，走了 legacy 兼容分支」。
 * 审计结论不能建立在不确定的探测上，因此这里用**三种请求形态**分别验证：
 *
 *   A. body.vaultId（我第一轮用的）
 *   B. header x-vault-id（客户端实际发的方式）
 *   C. query ?vaultId=
 *
 * 并用「仓库在 DB 里确实是 disabled」作为前置断言，确保测的是正确对象。
 * 另外对比「同一仓库停用前」的行为，形成前后对照。
 *
 * 用法：node tools/audit-vault-disabled-probe.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');

const adminLogin = await fetch(`${B}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
}).then((r) => r.json());
const adminToken = adminLogin.data.accessToken;

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${B}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

const stamp = Date.now();
let userId = null;

try {
  console.log('='.repeat(90));
  console.log('0. 准备：建临时用户 + 临时仓库');
  console.log('='.repeat(90));
  const reg = await call('POST', '/api/auth/register', {
    token: '',
    body: { email: `vprobe-${stamp}@neomd.local`, username: `vprobe_${stamp}`, password: 'VProbe!2026' },
  });
  const userToken = reg.json?.data?.accessToken;
  userId = reg.json?.data?.user?.id;
  console.log(`  用户 #${userId}`);

  const vaultId = `vprobe${stamp}`;
  const mk = await call('POST', '/api/vaults', {
    token: userToken,
    body: { vaultId, name: 'A4 停用探测仓库', docCount: 1, bytes: 128 },
  });
  console.log(`  建仓库 ${vaultId} → HTTP ${mk.status}`);

  const row = (await query('SELECT id, status FROM user_vaults WHERE user_id = ? AND vault_id = ? LIMIT 1', [userId, vaultId]))[0];
  console.log(`  DB 行：id=${row?.id} status=${row?.status}`);

  /* ---------------- 停用前基线 ---------------- */
  console.log('');
  console.log('='.repeat(90));
  console.log('1. 停用前（基线）：应该全部放行');
  console.log('='.repeat(90));
  const before = await call('POST', '/api/storage/presign', {
    token: userToken,
    body: { vaultId, key: 'docs/probe.md', contentType: 'text/markdown', size: 10 },
  });
  console.log(`  POST /api/storage/presign {vaultId} → HTTP ${before.status}`);
  const vaultListBefore = await call('GET', '/api/vaults', { token: userToken });
  console.log(`  GET /api/vaults → status=${(vaultListBefore.json?.data?.vaults ?? []).find((v) => v.vaultId === vaultId)?.status}`);

  /* ---------------- 停用 ---------------- */
  console.log('');
  console.log('='.repeat(90));
  console.log('2. 后台停用该仓库');
  console.log('='.repeat(90));
  const dis = await call('PUT', `/api/admin/vaults/${row.id}`, { token: adminToken, body: { status: 'disabled' } });
  console.log(`  PUT /api/admin/vaults/${row.id} {status:disabled} → HTTP ${dis.status}`);
  const afterRow = (await query('SELECT status FROM user_vaults WHERE id = ? LIMIT 1', [row.id]))[0];
  console.log(`  DB 复核：status=${afterRow?.status}`);
  const disabledConfirmed = afterRow?.status === 'disabled';
  console.log(`  前置断言「DB 里确实已 disabled」：${disabledConfirmed ? 'PASS' : 'FAIL'}`);

  /* ---------------- 停用后三种形态 ---------------- */
  console.log('');
  console.log('='.repeat(90));
  console.log('3. 停用后：三种请求形态分别探测');
  console.log('='.repeat(90));

  const probes = [
    ['A. body.vaultId', () => call('POST', '/api/storage/presign', { token: userToken, body: { vaultId, key: 'docs/probe.md', contentType: 'text/markdown', size: 10 } })],
    ['B. header x-vault-id', () => call('POST', '/api/storage/presign', { token: userToken, headers: { 'x-vault-id': vaultId }, body: { key: 'docs/probe.md', contentType: 'text/markdown', size: 10 } })],
    ['C. query ?vaultId=', () => call('POST', `/api/storage/presign?vaultId=${encodeURIComponent(vaultId)}`, { token: userToken, body: { key: 'docs/probe.md', contentType: 'text/markdown', size: 10 } })],
  ];

  const out = [];
  for (const [label, fn] of probes) {
    const r = await fn();
    const blocked = r.status === 403;
    const code = r.json?.error?.code ?? '';
    const legacy = r.headers.get('x-vault-legacy');
    console.log(`  ${label.padEnd(22)} → HTTP ${r.status}  code=${code || '-'}  x-vault-legacy=${legacy ?? '-'}  ${blocked ? '已拒绝 ✓' : '未拒绝 ✗'}`);
    out.push({ label, status: r.status, code, legacy, blocked });
  }

  // 读接口也要测
  console.log('');
  const readProbe = await call('GET', `/api/storage/object?key=docs%2Fprobe.md&vaultId=${encodeURIComponent(vaultId)}`, { token: userToken });
  console.log(`  GET /api/storage/object?vaultId= → HTTP ${readProbe.status} code=${readProbe.json?.error?.code ?? '-'}`);

  /* ---------------- 判定 ---------------- */
  console.log('');
  console.log('='.repeat(90));
  console.log('4. 判定');
  console.log('='.repeat(90));
  const allBlocked = out.every((x) => x.blocked);
  const anyLegacy = out.some((x) => x.legacy === '1');
  if (!disabledConfirmed) {
    console.log('  ⚠ 前置条件不成立（DB 未 disabled），本结论无效');
  } else if (allBlocked) {
    console.log('  ✅ 停用生效：三种形态都被 403 拒绝。第一轮 L2.4 的 200 是探测方式问题，非产品缺陷。');
  } else if (anyLegacy) {
    console.log('  ❌ 缺陷：停用后仍有形态返回非 403，且响应带 x-vault-legacy:1');
    console.log('     → 说明请求走了「老客户端不带 vaultId」的兼容分支，绕过了仓库停用判定。');
    console.log('     → 这是真实的安全绕过：客户端只要不带 vaultId，就能继续读写已停用仓库的数据。');
  } else {
    console.log('  ❌ 缺陷：停用后仍有形态返回非 403（需看具体形态）');
    for (const x of out.filter((y) => !y.blocked)) console.log(`     - ${x.label} → HTTP ${x.status}`);
  }
} finally {
  console.log('');
  console.log('='.repeat(90));
  console.log('5. 清理');
  console.log('='.repeat(90));
  if (userId) {
    await execute('DELETE FROM credit_ledger WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_vaults WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_settings WHERE user_id = ?', [userId]).catch(() => {});
    const d = await call('DELETE', `/api/admin/users/${userId}`, { token: adminToken });
    console.log(`  删除临时用户 #${userId} → HTTP ${d.status}`);
    const left = await query('SELECT COUNT(*) AS n FROM users WHERE username = ?', [`vprobe_${stamp}`]);
    const leftV = await query('SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?', [userId]);
    console.log(`  复核：users 剩余 ${left[0]?.n}，user_vaults 剩余 ${leftV[0]?.n}`);
  }
}

await closePool();
process.exitCode = 0;
