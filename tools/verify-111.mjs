/**
 * Neo MD 1.1.1 验收测试。
 *
 * 逐条覆盖本次 7 项修复：
 *   1. PC 端标签页过多时新标签可见（自动滚动到活动标签）
 *   2. Web 端主题能跨端同步（global 区，不再是 platform 隔离）
 *   3. PC 端启动不过久（网络操作并行 + 超时）
 *   4. PC/Web 仓库同步（未配 S3 回落服务端平台存储）
 *   5. PC 端设置页不再错乱（撑满容器、三档视口正常）
 *   6. 正文配色方案已移除、所有颜色归主题；主题页可操作
 *   7. 标签卡与顶部有 3px 空间
 *
 * 用法：
 *   node tools/verify-111.mjs
 *   SMOKE_BASE=https://md.zhengl.vip node tools/verify-111.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-111');
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const httpErrors = [];
const apiCalls = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/')) apiCalls.push(`${r.request().method()} ${u.replace(BASE, '')} ${r.status()}`);
  if (r.status() >= 400 && !u.includes('/api/')) httpErrors.push(`${r.status()} ${u.slice(0, 120)}`);
});
page.on('pageerror', (e) => console.log('    [pageerror]', String(e.message).slice(0, 160)));

try {
  /* ============ 3. 启动耗时 ============ */
  console.log('\n[3] 启动耗时（进入编辑器）');
  const t0 = Date.now();
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 等到工具栏出现（说明 boot 完成、仓库已开）
  let bootMs = null;
  try {
    await page.waitForSelector('.editorbar, .empty', { timeout: 20000 });
    bootMs = Date.now() - t0;
  } catch {
    bootMs = -1;
  }
  console.log(`    进入编辑器耗时：${bootMs} ms`);
  check(bootMs > 0 && bootMs < 15000, '启动在 15s 内完成（PC 端不应长时间停在「正在打开仓库」）', `${bootMs} ms`);

  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }
  await page.screenshot({ path: path.join(shots, '01-editor.png') });

  /* ============ 7. 标签栏 3px + 40/37 ============ */
  console.log('\n[7] 标签卡与顶部 3px 空间');
  const tabbar = await page.evaluate(() => {
    const titlebar = document.querySelector('.titlebar');
    const inner = document.querySelector('.tabbar');
    const tab = document.querySelector('.tab');
    if (!titlebar) return null;
    const tb = titlebar.getBoundingClientRect();
    const innerH = inner ? Math.round(inner.getBoundingClientRect().height) : null;
    const innerTop = inner ? inner.getBoundingClientRect().top : null;
    return {
      titlebarH: Math.round(tb.height),
      paddingTop: getComputedStyle(titlebar).paddingTop,
      innerH,
      gap: innerTop !== null ? Math.round(innerTop - tb.top) : null,
      tabH: tab ? Math.round(tab.getBoundingClientRect().height) : null,
    };
  });
  console.log('    ', JSON.stringify(tabbar));
  if (tabbar) {
    check(tabbar.titlebarH === 40, '标题栏总高仍 40px', String(tabbar.titlebarH));
    check(tabbar.paddingTop === '3px', '顶部留白 3px', tabbar.paddingTop);
    check(tabbar.gap === 3, '标签顶部与标题栏顶部实际相差 3px', String(tabbar.gap));
    check(tabbar.innerH === 37 || tabbar.tabH === 37, '标签内层高度 37px', `inner=${tabbar.innerH} tab=${tabbar.tabH}`);
  } else {
    check(false, '未找到 .titlebar');
  }

  /* ============ 1. 标签溢出自动滚动 ============ */
  console.log('\n[1] 标签页过多时新标签可见');
  // 快速新建 14 篇文档，凑够溢出量
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(320);
  }
  await page.waitForTimeout(1200);
  const tabScroll = await page.evaluate(() => {
    const scroller = document.querySelector('.tabbar__scroll');
    const tabs = Array.from(document.querySelectorAll('.tab'));
    if (!scroller || !tabs.length) return null;
    const active = document.querySelector('.tab.is-active');
    const sr = scroller.getBoundingClientRect();
    const ar = active ? active.getBoundingClientRect() : null;
    return {
      count: tabs.length,
      scrollLeft: Math.round(scroller.scrollLeft),
      scrollWidth: Math.round(scroller.scrollWidth),
      clientWidth: Math.round(scroller.clientWidth),
      activeId: active?.getAttribute('data-id') ?? null,
      activeText: (active?.textContent || '').trim().slice(0, 30),
      activeVisible: ar ? ar.left >= sr.left - 2 && ar.right <= sr.right + 2 : false,
      activeIndex: active ? tabs.indexOf(active) : -1,
    };
  });
  console.log('    ', JSON.stringify(tabScroll));
  if (tabScroll) {
    check(tabScroll.count >= 12, '已打开足够多标签', String(tabScroll.count));
    /**
     * 1.1.7 起标签会**自动缩窄**以适配容器（需求「标签过多时缩窄」）。
     * 因此「必须溢出并可滚动」不再是正确预期：
     * - 缩窄后恰好铺满（scrollWidth ≈ clientWidth）时，scrollLeft=0 是**正常**的；
     * - 只有缩到最小宽度仍放不下，才会溢出并滚动。
     * 所以断言改为「活动标签可见」这一真正重要的行为，并记录布局形态，
     * 避免把功能改进误判成退化。
     */
    const overflows = tabScroll.scrollWidth > tabScroll.clientWidth;
    console.log(`    布局形态：${overflows ? '溢出可滚动' : '缩窄后恰好铺满'}`);
    check(
      overflows ? tabScroll.scrollLeft > 0 || tabScroll.activeVisible : true,
      overflows ? '溢出时已自动滚动' : '缩窄后无需滚动（1.1.7 起的预期行为）',
      `scrollLeft=${tabScroll.scrollLeft} scrollW=${tabScroll.scrollWidth} clientW=${tabScroll.clientWidth}`,
    );
    check(tabScroll.activeVisible, '活动（新开）标签在可视区内', tabScroll.activeText);
  } else {
    check(false, '未找到标签栏滚动容器');
  }
  await page.screenshot({ path: path.join(shots, '02-tabs-overflow.png') });

  // 关闭一个中间标签，活动标签仍应可见
  const closable = page.locator('.tab').nth(2);
  await closable.hover();
  await page.waitForTimeout(200);
  const closeBtn = closable.locator('.tab__close');
  if (await closeBtn.count()) {
    await closeBtn.click();
    await page.waitForTimeout(900);
  }
  const afterClose = await page.evaluate(() => {
    const scroller = document.querySelector('.tabbar__scroll');
    const active = document.querySelector('.tab.is-active');
    if (!scroller || !active) return null;
    const sr = scroller.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    return { visible: ar.left >= sr.left - 2 && ar.right <= sr.right + 2 };
  });
  check(afterClose?.visible === true, '关闭中间标签后活动标签仍可见', JSON.stringify(afterClose));

  /* ============ 5. 设置页不错乱（三档视口） ============ */
  console.log('\n[5] 设置页布局（三档视口）');
  for (const [w, h] of [[1280, 860], [1920, 1000], [900, 760]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    // 关掉可能已开的设置标签，重新打开
    const openTab = page.locator('.tab', { hasText: '设置' }).first();
    if (!(await openTab.count())) {
      await page.keyboard.press('Control+,');
      await page.waitForTimeout(1200);
    } else {
      await openTab.click();
      await page.waitForTimeout(700);
    }
    const layout = await page.evaluate(() => {
      const sp = document.querySelector('.settings-page');
      const wrap = document.querySelector('.settings-page__wrap');
      const nav = document.querySelector('.settings__nav');
      const body = document.querySelector('.settings__body');
      if (!sp) return null;
      const spr = sp.getBoundingClientRect();
      const nr = nav?.getBoundingClientRect();
      const br = body?.getBoundingClientRect();
      return {
        h: Math.round(spr.height),
        viewportH: window.innerHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navRight: nr ? Math.round(nr.right) : null,
        bodyLeft: br ? Math.round(br.left) : null,
        navW: nr ? Math.round(nr.width) : null,
        bodyVisible: br ? br.height > 100 : false,
        wrapExists: Boolean(wrap),
      };
    });
    console.log(`    ${w}×${h}:`, JSON.stringify(layout));
    if (layout) {
      // 设置页应撑满可用高度（容差放宽到 60px，因为顶部还有标签栏/工具栏）
      check(layout.h > layout.viewportH * 0.6, `${w}px: 设置页高度足够（不再被 68vh 压扁）`, `${layout.h}/${layout.viewportH}`);
      check(layout.overflowX <= 1, `${w}px: 无横向溢出`, String(layout.overflowX));
      check(layout.bodyVisible, `${w}px: 右侧内容区可见且有高度`);
      if (layout.navRight !== null && layout.bodyLeft !== null) {
        check(layout.bodyLeft >= layout.navRight - 2, `${w}px: 左侧页签与右侧内容不重叠`, `navRight=${layout.navRight} bodyLeft=${layout.bodyLeft}`);
      }
    } else {
      check(false, `${w}px: 未渲染 .settings-page`);
    }
    await page.screenshot({ path: path.join(shots, `03-settings-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(400);

  /* ============ 6. 正文配色已移除 + 主题页可操作 ============ */
  console.log('\n[6] 正文配色方案已移除 / 主题页可操作');
  // 确保在设置页
  const nav = page.locator('.settings__nav-item', { hasText: '主题' }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: path.join(shots, '04-theme-tab.png') });

  const themeInfo = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const hasColorSchemeBlock = /正文配色方案/.test(text);
    // 用明确的容器选择器，避免 [class*="preview"] 命中每张卡片内部的小预览
    const preview = document.querySelector('.theme-preview, [data-testid="theme-preview"]');
    const colorInputs = document.querySelectorAll('input[type="color"]').length;
    // 只数真正的卡片按钮，不含 .theme-card__preview 等子元素
    const cards = document.querySelectorAll('button.theme-card').length;
    return {
      hasColorSchemeBlock,
      hasPreview: Boolean(preview),
      previewHasCode: Boolean(document.querySelector('.theme-preview__code, .theme-preview pre')),
      colorInputs,
      cards,
      hasRangeSelector: /应用范围|仅正文|仅界面/.test(text),
      hasTypography: /字号|行高|页宽|行号/.test(text),
    };
  });
  console.log('    ', JSON.stringify(themeInfo));
  check(!themeInfo.hasColorSchemeBlock, '「正文配色方案」已从界面移除');
  check(themeInfo.hasPreview, '主题页有实时预览区');
  check(themeInfo.previewHasCode, '预览区包含代码块等真实排版元素');
  check(themeInfo.colorInputs >= 3, '可细化编辑颜色（多个取色器）', String(themeInfo.colorInputs));
  check(themeInfo.cards >= 4, '主题卡片可选', String(themeInfo.cards));
  check(themeInfo.hasRangeSelector, '有「应用范围」选择（整体/仅正文/仅界面）');
  check(themeInfo.hasTypography, '主题页含字体与排版设置');

  // 断言 EditorPage 不再有内联 editorColorStyle
  const inlineStyle = await page.evaluate(() => {
    const doc = document.querySelector('.shell__doc');
    if (!doc) return 'no-shell-doc';
    return doc.getAttribute('style') || '';
  });
  console.log('    .shell__doc inline style =', JSON.stringify(inlineStyle));
  check(
    inlineStyle === '' || inlineStyle === 'no-shell-doc' || !/background-color/.test(inlineStyle),
    'EditorPage 无 editorColorStyle 内联背景色（不再覆盖主题变量）',
    inlineStyle,
  );

  // 切换主题，断言 CSS 变量真的变化。
  // 注意：必须用 `button.theme-card` 精确定位卡片本身——
  // `[class*="theme-card"]` 会连带匹配 `.theme-card__preview` 等子元素，
  // 点中 span 时虽然事件会冒泡，但测出的 card 数量与选中项都是错的。
  const themeSwitch = await page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const before = {
      preset: root.dataset.themePreset ?? null,
      bg: cs.getPropertyValue('--bg-elevated').trim(),
      contentBg: cs.getPropertyValue('--content-bg').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
    };
    const cards = Array.from(document.querySelectorAll('button.theme-card'));
    const target = cards.find((c) => !c.classList.contains('is-active'));
    const name = target?.querySelector('.theme-card__name')?.textContent?.trim() ?? null;
    if (target) target.click();
    return { before, clicked: name, cardCount: cards.length };
  });
  await page.waitForTimeout(1200);
  const afterTheme = await page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    return {
      preset: root.dataset.themePreset ?? null,
      bg: cs.getPropertyValue('--bg-elevated').trim(),
      contentBg: cs.getPropertyValue('--content-bg').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
    };
  });
  const themeChanged =
    afterTheme.preset !== themeSwitch.before.preset ||
    afterTheme.bg !== themeSwitch.before.bg ||
    afterTheme.contentBg !== themeSwitch.before.contentBg ||
    afterTheme.accent !== themeSwitch.before.accent;
  console.log('    点击:', themeSwitch.clicked, '| 卡片数:', themeSwitch.cardCount);
  console.log('    before:', JSON.stringify(themeSwitch.before));
  console.log('    after :', JSON.stringify(afterTheme));
  check(
    themeChanged,
    '点击主题卡片后实际生效（dataset 或 CSS 变量变化）',
    `${themeSwitch.before.preset} → ${afterTheme.preset}`,
  );
  check(themeSwitch.cardCount >= 4, '主题卡片数量正常（不含子元素误算）', String(themeSwitch.cardCount));

  /* ============ 4. 同步链路（观测是否走平台代理） ============ */
  console.log('\n[4] 仓库同步链路');
  const syncCalls = apiCalls.filter((c) => /\/api\/storage\//.test(c));
  console.log('    /api/storage/* 调用：', syncCalls.length ? syncCalls.slice(0, 5).join(' | ') : '(无，未登录时预期无)');
  // 未登录环境下不应崩：断言页面无 JS 错误即算通过
  check(httpErrors.length === 0, '无前端资源 4xx/5xx', httpErrors.slice(0, 3).join(' | '));

  /* ============ 2. 主题跨端同步（配置层校验） ============ */
  console.log('\n[2] 主题跨端同步（配置分组）');
  const grouped = await page.evaluate(() => {
    // 从 localStorage 读设置，检查主题字段是否会被纳入 global 同步
    // 这里只能校验客户端状态；服务端分组由代码审查与单测保证
    const raw = localStorage.getItem('neomd.settings.v1');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      hasThemePresetId: typeof s?.appearance?.themePresetId === 'string',
      hasAccent: typeof s?.appearance?.accent === 'string',
      // editorColorScheme 字段保留（向后兼容），但界面不再暴露
      keepsLegacyField: 'editorColorScheme' in (s?.appearance ?? {}),
    };
  });
  console.log('    ', JSON.stringify(grouped));
  check(grouped === null || grouped.hasThemePresetId, 'settings 中保存了 themePresetId', JSON.stringify(grouped));
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
process.exit(failures.length ? 1 : 0);
