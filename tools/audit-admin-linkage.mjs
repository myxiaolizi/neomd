
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
 * A4 管理端审计 · 后台→用户端**联动**验证（核心补测，含写操作但全部自清理）。
 *
 * ## 为什么这是本次审计最重要的部分
 *
 * 1.4.0 的验收（re14-admin-verify.mjs）只验了「后台这一侧写成功」——
 * 返回 200、字段变了。但**没有验「用户端真的变了」**。一个后台接口可以完美返回 200，
 * 而用户端因为缓存/读的是另一份数据/权限过滤，完全没感觉到变化。
 *
 * 本脚本对四条链路做端到端验证：
 *   L1 后台改积分 → 用户端 /api/credits 余额是否同步
 *   L2 后台停用仓库 → 用户端 /api/vaults 是否立即不可用（读写被拒）
 *   L3 后台编辑插件 → 客户端市场 /api/plugins/market 是否立即可见
 *   L4 后台下架分享 → 分享公开链接是否失效
 *
 * ## 安全约束
 *
 * - 全部用**新建临时用户 / 临时插件 / 临时仓库 / 临时分享**，绝不碰 admin/tester01/my；
 * - finally 里清理（含 credit_ledger，避免重现 1.4.0 的孤儿账本问题）；
 * - 每一步都断言前后状态，失败也继续跑完以便拿到完整证据。
 *
 * 用法：node tools/audit-admin-linkage.mjs
 *      API_BASE=http://127.0.0.1:3211 node tools/audit-admin-linkage.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');

let adminToken = '';
async function adminLogin() {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
  }).then((x) => x.json());
  if (!r?.ok) throw new Error(`admin 登录失败: ${JSON.stringify(r).slice(0, 200)}`);
  adminToken = r.data.accessToken;
}

