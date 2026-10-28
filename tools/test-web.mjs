/**
 * 用本机 Electron 的 Chromium 内核（playwright-core）打开线上站点，
 * 逐页截图并检查关键 DOM，验证真实浏览器下的渲染与交互。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
const { chromium } = playwright;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'https://md.zhengl.vip';
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browserExe = process.env.BROWSER_EXE || CANDIDATES.find((p) => fs.existsSync(p));
if (!browserExe) {
  console.error('未找到可用的 Chromium 内核浏览器');
  process.exit(1);
}
console.log('使用浏览器:', browserExe);

const browser = await chromium.launch({
  executablePath: browserExe,
  args: ['--headless=new', '--no-sandbox', '--disable-gpu'],
});

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    fail += 1;
    console.log('  ✗ ' + label + (extra ? ' — ' + extra : ''));
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(shots, name), fullPage: false });
}

console.log('首页');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
check(await page.title() !== '', '页面标题存在');
const heroText = await page.textContent('h1').catch(() => '');
check(heroText.includes('笔记'), '首屏主标题正确: ' + heroText.replace(/\s+/g, ' ').trim().slice(0, 30));
check(await page.locator('.hero__cta button').count() >= 2, '存在「立即开始」与「下载」按钮');
check(await page.locator('.card').count() >= 6, '功能介绍卡片渲染');
await shot('01-home.png');

console.log('登录弹窗');
await page.locator('.nav__actions button', { hasText: '登录' }).first().click();
await page.waitForSelector('.modal', { timeout: 8000 });
check(await page.locator('.modal').isVisible(), '首页点击登录弹出登录框');
await shot('02-login-modal.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

console.log('登录页');
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
check(await page.locator('.card__form').count() === 1, '登录表单渲染');
await shot('03-login-page.png');

console.log('真实登录');
await page.fill('#account', 'admin');
await page.fill('#password', 'MaC2=KRV4J-KBK=b6X=J');
await page.locator('.card__submit').click();
await page.waitForURL('**/app', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(3000);
check(page.url().includes('/app'), '登录后跳转到编辑器: ' + page.url());
await shot('04-editor.png');

console.log('编辑器交互');
const hasSidebar = await page.locator('.sidebar').count();
check(hasSidebar === 1, '左侧仓库侧栏渲染');
const modeCount = await page.locator('.mode-switch__item').count();
check(modeCount === 4, '四种编辑模式按钮: ' + modeCount);

// 命令面板
await page.keyboard.press('Control+p');
await page.waitForSelector('.palette', { timeout: 6000 }).catch(() => null);
check(await page.locator('.palette').count() === 1, 'Ctrl+P 打开命令面板');
await shot('05-command-palette.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 全库搜索
await page.keyboard.press('Control+Shift+F');
await page.waitForSelector('.search-panel', { timeout: 6000 }).catch(() => null);
check(await page.locator('.search-panel').count() === 1, 'Ctrl+Shift+F 打开全库搜索');
await shot('06-search.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 设置
await page.keyboard.press('Control+,');
await page.waitForSelector('.settings', { timeout: 6000 }).catch(() => null);
check(await page.locator('.settings').count() === 1, 'Ctrl+, 打开设置');
const navCount = await page.locator('.settings__nav-item').count();
check(navCount === 8, '设置分组数量: ' + navCount);
await shot('07-settings.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 新建并编辑文档
await page.keyboard.press('Control+n');
await page.waitForTimeout(1200);
const inputDlg = await page.locator('.modal .nm-input').count();
if (inputDlg > 0) {
  await page.fill('.modal .nm-input', '自动化验证文档');
  await page.locator('.modal .nm-btn--primary').click();
  await page.waitForTimeout(1800);
}
check(await page.locator('.ProseMirror').count() === 1, '新建文档后编辑器可用');
await page.locator('.ProseMirror').click();
await page.keyboard.type('# 自动化验证\n\n这是通过浏览器自动化写入的内容。\n\n- 列表项一\n- 列表项二\n');
await page.waitForTimeout(1200);
const editorText = await page.textContent('.ProseMirror');
check(editorText.includes('自动化验证'), '所见即所得输入生效');
await shot('08-doc-edit.png');

// 切换源码模式
await page.locator('.mode-switch__item', { hasText: '源码' }).click();
await page.waitForTimeout(1200);
check(await page.locator('.cm-editor').count() === 1, '切换到源码模式');
const cmText = await page.textContent('.cm-editor');
check(cmText.includes('自动化验证'), '源码模式保留内容');
await shot('09-source-mode.png');

// 对照模式
await page.locator('.mode-switch__item', { hasText: '对照' }).click();
await page.waitForTimeout(1200);
check(await page.locator('.compare').count() === 1, '切换到对照模式');
const previewHtml = await page.locator('.compare__body--preview').innerHTML();
check(previewHtml.includes('<h1'), '对照模式预览已渲染标题');
await shot('10-compare-mode.png');

// 阅读模式
await page.locator('.mode-switch__item', { hasText: '阅读' }).click();
await page.waitForTimeout(1000);
check(await page.locator('.read-view').count() === 1, '切换到阅读模式');
await shot('11-read-mode.png');

// 页宽铺满
await page.locator('.mode-switch__item', { hasText: '所见即所得' }).click();
await page.waitForTimeout(600);

console.log('后台管理');
await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
check(page.url().includes('/admin'), '管理员可进入后台');
const statCards = await page.locator('.stat-card').count();
check(statCards >= 8, '概览统计卡片: ' + statCards);
await shot('12-admin-overview.png');
await page.locator('.nav-item', { hasText: '用户' }).click();
await page.waitForTimeout(1500);
check(await page.locator('.table tbody tr').count() > 0, '用户列表有数据');
await shot('13-admin-users.png');

console.log('分享页');
const shareToken = await page.evaluate(async () => {
  const token = localStorage.getItem('neomd.access');
  const res = await fetch('/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({
      docId: 'browser-smoke',
      title: '浏览器验证分享文档',
      markdown: '# 浏览器验证\n\n这是用于验证分享页的**正文**内容。\n\n- 要点一\n- 要点二\n',
      mode: 'comment',
      allowComment: true,
    }),
  });
  const json = await res.json();
  return json.data ? json.data.token : null;
});
check(Boolean(shareToken), '创建分享链接');

if (shareToken) {
  const pub = await ctx.newPage();
  await pub.goto(BASE + '/s/' + shareToken, { waitUntil: 'networkidle', timeout: 30000 });
  await pub.waitForTimeout(1500);
  check((await pub.textContent('.share-doc__title'))?.includes('浏览器验证'), '分享页标题正确');
  check((await pub.locator('.share-doc__body h1').count()) === 1, '分享页正文渲染');
  check((await pub.locator('.share-comments').count()) === 1, '分享页评论区渲染');
  await pub.screenshot({ path: path.join(shots, '14-share-page.png') });
  await pub.close();
}

console.log('\n控制台错误: ' + (errors.length ? errors.slice(0, 5).join(' | ') : '无'));
console.log(`结果：${pass} 通过，${fail} 失败`);

await browser.close();
process.exit(fail === 0 ? 0 : 1);
