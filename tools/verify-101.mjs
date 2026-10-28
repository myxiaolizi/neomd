/**
 * 1.0.1 版本关键项本地实测脚本。
 *
 * 目的：对「本地 vite preview 产物」做真实浏览器验证，而不是只读源码。
 * 覆盖：
 *   1) 登录 → 进入编辑器
 *   2) 页宽四档是否真的改变正文容器宽度（narrow/standard/wide/full 递进）
 *   3) 工具栏按钮顺序是否为「历史版本 → 页宽 → 视图」
 *   4) 新建文档是否免弹窗、自动命名并直接进入编辑
 *   5) 右键菜单是否含「粘贴为纯文本」
 *   6) 自动保存按钮是否为新设计（非历史图标）
 *   7) 设置弹窗是否已无「插件」页签、且新增「插件中心」入口可达
 *
 * 用法：node tools/verify-101.mjs            （默认 http://127.0.0.1:4173）
 *      SMOKE_BASE=http://127.0.0.1:4173 node tools/verify-101.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-101');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4173';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label + (extra ? ` → ${extra}` : ''));
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
const httpErrors = [];
/**
 * 本地 vite preview 没有后端进程，浏览器对 `/api/*` 的失败只会输出
 * 一条不带 URL 的 `Failed to load resource: ... 500`。这类噪声与产品缺陷无关
 * （线上由 Fastify 提供接口），因此仅在没有对应真实 4xx/5xx 网络请求时豁免。
 */
let knownNoise = 0;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text().slice(0, 200);
  if (t.includes('/api/')) return;
  if (t.startsWith('Failed to load resource:') && httpErrors.length === 0 && knownNoise === 0) {
    knownNoise += 1;
    console.log('    (忽略本地无后端产生的 1 条资源加载噪声)');
    return;
  }
  consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));