/** 通用请求：token 为空时不带鉴权头 */
async function call(method, p, { token = adminToken, body } = {}) {
  const res = await fetch(`${B}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  return { status: res.status, json, text };
}

let pass = 0;
const fails = [];
const results = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    fails.push(`${label}${extra ? `  [${extra}]` : ''}`);
    console.log(`  FAIL  ${label}${extra ? `  [${extra}]` : ''}`);
  }
  results.push({ label, ok: Boolean(cond), extra: extra ?? '' });
}
function section(t) {
  console.log(`\n${'='.repeat(88)}\n${t}\n${'='.repeat(88)}`);
}

await adminLogin();
const stamp = Date.now();
const cleanup = { users: [], plugins: [], shares: [] };

try {
  /* ================================================================ */
  /* L1: 后台改积分 → 用户端余额                                          */
  /* ================================================================ */
  section('L1 联动：后台改积分 → 用户端 /api/credits 余额');

  const l1email = `link1-${stamp}@neomd.local`;
  const l1name = `link1_${stamp}`;
  const reg = await call('POST', '/api/auth/register', {
    token: '',
    body: { email: l1email, username: l1name, password: 'LinkTest!2026' },
  });
  check(reg.status === 200 || reg.status === 201, 'L1.0 建临时用户', `HTTP ${reg.status}`);
  const l1id = reg.json?.data?.user?.id;
  if (l1id) cleanup.users.push(l1id);
  const userToken = reg.json?.data?.accessToken;

  // 用户端看到的初始余额
  const before = await call('GET', '/api/credits', { token: userToken });
  const beforeBal = Number(before.json?.data?.balance ?? -1);
  check(before.status === 200, 'L1.1 用户端可读自己的余额', `HTTP ${before.status} balance=${beforeBal}`);

  // 后台加 500 积分
  const adj = await call('PUT', `/api/admin/users/${l1id}/credits`, {
    body: { amount: 500, reason: 'A4 联动审计-L1' },
  });
  check(adj.status === 200, 'L1.2 后台调整积分成功', `HTTP ${adj.status}`);

  // 用户端**重新读**（关键：这里才是联动验证）
  const after = await call('GET', '/api/credits', { token: userToken });
  const afterBal = Number(after.json?.data?.balance ?? -1);
  check(afterBal === beforeBal + 500, 'L1.3 ★用户端余额同步 +500（联动成立）', `${beforeBal} → ${afterBal}`);

  // 用户端流水里能看到这笔
  const ledger = (after.json?.data?.ledger ?? []).filter((x) => Number(x.delta) === 500);
  check(ledger.length >= 1, 'L1.4 用户端流水能看到该笔 +500', `命中 ${ledger.length} 条`);

  // 扣回负数也要同步
  const adj2 = await call('PUT', `/api/admin/users/${l1id}/credits`, {
    body: { amount: -200, reason: 'A4 联动审计-L1-扣减' },
  });
  const after2 = await call('GET', '/api/credits', { token: userToken });
  const after2Bal = Number(after2.json?.data?.balance ?? -1);
  check(adj2.status === 200 && after2Bal === afterBal - 200, 'L1.5 ★扣减后用户端余额同步 -200', `${afterBal} → ${after2Bal}`);

  /* ================================================================ */
  /* L2: 后台停用仓库 → 用户端是否立即不可用                                */
  /* ================================================================ */
  section('L2 联动：后台停用仓库 → 用户端仓库与存储接口');

  const vaultId = `auditvault${stamp}`;
  const up = await call('POST', '/api/vaults', {
    token: userToken,
    body: { vaultId, name: 'A4审计临时仓库', docCount: 3, bytes: 1024 },
  });
  check(up.status === 200 || up.status === 201, 'L2.0 用户端建临时仓库', `HTTP ${up.status}`);

  const vaultListBefore = await call('GET', '/api/vaults', { token: userToken });
  const vb = (vaultListBefore.json?.data?.vaults ?? []).find((v) => v.vaultId === vaultId);
  check(Boolean(vb), 'L2.1 用户端能看到该仓库', `status=${vb?.status}`);
  const vaultRowId = vb?.id ?? null;

  // 后台停用（用 admin 接口按 id 停用）
  let disableStatus = 'not-run';
  if (vaultRowId) {
    const dis = await call('PUT', `/api/admin/vaults/${vaultRowId}`, { body: { status: 'disabled' } });
    disableStatus = `HTTP ${dis.status}`;
    check(dis.status === 200, 'L2.2 后台停用仓库成功', disableStatus);
  } else {
    // 列表里没带 id 时，回落到按 vaultId 找 DB 行
    const rows = await query('SELECT id FROM user_vaults WHERE vault_id = ? LIMIT 1', [vaultId]);
    if (rows[0]) {
      const dis = await call('PUT', `/api/admin/vaults/${rows[0].id}`, { body: { status: 'disabled' } });
      disableStatus = `HTTP ${dis.status}`;
      check(dis.status === 200, 'L2.2 后台停用仓库成功（经 DB 取 id）', disableStatus);
      cleanup.vaultRowId = rows[0].id;
    } else {
      check(false, 'L2.2 后台停用仓库', '找不到仓库行');
    }
  }

  // 用户端重新读：状态应为 disabled
  const vaultListAfter = await call('GET', '/api/vaults', { token: userToken });
  const va = (vaultListAfter.json?.data?.vaults ?? []).find((v) => v.vaultId === vaultId);
  check(va?.status === 'disabled', 'L2.3 ★用户端看到仓库已停用（状态联动）', `status=${va?.status}`);

  // 用户端对已停用仓库的存储读写是否被拒（这是「不可用」的实质）
  const storageProbe = await call('POST', '/api/storage/presign', {
    token: userToken,
    body: { vaultId, key: 'docs/audit-probe.md', contentType: 'text/markdown', size: 10 },
  });
  const blocked =
    storageProbe.status === 403 ||
    storageProbe.status === 409 ||
    /disabled|停用|不可用/i.test(String(storageProbe.json?.error?.message ?? ''));
  check(blocked, 'L2.4 ★停用后用户端存储接口被拒（实质不可用）', `HTTP ${storageProbe.status} ${storageProbe.json?.error?.message ?? ''}`);
  if (!blocked) {
    console.log(`        注意：停用后存储接口仍返回 HTTP ${storageProbe.status}，需人工判断该接口是否本应受 vault 状态约束`);
  }

  /* ================================================================ */
  /* L3: 后台编辑插件 → 客户端市场                                         */
  /* ================================================================ */
  section('L3 联动：后台编辑插件 → 客户端市场 /api/plugins/market');

  const pid = `linkaudit-${stamp}`;
  const origCode = `export default {\n  id: '${pid}',\n  name: '联动审计插件',\n  version: '1.0.0',\n  setup() {}\n};`;
  const cr = await call('POST', '/api/plugins', {
    body: {
      pluginId: pid,
      name: '联动审计插件',
      version: '1.0.0',
      category: 'writing',
      description: 'A4 联动审计临时插件，结束即删。',
      codeJs: origCode,
    },
  });
  check(cr.status === 200 || cr.status === 201, 'L3.0 建临时插件', `HTTP ${cr.status}`);
  const pluginRowId = cr.json?.data?.plugin?.id;
  if (pluginRowId) cleanup.plugins.push({ id: pluginRowId, pluginId: pid });

  const mk0 = await call('GET', `/api/plugins/market?search=${encodeURIComponent(pid)}`, { token: '' });
  const p0 = (mk0.json?.data?.items ?? [])[0];
  check(p0?.name === '联动审计插件', 'L3.1 客户端市场初始可见', p0?.name);

  const upd = await call('PUT', `/api/admin/plugins/${pluginRowId}`, {
    body: { name: '联动审计插件（后台已改）', version: '1.1.0', description: '这段描述由后台编辑，验证客户端市场立即可见。' },
  });
  check(upd.status === 200, 'L3.2 后台编辑插件成功', `HTTP ${upd.status}`);

  const mk1 = await call('GET', `/api/plugins/market?search=${encodeURIComponent(pid)}`, { token: '' });
  const p1 = (mk1.json?.data?.items ?? [])[0];
  check(p1?.name === '联动审计插件（后台已改）', 'L3.3 ★客户端市场立即可见新名称', p1?.name);
  check(p1?.version === '1.1.0', 'L3.4 ★客户端市场立即可见新版本', p1?.version);
  check(String(p1?.description ?? '').includes('后台编辑'), 'L3.5 ★客户端市场立即可见新描述');

  // 下架 → 市场应消失
  const off = await call('PUT', `/api/admin/plugins/${pluginRowId}/status`, { body: { status: 'disabled' } });
  check(off.status === 200, 'L3.6 后台下架插件成功', `HTTP ${off.status}`);
  const mk2 = await call('GET', `/api/plugins/market?search=${encodeURIComponent(pid)}`, { token: '' });
  check((mk2.json?.data?.items ?? []).length === 0, 'L3.7 ★下架后客户端市场不再出现（联动成立）', `剩余 ${(mk2.json?.data?.items ?? []).length} 条`);

  /* ================================================================ */
  /* L4: 后台下架分享 → 公开链接失效                                       */
  /* ================================================================ */
  section('L4 联动：后台下架分享 → 公开分享链接是否失效');

  const sh = await call('POST', '/api/shares', {
    token: userToken,
    body: {
      docId: `auditdoc${stamp}`,
      title: 'A4 联动审计分享',
      markdown: '# 联动审计\n\n这是临时分享内容。',
      mode: 'read',
      allowComment: false,
    },
  });
  check(sh.status === 200 || sh.status === 201, 'L4.0 用户端创建分享', `HTTP ${sh.status}`);
  const shareToken = sh.json?.data?.token;
  if (shareToken) cleanup.shares.push(shareToken);

  const pub0 = await call('GET', `/api/public/shares/${encodeURIComponent(shareToken)}`, { token: '' });
  check(pub0.status === 200, 'L4.1 公开链接初始可访问', `HTTP ${pub0.status}`);

  // 找到分享 id 后用后台接口撤销
  const shList = await call('GET', '/api/admin/shares?page=1&pageSize=50&search=' + encodeURIComponent('A4 联动审计'), {});
  const shRow = (shList.json?.data?.items ?? [])[0];
  check(Boolean(shRow?.id), 'L4.2 后台分享列表能找到该分享', `id=${shRow?.id}`);

  if (shRow?.id) {
    const rev = await call('DELETE', `/api/admin/shares/${shRow.id}`, {});
    check(rev.status === 200, 'L4.3 后台撤销分享成功', `HTTP ${rev.status}`);
    const pub1 = await call('GET', `/api/public/shares/${encodeURIComponent(shareToken)}`, { token: '' });
    check(pub1.status === 404 || pub1.status === 410, 'L4.4 ★撤销后公开链接失效（联动成立）', `HTTP ${pub1.status}`);
  }

  /* ================================================================ */
  /* L5: 后台改角色 → 用户端管理员权限是否即时生效                            */
  /* ================================================================ */
  section('L5 联动：后台改角色 → 用户端 /api/admin 权限是否即时生效');

  const adminProbeBefore = await call('GET', '/api/admin/stats', { token: userToken });
  check(adminProbeBefore.status === 403 || adminProbeBefore.status === 401, 'L5.1 普通用户访问后台接口被拒', `HTTP ${adminProbeBefore.status}`);

  const roleUp = await call('POST', `/api/admin/users/${l1id}/role`, { body: { role: 'admin' } });
  check(roleUp.status === 200, 'L5.2 后台提升为管理员', `HTTP ${roleUp.status}`);

  /*
   * 关键观察点：用户端拿着**旧 token** 再打后台接口。
   * 若服务端按 token 里的 role 判定 → 仍是 403（改动不生效，需重新登录）；
   * 若按数据库实时查 → 200（即时生效）。
   * 两种都算合理设计，但必须记录实际行为，因为这决定「提权后要不要重新登录」。
   */
  const adminProbeAfter = await call('GET', '/api/admin/stats', { token: userToken });
  console.log(`        提权后旧 token 访问后台：HTTP ${adminProbeAfter.status}`);
  check(
    adminProbeAfter.status === 200 || adminProbeAfter.status === 403,
    'L5.3 提权后旧 token 行为已记录（200=实时生效 / 403=需重新登录）',
    `HTTP ${adminProbeAfter.status}`,
  );

  // 降回普通用户
  const roleDown = await call('POST', `/api/admin/users/${l1id}/role`, { body: { role: 'user' } });
  check(roleDown.status === 200, 'L5.4 降回普通用户', `HTTP ${roleDown.status}`);
} finally {
  /* ============================ 清理 ============================ */
  section('清理（删除全部临时数据，含 credit_ledger 以免重现孤儿账本）');

  for (const u of cleanup.users) {
    // 先清账本再删用户 —— 1.4.0 的经验：DELETE users 不会级联删 credit_ledger
    await execute('DELETE FROM credit_ledger WHERE user_id = ?', [u]).catch(() => {});
    await execute('DELETE FROM ai_usage WHERE user_id = ?', [u]).catch(() => {});
    await execute('UPDATE shares SET revoked_at = NOW() WHERE user_id = ?', [u]).catch(() => {});
    await execute('UPDATE publishes SET revoked_at = NOW() WHERE user_id = ?', [u]).catch(() => {});
    await execute('DELETE FROM user_vaults WHERE user_id = ?', [u]).catch(() => {});
    await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [u]).catch(() => {});
    await execute('DELETE FROM user_settings WHERE user_id = ?', [u]).catch(() => {});
    const r = await call('DELETE', `/api/admin/users/${u}`, {});
    console.log(`  删除临时用户 #${u} → HTTP ${r.status}`);
  }
  for (const p of cleanup.plugins) {
    const r = await call('DELETE', `/api/plugins/${encodeURIComponent(p.pluginId)}`, {});
    console.log(`  删除临时插件 ${p.pluginId} → HTTP ${r.status}`);
  }
  if (cleanup.vaultRowId) {
    await execute('DELETE FROM user_vaults WHERE id = ?', [cleanup.vaultRowId]).catch(() => {});
  }

  // 验证清理彻底
  const leftUsers = await query('SELECT COUNT(*) AS n FROM users WHERE username LIKE ?', [`link1_${stamp}`]);
  const leftPlugins = await query('SELECT COUNT(*) AS n FROM community_plugins WHERE plugin_id LIKE ?', [`linkaudit-${stamp}`]);
  const leftOrphan = await query(
    `SELECT COUNT(*) AS n FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE u.id IS NULL AND l.user_id >= ?`,
    [cleanup.users[0] ?? 0],
  );
  check(Number(leftUsers[0]?.n) === 0, '清理：临时用户已删除', `剩余 ${leftUsers[0]?.n}`);
  check(Number(leftPlugins[0]?.n) === 0, '清理：临时插件已删除', `剩余 ${leftPlugins[0]?.n}`);
  check(Number(leftOrphan[0]?.n) === 0, '清理：本次未产生孤儿账本', `剩余 ${leftOrphan[0]?.n}`);

  // 真实账号未被触碰
  const real = await query('SELECT id, username, status, role FROM users WHERE username IN (?,?,?) ORDER BY id', ['admin', 'tester01', 'my']);
  check(real.length === 3, '真实账号 admin/tester01/my 均存在', real.map((x) => `${x.username}:${x.status}/${x.role}`).join(', '));
}

section(`结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log(`  - ${f}`);
}
await closePool();
process.exitCode = fails.length === 0 ? 0 : 1;
