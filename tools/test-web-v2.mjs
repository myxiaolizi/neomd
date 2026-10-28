/**
 * Neo MD 浏览器端到端全量验证（对线上站点）。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
const { chromium } = playwright;
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-v2');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'https://md.zhengl.vip';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

async function shot(name) {
  await page.screenshot({ path: path.join(shots, name) });
}

/* 1. 下载可用性 */
console.log('下载');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
const dlList = await page.evaluate(async (base) => {
  const r = await fetch(base + '/api/download/list');
  return r.json();
}, BASE);
check(dlList.ok && dlList.data.files.length === 3, '下载清单返回 3 个文件');
for (const f of dlList.data.files) {
  const res = await page.request.get(f.url, { maxRedirects: 0 });
  const status = res.status();
  check([200, 302].includes(status), `${f.file} 可下载 (HTTP ${status})`);
}

/* 2. 商务首页与同类产品对比表格 */
console.log('首页');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
check((await page.locator('.hero__title').textContent()).includes('Markdown'), '商务化首页标题正确');
check((await page.locator('.compare-table tbody tr').count()) >= 5, '同类产品横向对比表格渲染');
check((await page.locator('.dl-card').count()) >= 3, '下载卡片渲染');
await shot('01-home.png');

/* 3. 登录与首页用户名下拉菜单 */
console.log('登录');
await page.locator('.nav__actions button', { hasText: '登录' }).first().click();
await page.waitForSelector('.modal', { timeout: 8000 });
await page.fill('#login-account', 'admin');
await page.fill('#login-password', '6655');
await page.locator('.modal .nm-btn--primary').click();
await page.waitForURL('**/app', { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(2500);
check(page.url().includes('/app'), '登录成功进入编辑器');
check((await page.title()) === 'Neo MD-工作台', `工作台标题正确 (${await page.title()})`);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('.nav__user').click();
await page.waitForTimeout(300);
const dropTexts = await page.locator('.nav__drop-item').allTextContents();
check(dropTexts.some((t) => t.includes('用户中心')) && dropTexts.some((t) => t.includes('退出登录')), '首页点击用户名弹出「用户中心 / 退出登录」下拉');
await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await shot('02-editor.png');

/* 4. 编辑器：统一工具栏（H1/H2/H3 文本图标）与快捷键 */
console.log('快捷键与统一工具栏');
await page.keyboard.press('Control+n');
await page.waitForTimeout(1000);
const dlgInput = page.locator('.modal .nm-input');
if (await dlgInput.count()) {
  await dlgInput.fill('全量验证文档');
  await page.locator('.modal .nm-btn--primary').click();
  await page.waitForTimeout(1800);
}
const editor = page.locator('.ProseMirror');
check(await editor.count() === 1, '新建文档并进入编辑器');
const hBtns = await page.locator('.editorbar__mid .tbtn__h').allTextContents();
check(hBtns.includes('H1') && hBtns.includes('H2') && hBtns.includes('H3'), '正文工具栏标题按钮以 H1/H2/H3 显示');
await editor.click();
await page.keyboard.type('测试正文');
await page.keyboard.press('Enter');
await page.keyboard.press('Control+1');
await page.waitForTimeout(600);
check((await page.locator('.ProseMirror h1').count()) > 0, 'Ctrl+1 生效（生成了 H1）');
await page.keyboard.press('Control+2');
await page.waitForTimeout(600);
check((await page.locator('.ProseMirror h2').count()) > 0, 'Ctrl+2 生效（生成了 H2）');
await shot('03-shortcuts.png');

/* 5. 命令面板（仅正文编辑命令）与页宽切换 */
await page.keyboard.press('Control+p');
await page.waitForTimeout(500);
const cmdTexts = await page.locator('.cmd-item').allTextContents();
check(cmdTexts.length > 5 && !cmdTexts.some((t) => t.includes('立即同步')), '命令面板仅保留正文编辑相关命令（不含文件同步等）');
await page.locator('.cmd-item', { hasText: '切换正文页宽' }).click();
await page.waitForTimeout(500);
const afterWidth = await page.locator('.shell__content').evaluate((el) => el.className);
check(afterWidth.includes('nm-page-'), `页宽切换生效 (${afterWidth})`);

/* 6. 视图下拉 Ctrl+E */
const modeBefore = await page.locator('.viewswitch__btn').getAttribute('title');
await page.keyboard.press('Control+e');
await page.waitForTimeout(700);
const modeAfter = await page.locator('.viewswitch__btn').getAttribute('title');
check(modeBefore !== modeAfter, `Ctrl+E 切换视图 (${modeBefore} → ${modeAfter})`);
await page.locator('.viewswitch__btn').click();
await page.waitForTimeout(400);
check((await page.locator('.viewswitch__menu').count()) === 1, '视图下拉菜单可打开');
await page.locator('.viewswitch__item', { hasText: '所见即所得' }).click();
await page.waitForTimeout(600);

/* 7. AI 面板（输入框内模型选择 + 带正文内容选项 + 可关闭） */
console.log('AI 面板');
await page.keyboard.press('Control+Shift+A');
await page.waitForTimeout(1000);
check((await page.locator('.ai').count()) === 1, 'AI 侧边栏可打开');
check((await page.locator('.ai__box-bar .modelpick__btn').count()) === 1, 'AI 模型选择器位于输入框内');
check((await page.locator('.ai__box-bar .ctx-toggle').count()) === 1, 'AI 输入框内含「带正文内容」选项');
await shot('05-ai-panel.png');
await page.locator('.ai__close').click();
await page.waitForTimeout(600);
check((await page.locator('.ai').count()) === 0, 'AI 侧边栏可关闭');

/* 8. 标签页高度与右键菜单 */
console.log('标签页');
const tabH = await page.locator('.tabbar').evaluate((el) => el.getBoundingClientRect().height);
check(Math.abs(tabH - 50) <= 2, `标签栏高度约 50px（实测 ${tabH}）`);
await page.locator('.tab').first().click({ button: 'right' });
await page.waitForTimeout(500);
check((await page.locator('.tabmenu').count()) === 1, '标签页右键菜单出现');
const menuItems = await page.locator('.tabmenu__item').allTextContents();
check(menuItems.some((t) => t.includes('锁定')), '菜单含「锁定阅读视图」');
check(menuItems.some((t) => t.includes('关闭其他')), '菜单含「关闭其他」');
check(menuItems.some((t) => t.includes('复制路径')), '菜单含「复制路径」');
await page.keyboard.press('Escape');
await page.mouse.click(700, 400);
await page.waitForTimeout(400);

/* 9. 左侧栏顶部工具栏与文件右键菜单（重命名与移动拆分） */
console.log('左侧栏与文件菜单');
await page.locator('.leftpanel__tools .act[title*="新建文档"]').click();
await page.waitForTimeout(1000);
const dlg2 = page.locator('.modal .nm-input');
if (await dlg2.count()) {
  await dlg2.fill('第二篇');
  await page.locator('.modal .nm-btn--primary').click();
  await page.waitForTimeout(1400);
}
const fileRow = page.locator('.leftpanel__body .file-row').first();
await fileRow.click({ button: 'right' });
await page.waitForTimeout(500);
check((await page.locator('.docmenu').count()) === 1, '文件列表右键菜单出现');
const docMenuTexts = await page.locator('.docmenu__item').allTextContents();
check(
  docMenuTexts.some((t) => t.trim() === '重命名') && docMenuTexts.some((t) => t.includes('移动至文件夹')),
  '文件右键菜单中「重命名」与「移动至文件夹」独立分离',
);
await page.locator('.docmenu__item', { hasText: '重命名' }).click();
await page.waitForTimeout(500);
check((await page.locator('.rename-quick').count()) === 1, '重命名弹窗支持添加日期与 AI 智能命名');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

/* 10. 最近打开与全部文件去重 + 状态栏文件路径与复制字数 */
const recentTitles = await page.locator('.leftpanel__body .group-label').allTextContents();
check(recentTitles.some((t) => t.includes('最近打开')), '存在「最近打开」分组');
check((await page.locator('.statusbar .st--path').count()) === 1, '状态栏显示当前文档路径且可点击');
check((await page.locator('.statusbar .st[title="切换左侧面板"]').count()) === 0, '底部状态栏不重复显示侧栏收起按钮');

/* 11. 排序与多仓库 */
console.log('排序与多仓库');
check((await page.locator('.vaultpick__btn').count()) === 1, '左上角支持多仓库切换下拉');
await page.locator('.leftpanel__tools .act[title="排序方式"]').click();
await page.waitForTimeout(400);
check((await page.locator('.popmenu__item').count()) === 6, '文件排序菜单提供 6 种排序（修改时间/创建时间/文件名 升降序）');
await page.locator('.popmenu__item', { hasText: '文件名（A → Z）' }).click();
await page.waitForTimeout(400);
await page.locator('.ProseMirror').click({ button: 'right' });
await page.waitForTimeout(400);
check((await page.locator('.editor-ctxmenu').count()) === 1, '编辑器正文右键菜单出现');
await page.mouse.click(700, 200);
await page.waitForTimeout(300);

/* 12. 个人中心（动态标题、分享列表修复、对象存储、AI 平台积分供应商、插件开放平台） */
console.log('个人中心');
await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
check((await page.title()) === 'Neo MD-个人中心', `个人中心页面标题正确 (${await page.title()})`);
check((await page.locator('.account__tab').count()) === 7, '个人中心 7 个分组');
check((await page.locator('input[type="file"][accept="image/*"]').count()) === 1, '个人资料支持图片文件上传头像');
await shot('08-account.png');

await page.locator('.account__tab', { hasText: 'AI 服务配置' }).click();
await page.waitForTimeout(800);
const aiProvidersText = await page.locator('.providers').textContent();
check(aiProvidersText.includes('平台积分'), 'AI 服务支持选择「平台积分」作为供应商');

await page.locator('.account__tab', { hasText: '分享、发布与样式' }).click();
await page.waitForTimeout(1200);
check((await page.locator('.panel').textContent()).includes('我的分享链接'), '个人中心分享与发布列表正常渲染');
await shot('10-account-shares.png');

await page.locator('.account__tab', { hasText: '插件市场与开放平台' }).click();
await page.waitForTimeout(1200);
check((await page.locator('.pcard').count()) >= 24, '插件市场与开放平台列表渲染');
await shot('10b-account-plugins.png');

/* 13. 管理后台（动态标题、兑换码生成不空白、多计费方式与赠送、分享内联评价） */
console.log('管理后台');
await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
check((await page.title()) === 'Neo MD-管理后台', `管理后台标题正确 (${await page.title()})`);
check((await page.locator('.nav-item').count()) >= 10, '后台菜单项 ≥10');
check((await page.locator('.stat-card').count()) >= 8, '概览统计卡渲染');
check((await page.locator('input[placeholder*="新的管理员密码"]').count()) === 0, '概览页已移除独立管理员密码框（密码跟随用户）');
await shot('11-admin-overview.png');

await page.locator('.nav-item', { hasText: '积分与兑换码' }).click();
await page.waitForTimeout(1200);
await page.locator('button', { hasText: '生成' }).click();
await page.waitForTimeout(1200);
check((await page.locator('pre.codes').count()) === 1, '点击生成兑换码后正常显示生成的兑换码且页面不空白');
await shot('12-admin-credits.png');

await page.locator('.nav-item', { hasText: 'AI 供应商与优先级' }).click();
await page.waitForTimeout(1200);
check((await page.locator('.table tbody tr').count()) >= 7, 'AI 供应商与优先级列表 7 家');
await shot('13-admin-ai.png');

await page.locator('.nav-item', { hasText: '计费、模型与赠送' }).click();
await page.waitForTimeout(1200);
check((await page.locator('.grant-grid .field-box').count()) === 3, '计费页支持设置新用户默认赠送积分与每日赠送积分');
check((await page.locator('.mono-area').count()) === 2, '计费页含多计费方式与支付方式编辑');
await shot('14-admin-billing.png');

await page.locator('.nav-item', { hasText: '分享与内容评价' }).click();
await page.waitForTimeout(1200);
const shareLinks = await page.locator('.row-btn', { hasText: '打开链接' }).count();
check(shareLinks > 0, `分享列表有可点击链接且支持内联管理评价 (${shareLinks} 条)`);
await shot('16-admin-shares.png');

console.log('\n控制台错误: ' + (errors.length ? errors.slice(0, 3).join(' | ') : '无'));
console.log(`结果：${pass} 通过，${fail} 失败`);

await browser.close();
process.exit(fail === 0 ? 0 : 1);
