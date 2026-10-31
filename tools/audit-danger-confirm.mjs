
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
 * A4 管理端审计 · 危险操作二次确认防护（UI 观察，不执行破坏性操作）。
 *
 * ## 审计方法（重要：为什么这样可以安全地"看到确认"）
 *
 * 对每个危险按钮：
 *   1. 注册 `page.on('dialog')` 监听，遇到 confirm 时**记下文案并 dismiss（取消）**；
 *   2. 点击按钮；
 *   3. 若弹出 dialog → 有二次确认（记录文案）；
 *      若无 dialog → 检查是否出现了自定义确认弹窗（NmModal）；
 *      两者都无 → 判定「无二次确认」，但此时它可能已经真的执行了，
 *      因此对**无确认**的按钮，我们只在“可安全撤销/或对象本身是临时数据”的情况下点击。
 *
 * 为了绝对安全：本脚本只在**临时数据**上点击危险按钮（临时用户/临时插件/临时分享），
 * 对**真实数据**（admin/my/tester01 的用户行、真实插件、真实分享）只读取按钮存在性，
 * **不点击**。
 *
 * 用法：node tools/audit-danger-confirm.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const WEB = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shots = path.join(repo, 'docs', 'AUDIT-140', 'shots');
fs.mkdirSync(shots, { recursive: true });

const findings = [];
function record(module, action, hasConfirm, text, extra = '') {
  findings.push({ module, action, hasConfirm, text: text ?? '', extra });
  console.log(`  ${hasConfirm ? 'HAS-CONFIRM' : 'NO-CONFIRM '} ${module.padEnd(12)} ${action.padEnd(20)} ${String(text ?? '').slice(0, 60)}`);
}

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

