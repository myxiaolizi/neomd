const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'http://127.0.0.1:5280/';
const OUT = path.resolve(__dirname, 'out');

const executablePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const SAMPLE = [
  '# 项目周报',
  '',
  '本周完成了 **编辑器内核** 与 *同步引擎*，代码量约 `3200` 行。',
  '',
  '## 进展',
  '',
  '- [x] 搭建存储适配层',
  '- [x] 接入 S3 同步',
  '- [ ] 打磨移动端体验',
  '',
  '## 引用',
  '',
  '> 低占用、快打开，是这一版的核心目标。',
  '',
  '## 代码',
  '',
  '```ts',
  'const vault = await openVault();',
  'console.log(vault.mode);',
  '```',
  '',
  '## 数据',
  '',
  '| 指标 | 数值 | 说明 |',
  '| --- | :---: | ---: |',
  '| 首屏体积 | 1.2 MB | 已压缩 |',
  '| 打开耗时 | 300ms | 冷启动 |',
  '',
  '---',
  '',
  '参考 [Markdown 规范](https://commonmark.org)。',
].join('\n');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  await page.locator('.welcome .btn.primary').first().click();
  await page.waitForTimeout(400);
  await page.locator('.modal .input').first().fill('周报');
  await page.locator('.modal .modal-foot .btn.primary').first().click();
  await page.waitForTimeout(900);

  await page.locator('.cm-content').first().click();
  await page.waitForTimeout(200);

  // insertText 不触发按键处理器，避免 smartEnter 自动续行干扰
  await page.keyboard.insertText(SAMPLE);
  await page.waitForTimeout(1200);

  // 光标移到文首，令全文处于非编辑态
  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(900);

  const dom = await page.evaluate(() => ({
    checkboxes: document.querySelectorAll('.md-checkbox').length,
    checked: document.querySelectorAll('.md-checkbox.checked').length,
    strong: document.querySelectorAll('.md-strong').length,
    em: document.querySelectorAll('.md-em').length,
    inlineCode: document.querySelectorAll('.md-inline-code-span').length,
    links: document.querySelectorAll('.md-link').length,
    hr: document.querySelectorAll('.md-hr').length,
    h1: document.querySelectorAll('.md-h1').length,
    h2: document.querySelectorAll('.md-h2').length,
    quoteLines: document.querySelectorAll('.md-quote').length,
    codeblockLines: document.querySelectorAll('.md-codeblock').length,
    tables: document.querySelectorAll('.md-table-el').length,
    tableCells: document.querySelectorAll('.md-table-el td, .md-table-el th').length,
    visibleText: document.querySelector('.cm-content').innerText,
  }));

  await page.screenshot({ path: path.join(OUT, '20-rich.png') });

  // 点击任务框
  let toggleOk = false;
  try {
    const before = await page.evaluate(() => document.querySelectorAll('.md-checkbox.checked').length);
    await page.locator('.md-checkbox').first().click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.querySelectorAll('.md-checkbox.checked').length);
    toggleOk = before !== after;
  } catch (e) {
    errors.push('toggle: ' + e.message);
  }

  // 点击标题行，验证编辑态还原源码
  let headingEditOk = false;
  try {
    await page.locator('.md-h1').first().click();
    await page.waitForTimeout(500);
    const txt = await page.evaluate(() => {
      const l = document.querySelector('.cm-line.md-h1');
      return l ? l.innerText : '';
    });
    headingEditOk = txt.includes('#');
    await page.screenshot({ path: path.join(OUT, '21-heading-edit.png') });
  } catch (e) {
    errors.push('heading: ' + e.message);
  }

  // 历史版本
  try {
    await page.keyboard.press('Control+Home');
    await page.locator('.topbar .icon-btn').nth(2).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '22-history.png') });
    await page.locator('.side-panel .icon-btn').first().click();
    await page.waitForTimeout(300);
  } catch (e) {
    errors.push('history: ' + e.message);
  }

  // 深色
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '23-dark.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 移动端
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 412, height: 915 });
  const mobileErrors = [];
  mobile.on('pageerror', (e) => mobileErrors.push(String(e)));
  await mobile.goto(URL, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(1400);
  await mobile.screenshot({ path: path.join(OUT, '24-mobile.png') });

  const result = { dom, toggleOk, headingEditOk, errors, mobileErrors };
  fs.writeFileSync(path.join(OUT, 'result3.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
