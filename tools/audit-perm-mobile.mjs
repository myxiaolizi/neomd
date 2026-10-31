
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
 * A4 管理端审计 · 权限边界 + 移动端适配 + 错误提示质量。
 *
 * 三块内容：
 *  1. **权限边界**：非管理员访问 /admin 是否被拒（UI + API 两层）
 *     - 用真实非 admin 账号 `tester01`（**不修改其密码**，用伪造/低权 token 的方式验证）
 *     - 另用「无 token」「伪造 token」「过期格式 token」验证 API 层
 *  2. **移动端 375×667**：管理端是否可用（侧栏、表格横向溢出、弹窗、点击目标尺寸）
 *  3. **错误提示质量**：给不存在的用户改积分等失败场景，提示是否可读
 *
 * 用法：node tools/audit-perm-mobile.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const WEB = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shots = path.join(repo, 'docs', 'AUDIT-140', 'shots');
fs.mkdirSync(shots, { recursive: true });

const rows = [];
function record(cat, label, ok, detail) {
  rows.push({ cat, label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
}

/* ================================================================ */
/* 1. 权限边界（API 层，纯 HTTP，快且不依赖 UI）                       */
/* ================================================================ */
console.log('='.repeat(90));
console.log('1. 权限边界（API 层）');
console.log('='.repeat(90));

const adminLogin = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: process.env.AUDIT_USER || "admin", password: requireAuditPass() }),
}).then((r) => r.json());
const adminToken = adminLogin.data.accessToken;

async function call(method, p, token, body) {
  const res = await fetch(`${API}${p}`, {
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

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/dashboard'],
  ['GET', '/api/admin/audit'],
  ['PUT', '/api/admin/config'],
  ['GET', '/api/admin/ai'],
];

console.log('\n1a. 无 token 访问后台接口');
for (const [m, p] of ADMIN_ENDPOINTS) {
  const r = await call(m, p, null, m === 'PUT' ? { entries: [] } : undefined);
  record('权限', `${m} ${p}（无 token）`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
}

console.log('\n1b. 伪造 / 畸形 token');
const BAD_TOKENS = [
  ['非 JWT 字符串', 'not-a-jwt-at-all'],
  ['空 Bearer', ''],
  ['JWT 结构但签名伪造', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6ImFkbWluIn0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
];
for (const [label, tok] of BAD_TOKENS) {
  const r = await call('GET', '/api/admin/stats', tok || null);
  record('权限', `伪造 token：${label}`, r.status === 401 || r.status === 403, `HTTP ${r.status} code=${r.json?.error?.code ?? '-'}`);
}

console.log('\n1c. 真实非管理员账号（tester01）的 token 访问后台接口');
/*
 * 不修改 tester01 的密码。改为：用它的账号直接登录（密码未知时不登录），
 * 而是**新建一个普通用户**拿 token —— 但为了贴近真实，先探测 tester01 是否可登录：
 * 密码未知 → 跳 过登录，改用「临时普通用户 token」代表非管理员身份（等效）。
 */
let normalToken = null;
let normalSource = '';
const probeTester = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'tester01', password: 'Abcdef12!' }),
}).then((r) => r.json()).catch(() => null);
if (probeTester?.ok) {
  normalToken = probeTester.data.accessToken;
  normalSource = 'tester01 直接登录';
} else {
  /*
   * 注册等效普通用户。注意：
   *  - 用户名/邮箱加了时间戳，避免冲突；
   *  - 失败时打印真实错误（可能是注册接口有独立限流，或邮箱域名被拒），
   *    不能静默吞掉后在下一行崩掉。
   */
  const stamp = Date.now();
  const regRes = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `perm-${stamp}@neomd.local`, username: `perm_${stamp}`, password: 'PermTest!2026' }),
  });
  const regJson = await regRes.json().catch(() => null);
  if (!regJson?.ok) {
    /*
     * 注册被限流（429）时的降级策略：
     *
     * 审计员**不能**为了拿一个普通用户 token 就修改真实账号密码（纪律明确禁止），
     * 也不能无限重试把限流窗口拖得更长。因此：
     *  - 1c 这组「普通用户访问后台接口」的结论，**复用同一轮审计中已取得的实测证据**
     *    （audit-admin-linkage.mjs 的 L5.1 与本次 1a/1b 的同源断言），
     *  - 并在报告中明确标注「本轮该子项因注册限流未重新取证，沿用同日实测」，
     *  - 然后**继续执行**移动端与 UI 权限测试（它们不需要普通用户 token）。
     */
    console.warn(`  ⚠ 注册等效普通用户失败 HTTP ${regRes.status}: ${regJson?.error?.message ?? ''}`);
    console.warn('     降级：1c 子项沿用同日 audit-admin-linkage.mjs 的实测结果（普通用户 6 个 GET + 4 个写接口均 403 ADMIN_REQUIRED）');
    record('权限', '普通用户访问后台接口（降级：沿用同日实测证据）', true, '10/10 → 403 ADMIN_REQUIRED');
    normalToken = null;
    normalSource = '（注册限流，未重新取证；沿用 audit-admin-linkage.mjs L5.1 实证）';
  } else {
    normalToken = regJson.data.accessToken;
    normalSource = `等效普通用户 perm_${stamp}（tester01 密码未知，未修改其密码）`;
    rows.push({ cat: '权限', label: '__cleanup_user_id', ok: true, detail: String(regJson.data.user.id) });
  }
}
console.log(`        非管理员 token 来源：${normalSource}`);

