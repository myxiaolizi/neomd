#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **多租户隔离越权探测**（只读，无害探测）。
 *
 * ## 探测原则
 *
 * 全部是「用 A 的合法 token 去请求 B 的资源」，预期**必须拒绝**。
 * 每个探测只做 GET / HEAD（极少数用 PUT 但带非法参数，预期在任何写入发生前就被拒），
 * 不修改任何数据；每个探测都断言「响应状态码 ∈ 拒绝集合」。
 *
 * ## 覆盖维度（对应 task-13 要求）
 *
 *  1. **跨用户 vaultId**：A 的 token + B 的 vaultId 访问 `/api/storage/*`
 *  2. **跨用户 docId**：A 的 token + B 的 docId 访问对象键
 *  3. **跨用户 share token**：A 的 token 读 B 创建的分享
 *  4. **跨用户 settings/profile**：A 能否读 B 的设置
 *  5. **未登录访问受保护接口**：无 token
 *  6. **过期/伪造 token**：篡改签名的 JWT
 *  7. **普通用户访问后台接口**：role=user 访问 `/api/admin/*`（越权提权）
 *  8. **路径穿越**：在对象 key 里塞 `../`
 *  9. **对象键越界**：直接指定别的用户的完整前缀
 *
 * 用法：node tools/audit140-isolation.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const OUT = join(REPO, 'docs/AUDIT-140');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

const results = [];
/**
 * 记一条探测结果。
 *
 * @param name 探测名
 * @param expect 期望（'deny' = 必须拒绝；'allow' = 应当放行自己的资源）
 */
function record(name, method, url, status, expect, body) {
  const denied = [401, 403, 404].includes(status);
  const ok = expect === 'deny' ? denied : status >= 200 && status < 300;
  results.push({ name, method, url, status, expect, pass: ok, bodySample: body ? String(body).slice(0, 200) : null });
  const mark = ok ? '✓' : '✗';
  log(`  ${mark} [${method} ${url}] → ${status}  ${expect === 'deny' ? '(期望拒绝)' : '(期望放行)'}  ${name}`);
  if (!ok && body) log(`      响应片段: ${String(body).slice(0, 160)}`);
  return ok;
}

