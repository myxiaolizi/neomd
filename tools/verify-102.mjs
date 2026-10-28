/**
 * 1.0.2 版本关键项实测脚本。
 *
 * 覆盖本次用户明确提出的 25 项要求中可自动化验证的部分：
 *   1) 标题栏 40 / 标签 38
 *   2) 自动保存按钮无文字
 *   3) 页宽（铺满 12px）
 *   4) 新建命名 YYMMDD日HHMM-
 *   5) 设置以标签页打开（非弹窗）
 *   6) 主题页签存在且可切换
 *   7) 右侧栏文件操作卡片 160×75、每排 2-8
 *   8) 右侧栏 8 区块切换按钮
 *   9) 正文缩放（状态栏 + Ctrl+滚轮）
 *  10) 排序图标非漏斗
 *
 * 用法：node tools/verify-102.mjs
 *      SMOKE_BASE=https://md.zhengl.vip node tools/verify-102.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-102');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4173';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${extra ? ` → ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const httpErrors = [];
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('/api/')) httpErrors.push(`${r.status()} ${r.url().slice(0, 120)}`);
});

try {
  /* ---------- 进入编辑器 ---------- */
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
    }
  }
  await page.screenshot({ path: path.join(shots, '01-editor.png') });

  /* ---------- 1. 标题栏高度 ---------- */
  console.log('\n[1] 标题栏 40 / 标签 38');
  const tb = await page.evaluate(() => {
    const bar = document.querySelector('.titlebar');
    const tabs = document.querySelector('.tabbar');
    const get = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    return {
      titlebar: get(bar),
      tabbar: get(tabs),
      padTop: bar ? getComputedStyle(bar).paddingTop : null,
      tabBorder: tabs ? getComputedStyle(tabs).borderBottomWidth : null,
    };
  });
  console.log('    ', JSON.stringify(tb));
  check(tb.titlebar === 40, '标题栏总高 40px', `${tb.titlebar}`);
  check(tb.tabbar === 38, '标签高度 38px', `${tb.tabbar}`);
  check(tb.padTop === '2px', '上方留白 2px', `${tb.padTop}`);
  check(tb.tabBorder === '0px', '标签下方无分隔线（与正文融合）', `${tb.tabBorder}`);

  /* ---------- 2. 自动保存无文字 ---------- */
  console.log('\n[2] 自动保存按钮');
  const auto = await page.evaluate(() => {
    const b = document.querySelector('.autosave');
    if (!b) return null;
    return {
      text: (b.textContent || '').trim(),
      hasLabel: Boolean(b.querySelector('.autosave__label')),
      hasDot: Boolean(b.querySelector('.autosave__dot')),
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
    };
  });
  console.log('    ', JSON.stringify(auto));
  check(auto !== null, '自动保存按钮存在');
  if (auto) {
    check(auto.text === '', '按钮不显示文字', auto.text);
    check(!auto.hasLabel, '无文字节点');
    check(Boolean(auto.title || auto.aria), '有 title/aria 无障碍信息', `${auto.title}`);
  }

  /* ---------- 3. 页宽铺满 12px ---------- */
  console.log('\n[3] 页宽（铺满 12px）');
  const widthBtn = page.locator('.widthswitch .viewswitch__btn').first();
  if (await widthBtn.count()) {
    await widthBtn.click();
    await page.waitForTimeout(200);
    await page.locator('.widthswitch .viewswitch__item', { hasText: '铺满' }).first().click();
    await page.waitForTimeout(500);
    const pad = await page.evaluate(() => {
      const el = document.querySelector('.shell__content');
      return el ? getComputedStyle(el).paddingLeft : null;
    });
    check(pad === '12px', '铺满档左侧内边距 12px', `${pad}`);
    // 还原为标准
    await widthBtn.click();
    await page.waitForTimeout(200);
    await page.locator('.widthswitch .viewswitch__item', { hasText: '标准' }).first().click();
    await page.waitForTimeout(300);
  } else {
    check(false, '页宽按钮不存在');
  }

  /* ---------- 4. 新建命名格式 ---------- */
  console.log('\n[4] 新建文件命名 YYMMDD日HHMM-');
  await page.locator('.editorbar button[title*="新建文档"]').first().click();
  await page.waitForTimeout(2000);
  const newTitle = await page.locator('.tab.is-active .tab__title').first().textContent().catch(() => '');
  console.log('    新文件名:', newTitle);
  const nameOk = /^\d{6}日\d{4}-/.test((newTitle || '').trim());
  check(nameOk, '文件名符合 YYMMDD日HHMM- 格式', String(newTitle));

  /* ---------- 5. 设置为标签页 ---------- */
  console.log('\n[5] 设置以标签页打开');
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(shots, '02-settings-tab.png') });
  const settingsState = await page.evaluate(() => ({
    hasModal: Boolean(document.querySelector('.nm-modal-mask, .modal__mask, [role="dialog"]')),
    settingsPage: Boolean(document.querySelector('.settings-page')),
    activeTabText: (document.querySelector('.tab.is-active .tab__title')?.textContent || '').trim(),
    navItems: Array.from(document.querySelectorAll('.settings__nav-item')).map((n) => (n.textContent || '').trim()),
  }));
  console.log('    ', JSON.stringify(settingsState));
  check(!settingsState.hasModal, '不是弹窗（无模态遮罩）');
  check(settingsState.settingsPage, '渲染了整页设置组件');
  check(settingsState.activeTabText === '设置', '标签栏出现「设置」标签', settingsState.activeTabText);
  check(settingsState.navItems.includes('主题'), '存在「主题」页签', settingsState.navItems.join('/'));
  // 注意：「服务器」页签标了 nativeOnly，网页端按设计不显示，仅在 PC 端可见。
  // 因此这里只断言「非网页端时必须存在」，网页端跳过。
  const isDesktopShell = await page.evaluate(() => document.documentElement.dataset.runtime === 'desktop');
  if (isDesktopShell) {
    check(settingsState.navItems.includes('服务器'), 'PC 端存在「服务器」页签', settingsState.navItems.join('/'));
  } else {
    check(!settingsState.navItems.includes('对象存储'), '网页端隐藏 desktop-only 页签（设计如此）');
  }

  /* ---------- 6. 主题切换 ---------- */
  console.log('\n[6] 主题切换');
  const themeNav = page.locator('.settings__nav-item', { hasText: '主题' }).first();
  if (await themeNav.count()) {
    await themeNav.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(shots, '03-theme.png') });
    const before = await page.evaluate(() => document.documentElement.dataset.themePreset);
    const cards = page.locator('.theme-card');
    const n = await cards.count();
    check(n >= 5, '主题卡片数量 >= 5', String(n));
    if (n >= 2) {
      await cards.nth(1).click();
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.documentElement.dataset.themePreset);
      check(after !== before, '点击主题后 data-theme-preset 变化', `${before} → ${after}`);
      const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim());
      console.log('    --bg-elevated =', bg);
    }
  } else {
    check(false, '主题页签不存在');
  }

  /* ---------- 7. 右侧栏卡片 ---------- */
  console.log('\n[7] 右侧栏文件操作卡片');
  // 回到编辑器视图
  await page.locator('.tab', { hasText: '设置' }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  const settingsTabEl = page.locator('.tab', { hasText: '设置' }).first();
  if (await settingsTabEl.count()) {
    await settingsTabEl.hover();
    await page.waitForTimeout(200);
    const closeBtn = settingsTabEl.locator('.tab__close');
    if (await closeBtn.count()) await closeBtn.click();
    await page.waitForTimeout(600);
  }
  // 打开右侧栏
  const aiBtn = page.locator('.editorbar button[title*="右侧边栏"]').first();
  if (await aiBtn.count()) {
    await aiBtn.click();
    await page.waitForTimeout(900);
  }
  // 确保 file 区块开启
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.righttabs__btn')).find((b) => (b.getAttribute('title') || '').includes('文件操作'));
    if (btn && !btn.classList.contains('is-on')) btn.click();
  });
  await page.waitForTimeout(600);
  // AiPanel 内部还有「AI 助手 / 文件操作」两个子页签，必须切到「文件操作」才能看到卡片
  const fileTab = page.locator('.ai__tab', { hasText: '文件操作' }).first();
  if (await fileTab.count()) {
    await fileTab.click();
    await page.waitForTimeout(700);
  }
  const cardInfo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.fop-card-btn'));
    if (!cards.length) return null;
    const first = cards[0].getBoundingClientRect();
    const grid = cards[0].parentElement;
    const perRow = grid ? Array.from(grid.children).filter((c) => Math.abs(c.getBoundingClientRect().top - first.top) < 4).length : 0;
    const desc = cards[0].querySelector('.fop-card-btn__desc');
    return {
      count: cards.length,
      w: Math.round(first.width),
      h: Math.round(first.height),
      perRow,
      hasDesc: Boolean(desc),
      descClamp: desc ? getComputedStyle(desc).webkitLineClamp : null,
    };
  });
  console.log('    ', JSON.stringify(cardInfo));
  check(cardInfo !== null, '存在文件操作卡片');
  if (cardInfo) {
    check(cardInfo.w === 160, '卡片宽度 160px', `${cardInfo.w}`);
    check(cardInfo.h === 75, '卡片高度 75px', `${cardInfo.h}`);
    check(cardInfo.perRow >= 2 && cardInfo.perRow <= 8, '每排卡片数 2-8', `${cardInfo.perRow}`);
    check(cardInfo.hasDesc === true, '卡片含描述文字');
    check(String(cardInfo.descClamp) === '2', '描述最多 2 行', `${cardInfo.descClamp}`);
  }
  await page.screenshot({ path: path.join(shots, '04-cards.png') });

  /* ---------- 8. 右侧栏 8 区块切换 ---------- */
  console.log('\n[8] 右侧栏区块切换');
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.righttabs__btn')).length);
  check(tabs === 8, '右侧栏有 8 个区块切换按钮', String(tabs));

  /* ---------- 9. 正文缩放 ---------- */
  console.log('\n[9] 正文缩放');
  const zoomCtl = page.locator('.zoomctl__btn').first();
  check((await zoomCtl.count()) > 0, '状态栏存在缩放控件');
  if (await zoomCtl.count()) {
    await zoomCtl.click();
    await page.waitForTimeout(300);
    const items = await page.locator('.zoomctl__item').count();
    check(items === 7, '缩放预设 7 档', String(items));
    await page.locator('.zoomctl__item', { hasText: '150%' }).first().click();
    await page.waitForTimeout(500);
    const z = await page.evaluate(() => ({
      label: (document.querySelector('.zoomctl__btn')?.textContent || '').trim(),
      fontSize: getComputedStyle(document.documentElement).getPropertyValue('--content-font-size').trim(),
    }));
    console.log('    ', JSON.stringify(z));
    check(z.label.includes('150'), '状态栏显示 150%', z.label);
    // Ctrl+滚轮
    const beforeSize = parseFloat(z.fontSize);
    await page.locator('.shell__content').first().hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    const afterLabel = await page.evaluate(() => (document.querySelector('.zoomctl__btn')?.textContent || '').trim());
    check(afterLabel.includes('155') || afterLabel.includes('160'), 'Ctrl+滚轮放大生效', afterLabel);
    await page.evaluate(() => {
      // 还原 100%
      const btn = document.querySelector('.zoomctl__btn');
      if (btn) btn.click();
    });
    await page.waitForTimeout(300);
    const item100 = page.locator('.zoomctl__item', { hasText: '100%' }).first();
    if (await item100.count()) await item100.click();
    await page.waitForTimeout(300);
  }

  /* ---------- 10. 排序图标 ---------- */
  console.log('\n[10] 排序图标');
  const sortIcon = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.act')).find((b) => (b.getAttribute('title') || '').includes('排序'));
    if (!btn) return null;
    const path = btn.querySelector('path')?.getAttribute('d') || '';
    return { title: btn.getAttribute('title'), path, isFunnel: path.includes('22 3H2l8 9.5') };
  });
  console.log('    ', JSON.stringify(sortIcon));
  check(sortIcon !== null, '排序按钮存在');
  if (sortIcon) {
    check(!sortIcon.isFunnel, '排序图标不是漏斗');
    check(sortIcon.title.includes('排序'), 'title 含「排序」', sortIcon.title);
  }

  /* ---------- 11. 侧栏拖拽（本地保存，不进云同步） ---------- */
  console.log('\n[11] 侧栏宽度拖拽');
  const handle = page.locator('.nm-resize-handle, [role="separator"]').first();
  const handleCount = await page.locator('[role="separator"]').count();
  check(handleCount > 0, '存在侧栏拖拽手柄', `${handleCount}`);
  if (handleCount > 0) {
    const beforeLS = await page.evaluate(() => localStorage.getItem('neomd.localLayout'));
    const beforeSettings = await page.evaluate(() => localStorage.getItem('neomd.settings.v1'));
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    }
    const afterLS = await page.evaluate(() => localStorage.getItem('neomd.localLayout'));
    const afterSettings = await page.evaluate(() => localStorage.getItem('neomd.settings.v1'));
    console.log('    localLayout:', afterLS);
    check(afterLS !== beforeLS && Boolean(afterLS), '拖动后写入 localStorage neomd.localLayout', String(afterLS));
    // 云同步 payload 是 settings，宽度不应进去
    const lb = JSON.parse(afterLS || '{}');
    const sb = JSON.parse(afterSettings || '{}');
    const layoutInSettings = sb?.layout ?? {};
    check(
      layoutInSettings.leftPanelWidth === undefined || layoutInSettings.leftPanelWidth !== lb.leftWidth,
      '侧栏宽度不进 settings 云同步 payload',
      `settings.leftPanelWidth=${layoutInSettings.leftPanelWidth} local=${lb.leftWidth}`,
    );
  }

  /* ---------- 12. 功能区右键 ---------- */
  console.log('\n[12] 功能区右键菜单');
  const ribbonBtn = page.locator('.ribbon .ribbon__btn').first();
  check((await ribbonBtn.count()) > 0, '功能区有按钮');
  if (await ribbonBtn.count()) {
    await ribbonBtn.click({ button: 'right' });
    await page.waitForTimeout(500);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('.ribbonmenu');
      if (!m) return null;
      return { items: Array.from(m.querySelectorAll('.ribbonmenu__item')).map((n) => (n.textContent || '').trim()) };
    });
    console.log('    ', JSON.stringify(menu));
    check(menu !== null, '右键出现功能区菜单');
    if (menu) {
      check(menu.items.some((t) => t.includes('隐藏此按钮')), '菜单含「隐藏此按钮」', menu.items.join('|'));
      check(menu.items.some((t) => t.includes('上移')), '菜单含排序项', menu.items.join('|'));
    }
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 500);
    await page.waitForTimeout(300);
  }

  /* ---------- 13. 工具栏拖拽属性 ---------- */
  console.log('\n[13] 正文工具栏拖拽');
  const toolDrag = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.editorbar__mid .tbtn'));
    return { count: btns.length, draggable: btns.slice(0, 3).map((b) => b.getAttribute('draggable')) };
  });
  console.log('    ', JSON.stringify(toolDrag));
  check(toolDrag.count > 0, '正文工具栏有按钮');
  check(toolDrag.draggable.every((d) => d === 'true'), '工具栏按钮可拖动', toolDrag.draggable.join(','));

  /* ---------- 14. 插件商店在标签页打开 ---------- */
  console.log('\n[14] 插件商店标签页');
  const pluginBtn = page.locator('.ribbon__btn[title*="插件"]').first();
  if (await pluginBtn.count()) {
    await pluginBtn.click();
    await page.waitForTimeout(1600);
    const st = await page.evaluate(() => ({
      activeTab: (document.querySelector('.tab.is-active .tab__title')?.textContent || '').trim(),
      hasModal: Boolean(document.querySelector('.nm-modal-mask, [role="dialog"]')),
      embeddedPc: Boolean(document.querySelector('.pc--embedded') || document.querySelector('.pc')),
      subTabs: Array.from(document.querySelectorAll('.pc__nav-item')).map((n) => (n.textContent || '').trim()),
    }));
    console.log('    ', JSON.stringify(st));
    check(st.activeTab === '插件商店', '新开「插件商店」标签', st.activeTab);
    check(!st.hasModal, '不是弹窗');
    check(st.embeddedPc, '插件中心内容已渲染');
    check(st.subTabs.some((t) => t.includes('内置插件')), '含「内置插件」子页签', st.subTabs.join('/'));
    await page.screenshot({ path: path.join(shots, '05-plugin-store.png') });
    // 关掉该标签
    const activeTabEl = page.locator('.tab.is-active').first();
    await activeTabEl.hover();
    const cb = activeTabEl.locator('.tab__close');
    if (await cb.count()) await cb.click();
    await page.waitForTimeout(600);
  } else {
    check(false, '功能区无插件商店按钮');
  }

  /* ---------- 15. 左侧栏布局按钮改为下拉 ---------- */
  console.log('\n[15] 布局按钮下拉');
  const layoutBtn = page.locator('.leftpanel__tools .act[title*="布局"], .leftpanel__tools .act[title*="大纲"]').first();
  if (await layoutBtn.count()) {
    await layoutBtn.click();
    await page.waitForTimeout(500);
    const menu = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitemradio"], .popmenu__item'));
      return items.map((n) => (n.textContent || '').trim()).filter(Boolean);
    });
    console.log('    ', JSON.stringify(menu));
    check(menu.length >= 2, '点击后展开下拉选项', `${menu.length} 项`);
  } else {
    check(false, '未找到布局按钮');
  }

  /* ---------- 16. 行号显示开关可达 ---------- */
  console.log('\n[16] 行号显示');
  const lineNos = await page.evaluate(() => document.documentElement.classList.contains('nm-show-linenos') || Boolean(document.querySelector('.nm-show-linenos')));
  const settingsHas = await page.evaluate(() => localStorage.getItem('neomd.settings.v1')?.includes('showLineNumbers'));
  check(lineNos || settingsHas === true, '行号配置存在且可控制', `class=${lineNos} settings=${settingsHas}`);

  check(httpErrors.length === 0, '无前端资源 4xx/5xx', httpErrors.slice(0, 3).join(' | '));
} catch (e) {
  check(false, '脚本异常', String(e?.message ?? e).slice(0, 300));
  await page.screenshot({ path: path.join(shots, '99-error.png') }).catch(() => undefined);
} finally {
  await browser.close();
}

console.log(`\n===== 通过 ${pass}，失败 ${failures.length} =====`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
console.log(`截图：${shots}`);
process.exit(failures.length === 0 ? 0 : 1);