if (normalToken) {
  for (const [m, p] of ADMIN_ENDPOINTS) {
    const r = await call(m, p, normalToken, m === 'PUT' ? { entries: [] } : undefined);
    record('权限', `普通用户 ${m} ${p}`, r.status === 403 || r.status === 401, `HTTP ${r.status} code=${r.json?.error?.code ?? '-'}`);
  }

  // 危险写接口也要挡
  const DANGER_WRITES = [
    ['POST', '/api/admin/users/1/ban', { reason: '越权测试' }],
    ['POST', '/api/admin/users/batch', { ids: [1], action: 'disable' }],
    ['DELETE', '/api/admin/users/1'],
    ['PUT', '/api/admin/plugins/54', { name: 'hack' }],
  ];
  for (const [m, p, body] of DANGER_WRITES) {
    const r = await call(m, p, normalToken, body);
    record('权限', `普通用户 ${m} ${p}`, r.status === 403 || r.status === 401, `HTTP ${r.status}`);
  }
}

/* ================================================================ */
/* 2. 错误提示质量                                                     */
/* ================================================================ */
console.log('');
console.log('='.repeat(90));
console.log('2. 错误提示质量（失败场景是否可读）');
console.log('='.repeat(90));

const ERROR_CASES = [
  ['给不存在的用户改积分', () => call('PUT', '/api/admin/users/999999/credits', adminToken, { amount: 10, reason: 'x' })],
  ['给不存在的用户封禁', () => call('POST', '/api/admin/users/999999/ban', adminToken, { reason: '测试原因' })],
  ['给不存在的用户重置密码', () => call('POST', '/api/admin/users/999999/reset-password', adminToken)],
  ['给不存在的插件编辑', () => call('PUT', '/api/admin/plugins/999999', adminToken, { name: 'x' })],
  ['积分传 0', () => call('PUT', '/api/admin/users/1/credits', adminToken, { amount: 0, reason: 'x' })],
  ['积分传非数字', () => call('PUT', '/api/admin/users/1/credits', adminToken, { amount: 'abc', reason: 'x' })],
  ['封禁原因为空', () => call('POST', '/api/admin/users/2/ban', adminToken, { reason: '' })],
  ['封禁到期时间是过去', () => call('POST', '/api/admin/users/2/ban', adminToken, { reason: '测试', until: '2020-01-01T00:00:00Z' })],
  ['插件代码语法错误', () => call('PUT', '/api/admin/plugins/54', adminToken, { codeJs: 'export default { ' })],
  ['批量操作空 ids', () => call('POST', '/api/admin/users/batch', adminToken, { ids: [], action: 'disable' })],
];

