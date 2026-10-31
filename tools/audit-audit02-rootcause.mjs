
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
 * A4 管理端审计 · AUDIT-02 根因取证（只读，纯静态 + 运行时双证）。
 *
 * 缺陷：`POST /api/storage/presign` 用 zod `parse()` 校验请求体，但
 * `presignSchema` **没有声明 vaultId**，zod 默认会**丢弃未声明字段**（strip）。
 * 于是 `resolveScope(req, body)` 里的 `readVaultId(req, body)` 看到 body.vaultId 为 undefined，
 * 落入「老客户端不带 vaultId」的兼容分支 → 返回 legacy 前缀 → **完全绕过仓库停用判定**。
 *
 * 本脚本用三份证据固定结论：
 *   证据1（静态）：presignSchema 字段清单，确认无 vaultId
 *   证据2（静态）：resolveScope → readVaultId 的取值顺序，确认 body 是唯一来源
 *   证据3（运行时）：同一个 disabled 仓库，body 传 vaultId 时返回 x-vault-legacy:1
 *
 * 用法：node tools/audit-audit02-rootcause.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const storageJs = path.join(apiRoot, 'src', 'routes', 'storage.js');
const vaultScopeJs = path.join(apiRoot, 'src', 'lib', 'vault-scope.js');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');

console.log('='.repeat(92));
console.log('证据 1（静态）：presignSchema 声明的字段');
console.log('='.repeat(92));
const storageSrc = fs.readFileSync(storageJs, 'utf8');
const schemaMatch = /const presignSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(storageSrc);
if (!schemaMatch) {
  console.log('  ⚠ 未能定位 presignSchema');
} else {
  const body = schemaMatch[1];
  const fields = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  console.log(`  声明字段：${fields.join(', ')}`);
  console.log(`  是否包含 vaultId：${fields.includes('vaultId') ? '是' : '否  ← 缺陷根因'}`);
  console.log('');
  console.log('  源码：');
  for (const line of body.split(/\r?\n/)) if (line.trim()) console.log(`    ${line.trim()}`);
}
const presignLine = storageSrc.split(/\r?\n/).findIndex((l) => /const presignSchema = z\.object/.test(l)) + 1;
console.log(`\n  位置：services/api/src/routes/storage.js:${presignLine}`);

console.log('');
console.log('='.repeat(92));
console.log('证据 2（静态）：readVaultId 的取值顺序 —— body 是唯一能承载 vaultId 的位置');
console.log('='.repeat(92));
const scopeSrc = fs.readFileSync(vaultScopeJs, 'utf8');
const readVaultIdLine = scopeSrc.split(/\r?\n/).findIndex((l) => /export function readVaultId/.test(l)) + 1;
const fnMatch = /export function readVaultId\(req, body\) \{([\s\S]*?)\n\}/.exec(scopeSrc);
if (fnMatch) {
  const lines = fnMatch[1].split(/\r?\n/).filter((l) => l.trim());
  for (const l of lines) console.log(`    ${l.trim()}`);
  console.log(`\n  位置：services/api/src/lib/vault-scope.js:${readVaultIdLine}`);
  console.log(`  结论：header/query 都没有时，唯一来源是 body.vaultId —— 而它已被 zod 剥掉。`);
}

console.log('');
console.log('='.repeat(92));
console.log('证据 3（运行时）：disabled 仓库 + body 传 vaultId → 是否仍走 legacy');
console.log('='.repeat(92));

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
  const reg = await call('POST', '/api/auth/register', {
    token: '',
    body: { email: `rc-${stamp}@neomd.local`, username: `rc_${stamp}`, password: 'RootCause!2026' },
  });
  const userToken = reg.json?.data?.accessToken;
  userId = reg.json?.data?.user?.id;

  const vaultId = `rc${stamp}`;
  await call('POST', '/api/vaults', { token: userToken, body: { vaultId, name: '根因取证仓库', docCount: 0, bytes: 0 } });
  const row = (await query('SELECT id FROM user_vaults WHERE user_id = ? AND vault_id = ? LIMIT 1', [userId, vaultId]))[0];
  await call('PUT', `/api/admin/vaults/${row.id}`, { token: adminToken, body: { status: 'disabled' } });
  const st = (await query('SELECT status FROM user_vaults WHERE id = ? LIMIT 1', [row.id]))[0];
  console.log(`  仓库 ${vaultId} 状态已置为：${st?.status}`);

  // 形态 A：body 传 vaultId（客户端 SDK 的常见写法）
  const a = await call('POST', '/api/storage/presign', {
    token: userToken,
    body: { vaultId, key: 'docs/x.md', method: 'PUT', contentType: 'text/markdown' },
  });
  console.log('');
  console.log(`  A. body 传 vaultId      → HTTP ${a.status}`);
  console.log(`     x-vault-legacy 响应头：${a.headers.get('x-vault-legacy') ?? '(无)'}`);
  console.log(`     返回的 key：${a.json?.data?.key ?? '-'}`);
  console.log(`     判定：${a.status === 200 && a.headers.get('x-vault-legacy') === '1' ? '❌ 静默降级为 legacy，绕过停用判定' : '✓ 已拒绝'}`);

  // 形态 B：header 传（绕过 schema strip）
  const b = await call('POST', '/api/storage/presign', {
    token: userToken,
    headers: { 'x-vault-id': vaultId },
    body: { key: 'docs/x.md', method: 'PUT', contentType: 'text/markdown' },
  });
  console.log('');
  console.log(`  B. header x-vault-id    → HTTP ${b.status}  code=${b.json?.error?.code ?? '-'}`);
  console.log(`     判定：${b.status === 403 ? '✓ 被 VAULT_DISABLED 正确拒绝' : '❌ 未拒绝'}`);

  console.log('');
  console.log('  对比结论：同一仓库、同一用户、同一时刻，只因 vaultId 的**投递位置**不同，');
  console.log('  得到的授权结果相反 —— 证明 body 路径上的 vaultId 确实被丢弃了。');
} finally {
  if (userId) {
    await execute('DELETE FROM credit_ledger WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_vaults WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_settings WHERE user_id = ?', [userId]).catch(() => {});
    await call('DELETE', `/api/admin/users/${userId}`, { token: adminToken });
    const left = await query('SELECT COUNT(*) AS n FROM users WHERE username = ?', [`rc_${stamp}`]);
    console.log('');
    console.log(`  清理：临时用户已删除，剩余 ${left[0]?.n}`);
  }
}

console.log('');
console.log('='.repeat(92));
console.log('修复建议（供开发组参考，审计员不落盘）');
console.log('='.repeat(92));
console.log('  在 presignSchema 中补上 vaultId:');
console.log("    vaultId: z.string().trim().max(64).optional(),");
console.log('  或更稳妥：把 vaultId 从 schema 里显式 passthrough（z.object({...}).passthrough()），');
console.log('  但更推荐逐接口显式声明，避免其它未声明字段也被意外透传。');
console.log('  同时建议排查 storage.js 其它用 parse() 后传给 resolveScope 的路由，确认是否有同类遗漏。');

await closePool();
process.exitCode = 0;
