/**
 * 调试：登录后直接访问 /admin，输出 localStorage 与鉴权请求结果。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
const { chromium } = playwright;

const BASE = 'https://md.zhengl.vip';
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--headless=new', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));

await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.fill('#account', 'admin');
await page.fill('#password', 'MaC2=KRV4J-KBK=b6X=J');
await page.locator('.card__submit').click();
await page.waitForURL('**/app', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(2000);

const before = await page.evaluate(() => ({
  hasAccess: Boolean(localStorage.getItem('neomd.access')),
  accessLen: (localStorage.getItem('neomd.access') || '').length,
}));
console.log('登录后 localStorage:', before);

const meResult = await page.evaluate(async () => {
  const t = localStorage.getItem('neomd.access');
  const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => null);
  return { status: r.status, role: j?.data?.user?.role ?? j?.data?.role ?? null, ok: j?.ok };
});
console.log('直接请求 /api/auth/me:', meResult);

await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
console.log('最终 URL:', page.url());
console.log('页面有 .admin 容器:', (await page.locator('.admin').count()) > 0);
console.log('页面有 .stat-card:', await page.locator('.stat-card').count());

const after = await page.evaluate(() => ({
  hasAccess: Boolean(localStorage.getItem('neomd.access')),
  bodyStart: document.body.innerText.slice(0, 120).replace(/\s+/g, ' '),
}));
console.log('admin 页状态:', after);

await browser.close();