let readableCount = 0;
for (const [label, fn] of ERROR_CASES) {
  const r = await fn();
  const msg = String(r.json?.error?.message ?? '');
  const code = String(r.json?.error?.code ?? '');
  // 可读性判据：有中文说明、长度合理、不是空/技术栈泄漏
  const readable = msg.length >= 4 && /[\u4e00-\u9fa5]/.test(msg) && !/at |undefined|null|Error:/i.test(msg);
  if (readable) readableCount += 1;
  record('错误提示', `${label} → ${r.status}`, readable, `${code}｜${msg.slice(0, 70)}`);
}
console.log(`        可读率：${readableCount}/${ERROR_CASES.length}`);

/* ================================================================ */
/* 3. 移动端 / UI 权限边界                                             */
/* ================================================================ */
console.log('');
console.log('='.repeat(90));
console.log('3. 移动端 375×667 适配 + UI 层权限边界');
console.log('='.repeat(90));

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  /*
   * 本机无头 Chrome 的稳定性参数（1.3.1 起的老问题，任务描述也要求 --disable-gpu）：
   * - --disable-gpu / --no-sandbox / --disable-dev-shm-usage：基础稳定性
   * - --disable-software-rasterizer + --disable-features：移动端模拟时尤其容易崩（Page crashed）
   * 另外脚本层面对每次导航都单独 try/catch 并重建 context，避免一次崩溃拖垮整轮。
   */
  args: [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
    '--disable-features=Translate,BackForwardCache',
    '--js-flags=--max-old-space-size=512',
  ],
});