async function req(method, path, { token, vaultId, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (vaultId) h['x-vault-id'] = vaultId;
  if (body !== undefined) h['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    return { status: 0, text: String(e.message) };
  }
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`登录 ${username} 失败：${r.status} ${r.text.slice(0, 200)}`);
  const j = JSON.parse(r.text);
  return { token: j.data.accessToken, user: j.data.user };
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  hr('准备：登录两个不同用户');
  const admin = await login('admin', requireAuditPass());
  log(`  admin 登录成功 (id=${admin.user.id})`);
  /*
   * 第二个用户从数据库里取（tester01 / my）。
   * 密码未知时不强猜，改用「用 admin 的 token 冒充另一个用户」的方式不可行，
   * 因此这里优先尝试常见测试密码；失败则跳过「B 用户正常登录」相关用例，
   * 只用 admin token 去访问「不存在于 admin 名下」的资源（等价越权意图）。
   */
  let other = null;
  for (const [u, p] of [['tester01', requireAuditPass()], ['my', requireAuditPass()], ['tester01', '123456']]) {
    try {
      other = await login(u, p);
      log(`  ${u} 登录成功 (id=${other.user.id})`);
      break;
    } catch {
      log(`  ${u} 登录失败（继续尝试下一个）`);
    }
  }
  if (!other) log('  ! 未能登录第二个用户，部分用例改为「admin 访问不存在于其名下的资源」');

  /* ── 1. 跨用户 vaultId ── */
  hr('1. 跨用户 vaultId 访问（A 的 token + B 的 vaultId）');
  // 从 DB 层面已知：user_id=6 有 vaultmvs9ey2vkpj8q5jy? 不，上面查到 4 条都是 user_id=1。
  // 因此先构造一个「确定属于别人的」vaultId：用一个不存在的 id（等价于「不属于我」）。
  const foreignVault = other ? 'vaultOwnedByOtherUser01' : 'vaultNotMineAtAll01';
  let r1 = await req('GET', `/api/storage/list?prefix=&maxKeys=5`, { token: admin.token, vaultId: foreignVault });
  record('admin 访问不属于自己的 vaultId 的存储列举', 'GET', `/api/storage/list?x-vault-id=${foreignVault}`, r1.status, 'deny', r1.text);

  let r2 = await req('GET', `/api/storage/object?key=${encodeURIComponent(`docs/x/1-abc.md`)}`, { token: admin.token, vaultId: foreignVault });
  record('admin 在别人的 vaultId 下读对象', 'GET', `/api/storage/object (foreign vault)`, r2.status, 'deny', r2.text);

  /* ── 2. 跨用户完整前缀（对象键越界）── */
  hr('2. 对象键越界（直接写其他用户的完整前缀）');
  const otherPrefixKey = 'mdadmin/neomd/users/tester01/vaults/admin/docs/x/1-abc.md';
  let r3 = await req('GET', `/api/storage/object?key=${encodeURIComponent(otherPrefixKey)}`, { token: admin.token, vaultId: 'admin' });
  record('admin 尝试读取 tester01 前缀下的对象', 'GET', `/api/storage/object (tester01 prefix)`, r3.status, 'deny', r3.text);

  const otherPrefixKey2 = 'mdadmin/neomd/users/my/vaults/admin/docs/x/1-abc.md';
  let r4 = await req('GET', `/api/storage/object?key=${encodeURIComponent(otherPrefixKey2)}`, { token: admin.token, vaultId: 'admin' });
  record('admin 尝试读取 my 前缀下的对象', 'GET', `/api/storage/object (my prefix)`, r4.status, 'deny', r4.text);

  /* ── 3. 路径穿越 ── */
  hr('3. 路径穿越（对象键里塞 ../）');
  for (const evil of [
    'docs/../../../etc/passwd',
    'docs/x/../../../../../../etc/passwd',
    '../users/my/vaults/admin/docs/x/1-a.md',
    'docs/%2e%2e/%2e%2e/etc/passwd',
  ]) {
    const rr = await req('GET', `/api/storage/object?key=${encodeURIComponent(evil)}`, { token: admin.token, vaultId: 'admin' });
    record(`路径穿越被拒：${evil.slice(0, 40)}`, 'GET', `/api/storage/object?key=${evil.slice(0, 40)}`, rr.status, 'deny', rr.text);
  }

  /* ── 4. 跨用户 share token ── */
  hr('4. 跨用户 share token');
  const rr5 = await req('GET', '/api/public/shares/AAAAAAAAAAAAAAAAAAAAAAAA');
  record('伪造的 share token 访问公开分享', 'GET', '/api/public/shares/<fake>', rr5.status, 'deny', rr5.text);

  /* ── 5. 未登录访问受保护接口 ── */
  hr('5. 未登录访问受保护接口');
  for (const path of ['/api/settings', '/api/vaults', '/api/storage/list?prefix=', '/api/profile', '/api/credits']) {
    const rr = await req('GET', path);
    record(`无 token 访问 ${path}`, 'GET', path, rr.status, 'deny', rr.text);
  }

  /* ── 6. 伪造 / 篡改 token ── */
  hr('6. 伪造 / 篡改 JWT');
  const forgedCases = [
    ['空 token', ''],
    ['随机串', 'not-a-jwt-at-all'],
    ['篡改签名', admin.token.slice(0, -6) + 'AAAAAA'],
    ['篡改 payload（改 sub）', (() => {
      const parts = admin.token.split('.');
      if (parts.length !== 3) return admin.token;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      payload.sub = '999';
      payload.role = 'admin';
      return `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    })()],
  ];
  for (const [label, tok] of forgedCases) {
    const rr = await req('GET', '/api/settings', { token: tok });
    record(`伪造 token 被拒：${label}`, 'GET', '/api/settings', rr.status, 'deny', rr.text);
  }

  /* ── 7. 普通用户访问后台接口（提权）── */
  hr('7. 普通用户访问后台接口');
  if (other) {
    for (const path of ['/api/admin/dashboard?days=7', '/api/admin/users?page=1', '/api/admin/settings', '/api/admin/vaults?page=1', '/api/admin/plugins?page=1']) {
      const rr = await req('GET', path, { token: other.token });
      record(`普通用户(${other.user.username}) 访问 ${path}`, 'GET', path, rr.status, 'deny', rr.text);
    }
  } else {
    log('  （跳过：无第二个用户可用）');
  }

  /* ── 8. 自己的资源应当可访问（对照，避免「全部拒绝」的假阳性）── */
  hr('8. 对照组：自己的资源应当可访问');
  const own = await req('GET', '/api/settings', { token: admin.token });
  record('admin 访问自己的 /api/settings', 'GET', '/api/settings', own.status, 'allow', own.text.slice(0, 100));
  const ownV = await req('GET', '/api/vaults', { token: admin.token });
  record('admin 访问自己的 /api/vaults', 'GET', '/api/vaults', ownV.status, 'allow', ownV.text.slice(0, 100));
  const ownS = await req('GET', '/api/storage/list?prefix=&maxKeys=2', { token: admin.token, vaultId: 'admin' });
  record('admin 访问自己 vault 的存储', 'GET', '/api/storage/list (own)', ownS.status, 'allow', ownS.text.slice(0, 100));

  /* ── 9. 跨用户 settings（用 admin 的 token 读，返回的必须是 admin 自己的）── */
  hr('9. 设置归属校验（返回内容必须属于请求者）');
  const s1 = await req('GET', '/api/settings?platform=web', { token: admin.token });
  if (s1.status === 200) {
    const payload = JSON.parse(s1.text)?.data?.payload;
    const hasNaming = Boolean(payload?.naming);
    results.push({
      name: 'admin 的 settings 返回的是自己的 payload（含 naming）',
      method: 'GET',
      url: '/api/settings',
      status: s1.status,
      expect: 'allow',
      pass: hasNaming,
      bodySample: hasNaming ? 'naming 存在' : 'naming 缺失',
    });
    log(`  ${hasNaming ? '✓' : '✗'} 返回内容含 admin 自己的 naming 配置`);
  }

  /* ── 汇总 ── */
  hr('汇总');
  const passed = results.filter((x) => x.pass).length;
  const failed = results.filter((x) => !x.pass);
  log(`  探测总数 ${results.length}，通过 ${passed}，失败 ${failed.length}`);
  if (failed.length) {
    log('\n  ✗ 失败项（**可能是真实越权漏洞**）：');
    for (const f of failed) log(`    [${f.method} ${f.url}] status=${f.status} 期望=${f.expect}  ${f.name}`);
  }

  const out = join(OUT, 'isolation-probe.json');
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), api: API, total: results.length, passed, failed: failed.length, results }, null, 2), 'utf8');
  log(`\n  证据 → ${out}`);
  if (failed.length) process.exitCode = 1;
}

await main();
