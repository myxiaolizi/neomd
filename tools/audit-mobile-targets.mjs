
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
 * A4 管理端审计 · 移动端可点击目标尺寸取证（AUDIT-04）。
 *
 * 目的：audit-perm-mobile.mjs 报告「375×667 下所有可点击目标 < 28px」。
 * 需要确认：是按钮真的太小（可点区域不足），还是我的度量方式把「文字很小但外边距够大」的
 * 元素误判了。因此这里同时记录 **元素自身盒尺寸** 与 **实际命中区域**（含 padding），
 * 并对照 WCAG 2.5.5（目标尺寸 44×44 CSS px）与 Android Material（48dp）/ iOS HIG（44pt）。
 *
 * 用法：node tools/audit-mobile-targets.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WEB = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shots = path.join(repo, 'docs', 'AUDIT-140', 'shots');
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer'],
});
const ctx = await browser.newContext({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
await ctx.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    try {
      const res = await ctx.request.fetch(`${API}${u.pathname}${u.search}`, {
        method: req.method(),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch {
      await route.fulfill({ status: 599, body: '{}' });
    }
  },
);

const page = await ctx.newPage();
await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#account', { timeout: 20000 });
await page.fill('#account', 'admin');
await page.fill('input[type="password"]', requireAuditPass());
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);

const TABS = ['dashboard', 'users', 'plugins', 'audit', 'releases'];
const summary = [];

for (const tab of TABS) {
  try {
    await page.goto(`${WEB}/admin?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const detail = await page.evaluate(() => {
      const pick = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const measure = (els, group) =>
        els.slice(0, 40).map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            group,
            text: (el.textContent ?? '').trim().slice(0, 16) || el.getAttribute('aria-label') || el.tagName,
            w: Math.round(r.width),
            h: Math.round(r.height),
            fontSize: cs.fontSize,
            padding: cs.padding,
            cls: String(el.className ?? '').slice(0, 36),
          };
        });
      return [
        ...measure(pick('[data-testid="admin-nav-item"]'), 'nav'),
        ...measure(pick('.adm-body .adm-rowbtn'), 'rowbtn'),
        ...measure(pick('.adm-body .nm-btn'), 'nm-btn'),
        ...measure(pick('.adm-body .adm-badge'), 'badge'),
      ];
    });

    const tooSmall = detail.filter((d) => d.w < 44 || d.h < 44);
    const worst = detail.slice().sort((a, b) => a.h * a.w - b.h * b.w).slice(0, 5);
    summary.push({ tab, total: detail.length, tooSmall: tooSmall.length, worst });
    console.log('');
    console.log('='.repeat(90));
    console.log(`页签 ${tab}：测量 ${detail.length} 个可点击目标，其中 < 44×44 的有 ${tooSmall.length} 个`);
    console.log('='.repeat(90));
    console.log('  最小的 5 个（按面积）：');
    for (const w of worst) {
      console.log(`    [${w.group.padEnd(7)}] "${w.text.padEnd(16)}" ${w.w}×${w.h}  font=${w.fontSize}  pad=${w.padding}  ${w.cls}`);
    }
    await page.screenshot({ path: path.join(shots, `admin-mobile-targets-${tab}.png`) }).catch(() => {});
  } catch (err) {
    console.log(`  页签 ${tab} 加载异常：${String(err.message).slice(0, 80)}`);
  }
}

console.log('');
console.log('='.repeat(90));
console.log('判定（对照 WCAG 2.5.5 / Material 48dp / iOS 44pt）');
console.log('='.repeat(90));
console.log('  WCAG 2.5.5 Target Size (Enhanced) 要求 ≥ 44×44 CSS px；');
console.log('  WCAG 2.5.8 (AA, 2.2) 要求 ≥ 24×24 CSS px。');
console.log('');
for (const s of summary) {
  const pct = s.total ? Math.round((s.tooSmall / s.total) * 100) : 0;
  const verdict =
    s.tooSmall === 0 ? '✅ 达标（全部 ≥44）' : pct > 50 ? '❌ 明显不达标' : '⚠ 部分偏小';
  console.log(`  ${s.tab.padEnd(10)} ${String(s.tooSmall).padStart(3)}/${String(s.total).padStart(3)} 小于 44px (${pct}%)  ${verdict}`);
}
console.log('');
console.log('  说明：后台是桌面运营工具，移动端并非主要使用场景；');
console.log('        若产品明确「移动端可用」为目标，则需给 .adm-rowbtn/.nm-btn 在窄屏下加 min-height:44px。');

await ctx.close();
await browser.close();
process.exitCode = 0;