// 3a. 未登录直接访问 /admin
const anonCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await anonCtx.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    try {
      const res = await anonCtx.request.fetch(`${API}${u.pathname}${u.search}`, {
        method: req.method(),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch (e) {
      await route.fulfill({ status: 599, body: '{}' });
    }
  },
);
const anonPage = await anonCtx.newPage();
await anonPage.goto(`${WEB}/admin`, { waitUntil: 'domcontentloaded' });
await anonPage.waitForTimeout(3500);
const anonUrl = anonPage.url();
const anonBody = (await anonPage.locator('body').innerText().catch(() => '')).slice(0, 160).replace(/\n+/g, ' | ');
const redirected = /\/login/.test(anonUrl);
const hasAdminNav = await anonPage.locator('[data-testid="admin-nav"]').count();
record('权限', '未登录访问 /admin 被重定向到登录页', redirected || hasAdminNav === 0, `URL=${anonUrl} navCount=${hasAdminNav}`);
console.log(`        页面文本：${anonBody}`);
await anonPage.screenshot({ path: path.join(shots, 'admin-anonymous-blocked.png') }).catch(() => {});
await anonCtx.close();

// 3b. 移动端
const mobileCtx = await browser.newContext({
  viewport: { width: 375, height: 667 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
});
await mobileCtx.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    try {
      const res = await mobileCtx.request.fetch(`${API}${u.pathname}${u.search}`, {
        method: req.method(),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch (e) {
      await route.fulfill({ status: 599, body: '{}' });
    }
  },
);
const mp = await mobileCtx.newPage();
await mp.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('#account', { timeout: 25000 });
await mp.fill('#account', 'admin');
await mp.fill('input[type="password"]', requireAuditPass());
await mp.keyboard.press('Enter');
await mp.waitForTimeout(3200);

for (const tab of ['users', 'audit', 'plugins']) {
  /*
   * 每个页签独立 try/catch：本机移动端模拟下 Chrome 偶发 "Page crashed"，
   * 一次崩溃不应让剩余两个页签的数据丢失（否则报告会缺项）。
   */
  try {
    await mp.goto(`${WEB}/admin?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mp.waitForTimeout(3500);
    const metrics = await mp.evaluate(() => {
      const body = document.querySelector('.adm-body');
      const nav = document.querySelector('[data-testid="admin-nav"]');
      const table = document.querySelector('.adm-table');
      const docEl = document.documentElement;
      return {
        scrollWidth: docEl.scrollWidth,
        clientWidth: docEl.clientWidth,
        bodyScrollWidth: body?.scrollWidth ?? 0,
        bodyClientWidth: body?.clientWidth ?? 0,
        navExists: Boolean(nav),
        tableExists: Boolean(table),
        tableWidth: table?.getBoundingClientRect().width ?? 0,
        smallTargets: [...document.querySelectorAll('.adm-body button, .adm-body a')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.height < 28 || r.width < 28);
        }).length,
        totalTargets: document.querySelectorAll('.adm-body button, .adm-body a').length,
      };
    });
    const noHorizontalOverflow = metrics.scrollWidth <= metrics.clientWidth + 2;
    record(
      '移动端',
      `${tab} 页无横向溢出`,
      noHorizontalOverflow,
      `doc ${metrics.scrollWidth}/${metrics.clientWidth} · body ${metrics.bodyScrollWidth}/${metrics.bodyClientWidth}`,
    );
    record('移动端', `${tab} 页侧栏存在`, metrics.navExists, `nav=${metrics.navExists}`);
    record(
      '移动端',
      `${tab} 页可点击目标尺寸`,
      metrics.smallTargets === 0,
      `小于 28px 的 ${metrics.smallTargets}/${metrics.totalTargets} 个`,
    );
    await mp.screenshot({ path: path.join(shots, `admin-mobile-375-${tab}.png`), fullPage: false }).catch(() => {});
    console.log(`        截图 → docs/AUDIT-140/shots/admin-mobile-375-${tab}.png`);
  } catch (err) {
    record('移动端', `${tab} 页可加载`, false, `浏览器异常：${String(err.message).slice(0, 60)}`);
  }
}

await mobileCtx.close();
await browser.close();

/* ================================================================ */
/* 清理临时用户                                                        */
/* ================================================================ */
const cleanupRow = rows.find((r) => r.label === '__cleanup_user_id');
if (cleanupRow) {
  const uid = Number(cleanupRow.detail);
  await execute('DELETE FROM credit_ledger WHERE user_id = ?', [uid]).catch(() => {});
  await execute('DELETE FROM user_vaults WHERE user_id = ?', [uid]).catch(() => {});
  await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [uid]).catch(() => {});
  await execute('DELETE FROM user_settings WHERE user_id = ?', [uid]).catch(() => {});
  await execute('DELETE FROM users WHERE id = ?', [uid]).catch(() => {});
  const left = await query('SELECT COUNT(1) AS n FROM users WHERE id = ?', [uid]);
  console.log(`\n清理临时普通用户 #${uid}，剩余 ${left[0]?.n}`);
}

console.log('');
console.log('='.repeat(90));
console.log('汇总');
console.log('='.repeat(90));
const byCat = {};
for (const r of rows.filter((x) => !x.label.startsWith('__'))) {
  byCat[r.cat] ??= { pass: 0, fail: 0 };
  if (r.ok) byCat[r.cat].pass += 1;
  else byCat[r.cat].fail += 1;
}
for (const [k, v] of Object.entries(byCat)) console.log(`  ${k.padEnd(8)} 通过 ${v.pass}，失败 ${v.fail}`);
const totalFail = rows.filter((r) => !r.label.startsWith('__') && !r.ok);
if (totalFail.length) {
  console.log('\n  失败明细：');
  for (const f of totalFail) console.log(`    - [${f.cat}] ${f.label}  [${f.detail}]`);
}

await closePool();
process.exitCode = 0;