page.on('response', (r) => {
  // 本地 vite preview 不挂后端，`/api/*` 必然失败，不算产品缺陷（线上由 Fastify 提供）。
  if (r.status() >= 400 && !r.url().includes('/api/')) {
    httpErrors.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`);
  }
});
page.on('requestfailed', (r) => {
  if (!r.url().includes('/api/')) httpErrors.push(`FAILED ${r.url().slice(0, 160)} ${r.failure()?.errorText}`);
});

try {
  /* ---------------- 1. 登录 ---------------- */
  console.log('\n[1] 登录并进入编辑器');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
  await shot(page, '01-home');

  const needsLogin = await page.locator('#login-account').count();
  if (needsLogin) {
    await page.fill('#login-account', 'admin');
    await page.fill('#login-password', '6655');
    await page.locator('button[type="submit"], .login__submit, button:has-text("登录")').first().click();
    await page.waitForTimeout(2500);
  }
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);
  await shot(page, '02-app');
  const inApp = await page.locator('.shell, .editorbar, .tabbar').first().count();
  check(inApp > 0, '进入编辑器工作区', inApp ? '' : '未找到 .shell/.editorbar/.tabbar');

  // 首次进入可能没有打开任何文档，工具栏（.editorbar）只在有活动标签时渲染
  if (!(await page.locator('.editorbar').count())) {
    const emptyNew = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await emptyNew.count()) {
      await emptyNew.click();
      await page.waitForTimeout(2200);
    }
  }
  check((await page.locator('.editorbar').count()) > 0, '打开文档后工具栏渲染');

  /* ---------------- 2. 工具栏顺序：历史 → 页宽 → 视图 ---------------- */
  console.log('\n[2] 工具栏按钮顺序');
  const order = await page.evaluate(() => {
    const bar = document.querySelector('.editorbar');
    if (!bar) return null;
    const kids = Array.from(bar.querySelectorAll('[title]'));
    return kids.map((n) => n.getAttribute('title') || '');
  });
  if (order) {
    const iHist = order.findIndex((t) => t.includes('历史版本'));
    const iWidth = order.findIndex((t) => t.includes('页宽'));
    const iView = order.findIndex((t) => t.includes('编辑模式'));
    check(iHist >= 0, '存在「历史版本」按钮', `index=${iHist}`);
    check(iWidth >= 0, '存在「页宽」按钮', `index=${iWidth}`);
    check(iView >= 0, '存在「编辑模式」按钮', `index=${iView}`);
    check(iHist < iWidth && iWidth < iView, '顺序为 历史版本 → 页宽 → 编辑模式', `实际 ${iHist}/${iWidth}/${iView}`);
  } else {
    check(false, '读取工具栏失败');
  }

  /* ---------------- 3. 页宽四档真实生效 ---------------- */
  console.log('\n[3] 页宽设置生效');
  // 先把窗口调宽，让 620/760/1080 三档差异明显
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(400);

  const widthBtn = page.locator('.widthswitch .viewswitch__btn').first();
  const hasWidthBtn = await widthBtn.count();
  check(hasWidthBtn > 0, '页宽下拉按钮存在');

  if (hasWidthBtn) {
    const measured = {};
    for (const label of ['窄', '标准', '宽', '铺满']) {
      await widthBtn.click();
      await page.waitForTimeout(200);
      const item = page.locator('.widthswitch .viewswitch__item', { hasText: label }).first();
      const cnt = await item.count();
      if (!cnt) {
        measured[label] = null;
        continue;
      }
      await item.click();
      await page.waitForTimeout(500);
      const w = await page.evaluate(() => {
        const el = document.querySelector('.shell__content');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { width: Math.round(r.width), maxWidth: cs.maxWidth, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight };
      });
      measured[label] = w;
      await shot(page, `03-width-${label}`);
    }
    console.log('    实测容器宽度：', JSON.stringify(measured));
    const wn = measured['窄']?.width ?? 0;
    const ws = measured['标准']?.width ?? 0;
    const ww = measured['宽']?.width ?? 0;
    const wf = measured['铺满']?.width ?? 0;
    check(wn > 0 && wn <= 660, '窄档 ≈620px', `${wn}px`);
    check(ws > wn && ws <= 800, '标准档 ≈760px 且大于窄档', `${ws}px`);
    check(ww > ws && ww <= 1120, '宽档 ≈1080px 且大于标准档', `${ww}px`);
    check(wf > ww, '铺满档比宽档更宽', `${wf}px`);
    // 铺满不应出现 10px 特例内边距
    const fullPad = measured['铺满']?.paddingLeft;
    check(fullPad !== '10px', '铺满档内边距不是 10px 特例', `paddingLeft=${fullPad}`);
  }

  /* ---------------- 4. 新建文档免弹窗 ---------------- */
  console.log('\n[4] 新建文档免弹窗 + 自动命名');
  const beforeTabs = await page.locator('.tab').count();
  await page.locator('.editorbar button[title*="新建文档"]').first().click();
  await page.waitForTimeout(1800);
  const afterTabs = await page.locator('.tab').count();
  const dialogVisible = await page.locator('.nm-modal, .inputdialog, [role="dialog"]').count();
  check(afterTabs > beforeTabs, '点击新建后新增了标签页', `${beforeTabs} → ${afterTabs}`);
  check(dialogVisible === 0, '新建未弹出文件名输入框', `找到 ${dialogVisible} 个对话框`);
  const newTitle = await page.locator('.tab.is-active .tab__title').first().textContent().catch(() => '');
  check(Boolean(newTitle && newTitle.trim()), '新标签有自动生成的名称', String(newTitle));
  await shot(page, '04-newdoc');

  /* ---------------- 5. 右键菜单含「粘贴为纯文本」 ---------------- */
  console.log('\n[5] 右键纯文本粘贴');
  const editorArea = page.locator('.shell__content').first();
  if (await editorArea.count()) {
    await editorArea.click({ button: 'right', position: { x: 200, y: 120 } });
    await page.waitForTimeout(500);
    const menuItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.editor-ctxmenu__item')).map((n) => (n.textContent || '').trim()),
    );
    check(menuItems.length > 0, '右键菜单已弹出', `${menuItems.length} 项`);
    check(
      menuItems.some((t) => t.includes('纯文本')),
      '菜单含「粘贴为纯文本」',
      menuItems.slice(0, 8).join(' | '),
    );
    await shot(page, '05-ctxmenu');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 400);
  } else {
    check(false, '未找到正文区域');
  }

  /* ---------------- 6. 自动保存按钮设计 ---------------- */
  console.log('\n[6] 自动保存按钮');
  const autoBtn = page.locator('.autosave, button[title*="自动保存"]').first();
  const hasAuto = await autoBtn.count();
  check(hasAuto > 0, '存在自动保存按钮');
  if (hasAuto) {
    const info = await autoBtn.evaluate((el) => ({
      text: (el.textContent || '').trim(),
      aria: el.getAttribute('role'),
      hasTrack: Boolean(el.querySelector('.autosave__track')),
      title: el.getAttribute('title'),
    }));
    console.log('    按钮信息：', JSON.stringify(info));
    // 新设计要求：有清晰的文字状态，不再是一个无文字的开关轨道
    check(Boolean(info.text && info.text.trim()), '按钮带可见文字状态', info.text);
  }

  /* ---------------- 7. 设置无插件页签 / 插件中心可达 ---------------- */
  console.log('\n[7] 设置弹窗与插件中心');
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1200);
  const tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.nm-modal .tabs__item, .settings .tabs__item, [role="tab"]'))
      .map((n) => (n.textContent || '').trim())
      .filter(Boolean),
  );
  console.log('    设置页签：', tabLabels.join(' / '));
  check(!tabLabels.includes('插件'), '设置弹窗中已无「插件」页签', tabLabels.join('/'));
  await shot(page, '07-settings');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const pluginEntry = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[title]'));
    return nodes
      .filter((n) => (n.getAttribute('title') || '').includes('插件'))
      .map((n) => n.getAttribute('title'));
  });
  check(pluginEntry.length > 0, '界面存在「插件中心」入口', pluginEntry.join(' | '));

  check(httpErrors.length === 0, '无 4xx/5xx 网络错误', httpErrors.slice(0, 3).join(' ; '));
  check(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 3).join(' ; '));
} catch (e) {
  check(false, '脚本执行异常', String(e && e.message ? e.message : e).slice(0, 300));
  await shot(page, '99-error');
} finally {
  await browser.close();
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
console.log(`截图目录：${shots}`);
process.exit(fail === 0 ? 0 : 1);
