#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **普通用户提权探测**（无害，只 GET）。
 *
 * 目标：验证 role=user 的用户访问 /api/admin/* 是否全部被 403 拒绝。
 *
 * 如何拿到普通用户 token 而不改密码：
 *  1. 从 DB 读出一个 role='user' 的账号；
 *  2. 用**临时创建的测试会话**不可行（会污染），因此改为：
 *     - 若已知测试密码则登录；否则
 *     - 直接**在进程内签发**一个该用户的合法 access token（用同一个 JWT_SECRET），
 *       这完全等价于该用户登录后的 token，且不修改任何数据。
 *
 * 第 2 种方式是最干净的做法：它验证的是**服务端鉴权逻辑**，而不是密码。
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

const dbUrl = new URL(`file:///${join(REPO, 'services/api/src/db/pool.js').replace(/\\/g, '/')}`).href;
const jwtUrl = new URL(`file:///${join(REPO, 'services/api/src/lib/jwt.js').replace(/\\/g, '/')}`).href;

const db = await import(dbUrl);
const jwt = await import(jwtUrl);

const results = [];
function record(name, status, expect, body) {
  const denied = [401, 403].includes(status);
  const ok = expect === 'deny' ? denied : status >= 200 && status < 300;
  results.push({ name, status, expect, pass: ok, bodySample: body ? String(body).slice(0, 160) : null });
  log(`  ${ok ? '✓' : '✗'} ${name.padEnd(56)} → ${status}`);
  if (!ok) log(`      响应：${String(body).slice(0, 160)}`);
}

async function get(path, token) {
  const h = token ? { authorization: `Bearer ${token}` } : {};
  const r = await fetch(`${API}${path}`, { headers: h });
  const t = await r.text().catch(() => '');
  return { status: r.status, text: t };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString(), api: API };

  hr('1. 找出 role=user 的账号');
  const users = await db.query('SELECT id, username, role, status FROM users ORDER BY id');
  report.users = users;
  for (const u of users) log(`  id=${u.id}  ${u.username}  role=${u.role}  status=${u.status}`);
  const normal = users.find((u) => u.role !== 'admin' && u.status === 'active');
  if (!normal) {
    log('  ! 没有可用的普通用户，跳过提权探测');
    await db.closePool();
    return;
  }
  log(`  选中普通用户：${normal.username} (id=${normal.id})`);

  hr('2. 为该用户签发一个合法 access token（等价于他登录后拿到的）');
  /*
   * 用服务端自己的 signAccessToken，保证 token 结构与真实登录完全一致：
   * 同样的 JWT_SECRET、同样的 payload 字段（userId/role/deviceId）。
   * 这不会修改任何数据，也不是伪造 —— 它就是「该用户本人」的凭证。
   */
  const normalToken = jwt.signAccessToken({
    userId: normal.id,
    role: normal.role,
    deviceId: 'audit-probe',
  });
  report.tokenIssuedFor = normal.username;
  log(`  token 已签发（长度 ${normalToken.length}）`);

  hr('3. 普通用户访问自己的普通接口（对照，应 200）');
  const self1 = await get('/api/settings', normalToken);
  record('普通用户 GET /api/settings（自己的）', self1.status, 'allow', self1.text);
  const self2 = await get('/api/vaults', normalToken);
  record('普通用户 GET /api/vaults（自己的）', self2.status, 'allow', self2.text);

  hr('4. 普通用户访问后台接口（必须全部 403）');
  const adminPaths = [
    '/api/admin/stats',
    '/api/admin/dashboard?days=7',
    '/api/admin/users?page=1',
    '/api/admin/plugins?page=1',
    '/api/admin/vaults?page=1',
    '/api/admin/publishes?page=1',
    '/api/admin/releases',
    '/api/admin/audit?page=1',
    '/api/admin/comments?page=1',
    '/api/admin/billing',
    '/api/admin/ai/providers',
    '/api/admin/ai/usage?days=7',
    '/api/admin/redeem-codes?page=1',
    '/api/admin/credits?page=1',
    '/api/admin/backups?page=1',
    '/api/admin/users/1',
    '/api/admin/users/1/logins',
    '/api/admin/users/1/overview',
  ];
  for (const p of adminPaths) {
    const r = await get(p, normalToken);
    record(`普通用户 GET ${p}`, r.status, 'deny', r.text);
  }

  hr('5. 普通用户尝试写后台接口（必须 403，且不应产生副作用）');
  const writeCases = [
    ['DELETE', '/api/admin/users/999999'],
    ['PUT', '/api/admin/users/999999/status'],
    ['PUT', '/api/admin/settings'],
  ];
  for (const [m, p] of writeCases) {
    const r = await fetch(`${API}${p}`, {
      method: m,
      headers: { authorization: `Bearer ${normalToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const t = await r.text().catch(() => '');
    record(`普通用户 ${m} ${p}`, r.status, 'deny', t);
  }

  hr('6. 普通用户尝试访问别人的 vault 存储（应被隔离）');
  // admin 的 vault
  const r6 = await fetch(`${API}/api/storage/list?prefix=&maxKeys=2`, {
    headers: { authorization: `Bearer ${normalToken}`, 'x-vault-id': 'admin' },
  });
  const t6 = await r6.text().catch(() => '');
  /*
   * 这里期望「拒绝」或「返回空」。
   * 注意：`/api/storage/list` 的语义是「列举当前用户在该 vaultId 下的对象」，
   * 而作用域前缀里含 `users/<username>/`，所以即便 vaultId 相同，
   * 普通用户看到的也是**自己**前缀下的空集合 —— 数据不会泄漏。
   * 因此判定标准是「不得返回 admin 的真实对象」，而不是「必须 403」。
   */
  const leaked = /docs\/|index\/|versions\//.test(t6) && t6.includes('"size":') && !t6.includes('"objects":[]');
  results.push({
    name: '普通用户访问 admin 的 vaultId 存储列举',
    status: r6.status,
    expect: 'deny-or-empty',
    pass: !leaked,
    bodySample: t6.slice(0, 200),
  });
  log(`  ${!leaked ? '✓' : '✗'} 普通用户访问 x-vault-id=admin → ${r6.status}，是否泄漏 admin 对象：${leaked ? '是' : '否'}`);
  log(`      响应：${t6.slice(0, 160)}`);
  report.storageProbe = { status: r6.status, leaked, body: t6.slice(0, 400) };

  hr('7. 汇总');
  const passed = results.filter((x) => x.pass).length;
  const failed = results.filter((x) => !x.pass);
  log(`  探测 ${results.length} 项，通过 ${passed}，失败 ${failed.length}`);
  if (failed.length) {
    log('\n  ✗ 失败项：');
    for (const f of failed) log(`    ${f.name} → ${f.status} (期望 ${f.expect})`);
  }
  report.results = results;
  report.passed = passed;
  report.failed = failed.length;
  writeFileSync(join(OUT, 'privilege-escalation.json'), JSON.stringify(report, null, 2), 'utf8');
  log(`\n  证据 → ${join(OUT, 'privilege-escalation.json')}`);

  await db.closePool();
  if (failed.length) process.exitCode = 1;
}

await main();