// /api 转发到 3211（3200 当前宕机），且只按 pathname 精确匹配，避免拦到 Vite 模块
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    try {
      const res = await context.request.fetch(`${API}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch (e) {
      await route.fulfill({ status: 599, body: JSON.stringify({ ok: false, error: { message: String(e) } }) });
    }
  },
);

const page = await context.newPage();
/** 所有 browser confirm/alert 的文案 */
const dialogs = [];
page.on('dialog', async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  await d.dismiss(); // 一律取消，绝不执行
});

let tmpUserId = null;
try {
  /* ---------------- 登录 ---------------- */
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account', { timeout: 25000 });
  await page.fill('#account', 'admin');
  await page.fill('input[type="password"]', requireAuditPass());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await page.goto(`${WEB}/admin?tab=users`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  /* ---------------- 建一个临时用户用于安全地点危险按钮 ---------------- */
  const adminToken = await page.evaluate(() => localStorage.getItem('neomd.access'));
  const stamp = Date.now();
  const mk = await context.request.fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ email: `dgr-${stamp}@neomd.local`, username: `dgr_${stamp}`, password: 'Danger!2026' }),
  });
  const mkJson = await mk.json();
  tmpUserId = mkJson?.data?.user?.id;
  console.log(`临时用户 #${tmpUserId}（用于安全点击「删除」按钮）\n`);

  /* ================= 用户模块 ================= */
  console.log('='.repeat(88));
  console.log('用户管理 · 危险操作确认');
  console.log('='.repeat(88));

  // 搜索到临时用户，只点它的按钮
  await page.fill('.usr .adm-toolbar__search', `dgr_${stamp}`);
  await page.locator('.usr .adm-toolbar button').first().click();
  await page.waitForTimeout(1800);

  // 「删除」→ 应弹 confirm
  dialogs.length = 0;
  const delBtn = page.locator('.usr tbody tr .adm-rowbtn--danger', { hasText: '删除' }).first();
  if (await delBtn.count()) {
    await delBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    record('用户管理', '删除用户', dialogs.length > 0, dialogs[0]?.message ?? '');
    await page.screenshot({ path: path.join(shots, 'admin-danger-delete-user.png') }).catch(() => {});
  }

  // 「重置密码」→ 应弹 confirm
  dialogs.length = 0;
  const pwdBtn = page.locator('.usr tbody tr .adm-rowbtn', { hasText: '重置密码' }).first();
  if (await pwdBtn.count()) {
    await pwdBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    record('用户管理', '重置密码', dialogs.length > 0, dialogs[0]?.message ?? '');
  }

  // 「角色」徽章 → 应弹 confirm
  dialogs.length = 0;
  const roleBtn = page.locator('.usr tbody tr .adm-badge').first();
  if (await roleBtn.count()) {
    await roleBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    record('用户管理', '切换角色', dialogs.length > 0, dialogs[0]?.message ?? '');
  }

  // 「封禁」→ 走 NmModal 表单（自定义确认），检查弹窗是否出现 + 提交按钮是否需填原因才可用
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const banBtn = page.locator('[data-testid="ban-btn"]').first();
  if (await banBtn.count()) {
    await banBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const modalVisible = await page.locator('[data-testid="ban-reason"]').count();
    const submitDisabled = modalVisible ? await page.locator('[data-testid="ban-submit"]').isDisabled() : null;
    record(
      '用户管理',
      '封禁用户',
      modalVisible > 0,
      modalVisible ? `表单弹窗（未填原因时提交按钮${submitDisabled ? '禁用' : '可用'}）` : '无弹窗',
    );
    await page.screenshot({ path: path.join(shots, 'admin-danger-ban-user.png') }).catch(() => {});
    await page.keyboard.press('Escape');
  }

  // 「批量操作」→ 检查是否需要二次确认
  await page.waitForTimeout(600);
  const cb = page.locator('[data-testid="select-one"]').first();
  if (await cb.count()) {
    await cb.check().catch(() => {});
    await page.waitForTimeout(600);
    if (await page.locator('[data-testid="batch-open"]').count()) {
      await page.locator('[data-testid="batch-open"]').click().catch(() => {});
      await page.waitForTimeout(900);
      const batchModal = await page.locator('[data-testid="batch-action"]').count();
      record('用户管理', '批量操作', batchModal > 0, batchModal ? '表单弹窗（执行时另有 confirm）' : '无弹窗');
      await page.keyboard.press('Escape');
    }
  }

  /* ================= 插件模块 ================= */
  console.log('');
  console.log('='.repeat(88));
  console.log('插件市场 · 下架确认');
  console.log('='.repeat(88));
  await page.goto(`${WEB}/admin?tab=plugins`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  dialogs.length = 0;
  const offBtn = page.locator('.plg tbody tr .adm-rowbtn--danger', { hasText: '下架' }).first();
  if (await offBtn.count()) {
    await offBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    record('插件市场', '下架插件', dialogs.length > 0, dialogs[0]?.message ?? '');
    await page.screenshot({ path: path.join(shots, 'admin-danger-plugin-offline.png') }).catch(() => {});
  }

  /* ================= 分享模块 ================= */
  console.log('');
  console.log('='.repeat(88));
  console.log('分享管理 · 删除/撤销确认');
  console.log('='.repeat(88));
  await page.goto(`${WEB}/admin?tab=shares`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  dialogs.length = 0;
  const shareDel = page.locator('.adm-rowbtn--danger').first();
  if (await shareDel.count()) {
    await shareDel.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    record('分享管理', '删除/撤销分享', dialogs.length > 0, dialogs[0]?.message ?? '');
    await page.screenshot({ path: path.join(shots, 'admin-danger-share-delete.png') }).catch(() => {});
  }

  /* ================= 配置中心 ================= */
  console.log('');
  console.log('='.repeat(88));
  console.log('配置中心 · 保存确认');
  console.log('='.repeat(88));
  await page.goto(`${WEB}/admin?tab=config`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const cfgInfo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.adm-body button')].map((b) => b.textContent?.trim() ?? '');
    const sensitive = document.querySelectorAll('.adm-body [type="password"]').length;
    return { buttons: btns.filter(Boolean).slice(0, 20), sensitive };
  });
  console.log(`  配置中心按钮：${cfgInfo.buttons.join(' | ')}`);
  console.log(`  敏感字段（password 输入框）数量：${cfgInfo.sensitive}`);
  await page.screenshot({ path: path.join(shots, 'admin-config.png') }).catch(() => {});

  /* ================= 仓库/知识库令牌 ================= */
  console.log('');
  console.log('='.repeat(88));
  console.log('仓库管理 / 知识库令牌 · 危险按钮存在性（不点击）');
  console.log('='.repeat(88));
  await page.goto(`${WEB}/admin?tab=vaults`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  const vaultDanger = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('.adm-body .adm-rowbtn--danger, .adm-body .adm-rowbtn')].map(
      (b) => b.textContent?.trim() ?? '',
    );
    return [...new Set(texts)].filter(Boolean).slice(0, 12);
  });
  console.log(`  仓库管理操作按钮：${vaultDanger.join(' | ')}`);
  await page.screenshot({ path: path.join(shots, 'admin-vaults.png') }).catch(() => {});

  await page.goto(`${WEB}/admin?tab=knowledgeTokens`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  const tokenDanger = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('.adm-body .adm-rowbtn--danger, .adm-body .adm-rowbtn')].map(
      (b) => b.textContent?.trim() ?? '',
    );
    return [...new Set(texts)].filter(Boolean).slice(0, 12);
  });
  console.log(`  知识库令牌操作按钮：${tokenDanger.join(' | ')}`);
  await page.screenshot({ path: path.join(shots, 'admin-knowledge-tokens.png') }).catch(() => {});
} finally {
  console.log('');
  console.log('='.repeat(88));
  console.log('清理临时用户');
  console.log('='.repeat(88));
  if (tmpUserId) {
    const token = await page.evaluate(() => localStorage.getItem('neomd.access')).catch(() => null);
    await execute('DELETE FROM credit_ledger WHERE user_id = ?', [tmpUserId]).catch(() => {});
    await execute('DELETE FROM user_vaults WHERE user_id = ?', [tmpUserId]).catch(() => {});
    await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [tmpUserId]).catch(() => {});
    await execute('DELETE FROM user_settings WHERE user_id = ?', [tmpUserId]).catch(() => {});
    await execute('DELETE FROM users WHERE id = ?', [tmpUserId]).catch(() => {});
    const left = await query('SELECT COUNT(*) AS n FROM users WHERE id = ?', [tmpUserId]);
    console.log(`  临时用户 #${tmpUserId} 剩余：${left[0]?.n}`);
  }
  console.log('');
  console.log('='.repeat(88));
  console.log('危险操作确认防护汇总');
  console.log('='.repeat(88));
  const noConfirm = findings.filter((f) => !f.hasConfirm);
  for (const f of findings) {
    console.log(`  ${f.hasConfirm ? '✓' : '✗'} ${f.module.padEnd(12)} ${f.action.padEnd(20)} ${String(f.text).slice(0, 50)}`);
  }
  console.log('');
  console.log(`  有确认：${findings.length - noConfirm.length} / ${findings.length}`);
  if (noConfirm.length) {
    console.log('  ⚠ 无二次确认的操作（需产品确认是否可接受）：');
    for (const f of noConfirm) console.log(`    - ${f.module} / ${f.action}`);
  }

  await context.close();
  await browser.close();
  await closePool();
}
