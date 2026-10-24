/**
 * 生产构建端到端回归：
 * 新建 → 编辑 → 保存 → 历史版本 → 设置各页 → 命令面板 → 移动端
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIST = path.resolve(__dirname, '../../app/dist');
const OUT = path.resolve(__dirname, 'out');
const PORT = 5399;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      let file = path.join(DIST, rel);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const SAMPLE = [
  '# 产品需求评审',
  '',
  '本次评审确认了 **三个核心目标**，并明确了 *验收标准*。',
  '',
  '## 结论',
  '',
  '- [x] 确定技术方案',
  '- [x] 排期确认',
  '- [ ] 输出接口文档',
  '',
  '> 关键结论：先保证打开速度，再谈功能丰富度。',
  '',
  '```js',
  'const speed = measure(() => openVault());',
  '```',
  '',
  '| 项目 | 目标 | 状态 |',
  '| --- | :---: | ---: |',
  '| 打开耗时 | 300ms | 达成 |',
  '| 首屏体积 | 1.3MB | 达成 |',
].join('\n');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();

  const executablePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => fs.existsSync(p));

  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const checks = {};

  // 1. 首屏渲染
  checks.rendered = (await page.locator('.sidebar').count()) === 1;

  // 2. 新建
  await page.locator('.welcome .btn.primary').first().click();
  await page.waitForTimeout(400);
  await page.locator('.modal .input').first().fill('需求评审');
  await page.locator('.modal .modal-foot .btn.primary').first().click();
  await page.waitForTimeout(900);
  checks.created = (await page.locator('.cm-content').count()) === 1;

  // 3. 输入并保存
  await page.locator('.cm-content').first().click();
  await page.keyboard.insertText(SAMPLE);
  await page.waitForTimeout(1000);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1000);
  checks.saved = !(await page.locator('.chip.orange').count());

  // 4. 渲染断言
  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(700);
  const dom = await page.evaluate(() => ({
    checkbox: document.querySelectorAll('.md-checkbox').length,
    checked: document.querySelectorAll('.md-checkbox.checked').length,
    strong: document.querySelectorAll('.md-strong').length,
    em: document.querySelectorAll('.md-em').length,
    quote: document.querySelectorAll('.md-quote').length,
    codeblock: document.querySelectorAll('.md-codeblock').length,
    table: document.querySelectorAll('.md-table-el').length,
    h1: document.querySelectorAll('.md-h1').length,
    h2: document.querySelectorAll('.md-h2').length,
  }));
  checks.render = {
    ok: dom.checkbox === 3 && dom.checked === 2 && dom.strong === 1 &&
        dom.em === 1 && dom.quote >= 1 && dom.codeblock >= 3 && dom.table === 1 &&
        dom.h1 === 1 && dom.h2 === 1,
    dom,
  };
  await page.screenshot({ path: path.join(OUT, '50-prod-main.png') });

  // 5. 历史版本面板
  await page.locator('.topbar .icon-btn').nth(2).click();
  await page.waitForTimeout(500);
  checks.historyPanel = (await page.locator('.side-panel').count()) >= 1;
  // 创建快照
  await page.locator('.side-panel .btn.sm').first().click();
  await page.waitForTimeout(700);
  const verCount = await page.locator('.ver-item').count();
  checks.snapshot = verCount >= 1;
  await page.screenshot({ path: path.join(OUT, '51-prod-history.png') });
  await page.locator('.side-panel .icon-btn').first().click();
  await page.waitForTimeout(300);

  // 6. 设置各页签
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mdnote:settings')));
  await page.waitForTimeout(500);
  checks.settings = (await page.locator('.modal .tabs').count()) === 1;
  const tabs = ['通用', '编辑', '快捷键', '同步', 'AI 命名', '关于'];
  const tabShots = [];
  for (const t of tabs) {
    const tab = page.locator('.tab', { hasText: t }).first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(300);
      tabShots.push(t);
    }
  }
  checks.tabs = tabShots;
  await page.screenshot({ path: path.join(OUT, '52-prod-settings.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 7. 命令面板
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(500);
  checks.palette = (await page.locator('.palette').count()) === 1;
  await page.screenshot({ path: path.join(OUT, '53-prod-palette.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 8. 快捷键：Ctrl+2 设置二级标题
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('快捷键验证行');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(500);
  const headingCount = await page.evaluate(() =>
    document.querySelectorAll('.md-h2').length);
  checks.shortcutH2 = headingCount >= 2;
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);

  // 9. 深色
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '54-prod-dark.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 10. 平板与手机
  const tablet = await ctx.newPage();
  await tablet.setViewportSize({ width: 820, height: 1180 });
  await tablet.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await tablet.waitForTimeout(1200);
  await tablet.screenshot({ path: path.join(OUT, '55-prod-tablet.png') });

  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 412, height: 915 });
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push(String(e)));
  await phone.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(1200);
  const overflow = await phone.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    scroller: (() => {
      const s = document.querySelector('.cm-scroller');
      return s ? { sw: s.scrollWidth, cw: s.clientWidth } : null;
    })(),
  }));
  checks.mobileNoOverflow = overflow.doc <= overflow.win &&
    (!overflow.scroller || overflow.scroller.sw <= overflow.scroller.cw + 1);
  await phone.screenshot({ path: path.join(OUT, '56-prod-phone.png') });

  const result = { checks, errors, phoneErrors, overflow };
  fs.writeFileSync(path.join(OUT, 'prod.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  server.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
