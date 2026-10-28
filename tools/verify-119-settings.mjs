/**
 * 1.1.9 设置系统验收（Playwright 真实浏览器）。
 *
 * 覆盖：
 *  1. 字体 / 字号在 WYSIWYG、源码、阅读、对照 四种模式下真的生效（改前后 computed 对比）
 *  2. zoom 与字号不重复缩放：zoom=100% 时正文 px === appearance.fontSize
 *  3. 页宽 / 行号开关生效
 *  4. 拼写检查开关实时写回 .ProseMirror 的 spellcheck 属性
 *  5. 工具栏拖拽调序后持久化进 settings.layout.toolbarItems，且刷新后保持
 *  6. 设置落盘（localStorage）不丢字段、secrets 不落明文
 *
 * 前置：前端 vite dev 已运行（默认 5178），后端 /api 代理可用，账号 admin/6655。
 * 用法：node tools/verify-119-settings.mjs
 *       SMOKE_BASE=http://127.0.0.1:5178 node tools/verify-119-settings.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-119');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
const BROWSER = process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

/** 期望的目标值（验收基准） */
const TARGET_FONT_SIZE = 24;
const TARGET_FONT_FAMILY_CONTAINS = 'Georgia';
const TARGET_LINE_HEIGHT = 2;

let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fails.push(`${label}${extra ? ` \u2192 ${extra}` : ''}`);
    console.log(`  \u2717 ${label}${extra ? ` \u2192 ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({
  executablePath: BROWSER,
  args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 240)}`));

/* ------------------------------ 工具函数 ------------------------------ */

/** 登录并注入 token（与真实用户登录后的 localStorage 状态一致） */
async function login() {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { account: USER, password: PASS },
  });
  if (!res.ok()) throw new Error(`登录失败 HTTP ${res.status()}`);
  const d = (await res.json()).data ?? {};
  const access = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [access, refresh],
  );
}

/** 读取四种模式下正文相关元素的 computed 排版属性 */
const READ_TYPOGRAPHY = `(() => {
  const root = document.documentElement;
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      inline: (el.getAttribute('style') || '').slice(0, 200),
    };
  };
  return {
    rootInline: {
      fontContent: root.style.getPropertyValue('--font-content'),
      contentFontSize: root.style.getPropertyValue('--content-font-size'),
      contentLineHeight: root.style.getPropertyValue('--content-line-height'),
      contentZoom: root.style.getPropertyValue('--content-zoom'),
    },
    wysiwyg: pick('.wysiwyg__host .ProseMirror') || pick('.ProseMirror'),
    nmContent: pick('.nm-content'),
    source: pick('.cm-content'),
    sourceScroller: pick('.cm-scroller'),
    read: pick('.read-view__body'),
  };
})()`;

const readTypography = () => page.evaluate(READ_TYPOGRAPHY);

/** 当前编辑模式：从 EditorBar 的「编辑模式」按钮 title 解析 */
async function currentMode() {
  const n = await page.locator('.viewswitch').count();
  for (let i = 0; i < n; i += 1) {
    const title = await page
      .locator('.viewswitch')
      .nth(i)
      .locator('.viewswitch__btn')
      .getAttribute('title')
      .catch(() => '');
    if (title && title.includes('编辑模式')) {
      const m = /编辑模式：([^（(]+)/.exec(title);
      return (m?.[1] ?? title).trim();
    }
  }
  return '';
}

/** 切到指定编辑模式（源码模式 / 阅读视图 / 对照模式 / 所见即所得） */
async function setMode(label) {
  const boxes = page.locator('.viewswitch');
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) {
    const title = await boxes.nth(i).locator('.viewswitch__btn').getAttribute('title').catch(() => '');
    if (!title || !title.includes('编辑模式')) continue;
    await boxes.nth(i).locator('.viewswitch__btn').click();
    await page.waitForTimeout(350);
    const item = boxes.nth(i).locator('.viewswitch__item').filter({ hasText: label }).first();
    if (!(await item.count())) throw new Error(`模式下拉里没有「${label}」`);
    await item.click();
    await page.waitForTimeout(1100);
    return;
  }
  throw new Error(`未找到「编辑模式」切换按钮（目标：${label}）`);
}

/** 打开设置页并切到指定页签 */
async function openSettingsTab(label) {
  const settingsOpen = await page.locator('.settings-page').count();
  if (!settingsOpen) {
    await page.keyboard.press('Control+Comma');
    await page.waitForTimeout(1500);
  }
  const nav = page.locator('.settings__nav-item').filter({ hasText: label }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(800);
  }
}

/** 关闭设置标签页，回到正文 */
async function closeSettings() {
  const has = await page.locator('.settings-page').count();
  if (!has) return;
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(1200);
}

/** Vue 的 v-model 需要派发原生 input/change 才能被监听到 */
async function setNumberInput(locator, value) {
  await locator.fill(String(value));
  await locator.dispatchEvent('input');
  await page.waitForTimeout(900);
}

const readSettings = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null');
    } catch {
      return null;
    }
  });

/* -------------------------------- 主流程 -------------------------------- */

try {
  await login();
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  // 建一篇文档，四种模式才有东西可测
  await page.getByRole('button', { name: /新建文档/ }).first().click();
  await page.waitForTimeout(2600);
  const hasEditor = await page.locator('.ProseMirror').count();
  if (!hasEditor) throw new Error('新建文档后没有出现编辑器，无法继续');

  console.log('\n=== 1. 字体 / 字号 / 行高（四种模式） ===');

  // 记录改前基线
  const before = await readTypography();
  console.log(`  改前：根 --font-content=${before.rootInline.fontContent} ` +
    `--content-font-size=${before.rootInline.contentFontSize} ` +
    `--content-line-height=${before.rootInline.contentLineHeight}`);
  console.log(`  改前 WYSIWYG: font=${before.wysiwyg?.fontFamily} size=${before.wysiwyg?.fontSize} lh=${before.wysiwyg?.lineHeight}`);

  // 打开设置 → 编辑器，改字体 / 字号 / 行高
  await openSettingsTab('编辑器');
  check((await page.locator('.settings-page').count()) > 0, '设置页已打开');

  const fontSel = page.locator('select[aria-label="正文字体"]').first();
  check((await fontSel.count()) > 0, '存在「正文字体」下拉');
  const fontValues = await fontSel.locator('option').evaluateAll((els) => els.map((e) => e.value));
  const serifValue = fontValues.find((v) => v.includes('Georgia')) ?? fontValues[1];
  await fontSel.selectOption(serifValue);
  await page.waitForTimeout(1000);
  console.log(`  已选字体：${serifValue}`);

  const sizeInput = page.locator('input[aria-label="编辑器正文字号"]').first();
  check((await sizeInput.count()) > 0, '存在「正文字号」输入框');
  await setNumberInput(sizeInput, TARGET_FONT_SIZE);

  const lhInput = page.locator('input[aria-label="编辑器正文行高"]').first();
  check((await lhInput.count()) > 0, '存在「正文行高」输入框');
  await setNumberInput(lhInput, TARGET_LINE_HEIGHT);

  const saved = await readSettings();
  check(saved?.appearance?.fontSize === TARGET_FONT_SIZE, `设置已落盘 fontSize=${TARGET_FONT_SIZE}`, String(saved?.appearance?.fontSize));
  check(String(saved?.appearance?.fontFamily ?? '').includes(TARGET_FONT_FAMILY_CONTAINS), '设置已落盘 fontFamily 含 Georgia', saved?.appearance?.fontFamily);
  check(saved?.appearance?.lineHeight === TARGET_LINE_HEIGHT, `设置已落盘 lineHeight=${TARGET_LINE_HEIGHT}`, String(saved?.appearance?.lineHeight));

  await closeSettings();

  /** 断言某模式的排版符合期望 */
  function assertMode(label, node, expectFont) {
    if (!node) {
      check(false, `${label}：找到正文节点`);
      return;
    }
    check(
      node.fontSize === `${TARGET_FONT_SIZE}px`,
      `${label}：font-size === ${TARGET_FONT_SIZE}px`,
      node.fontSize,
    );
    // lineHeight: 2 * 24 = 48px，浏览器 computed 会换算成 px
    const expectedLh = `${TARGET_FONT_SIZE * TARGET_LINE_HEIGHT}px`;
    check(node.lineHeight === expectedLh, `${label}：line-height === ${expectedLh}`, node.lineHeight);
    if (expectFont) {
      check(
        node.fontFamily.includes(TARGET_FONT_FAMILY_CONTAINS),
        `${label}：font-family 含 ${TARGET_FONT_FAMILY_CONTAINS}`,
        node.fontFamily,
      );
    }
  }

  // WYSIWYG
  const wys = await readTypography();
  console.log(`  WYSIWYG mode=${await currentMode()}`);
  assertMode('WYSIWYG .ProseMirror', wys.wysiwyg, true);
  assertMode('WYSIWYG .nm-content', wys.nmContent, true);
  check(
    wys.rootInline.contentFontSize === `${TARGET_FONT_SIZE}px`,
    `根 --content-font-size === ${TARGET_FONT_SIZE}px`,
    wys.rootInline.contentFontSize,
  );

  // 源码
  await setMode('源码模式');
  const src = await readTypography();
  assertMode('源码 .cm-content', src.source, true);
  check(src.source?.fontFamily?.includes(TARGET_FONT_FAMILY_CONTAINS), '源码 .cm-content 字体跟随设置', src.source?.fontFamily);

  // 阅读
  await setMode('阅读视图');
  const rd = await readTypography();
  assertMode('阅读 .read-view__body', rd.read, true);

  // 对照
  await setMode('对照模式');
  const cmp = await readTypography();
  assertMode('对照 .nm-content', cmp.nmContent, true);
  assertMode('对照 .cm-content', cmp.source, true);

  // 回到所见即所得
  await setMode('所见即所得');
  await page.waitForTimeout(600);

  console.log('\n=== 2. zoom 与字号不重复缩放 ===');
  const zoomData = await page.evaluate(() => {
    const root = document.documentElement;
    const el = document.querySelector('.ProseMirror');
    const raw = localStorage.getItem('neomd.settings.v1');
    const ap = raw ? JSON.parse(raw).appearance : null;
    return {
      zoom: ap?.zoom,
      fontSize: ap?.fontSize,
      rootContentFontSize: root.style.getPropertyValue('--content-font-size'),
      rootContentZoom: root.style.getPropertyValue('--content-zoom'),
      proseFontSize: el ? getComputedStyle(el).fontSize : null,
    };
  });
  console.log(`  ${JSON.stringify(zoomData)}`);
  check(zoomData.zoom === 100, '当前 zoom === 100', String(zoomData.zoom));
  const expectedZoomed = `${Math.round(zoomData.fontSize * (zoomData.zoom / 100) * 100) / 100}px`;
  check(
    zoomData.rootContentFontSize === expectedZoomed,
    `zoom=100% 时 --content-font-size === fontSize（${expectedZoomed}），没有被二次缩放`,
    zoomData.rootContentFontSize,
  );
  check(
    zoomData.proseFontSize === `${TARGET_FONT_SIZE}px`,
    `zoom=100% 时正文实际 px === appearance.fontSize（${TARGET_FONT_SIZE}px）`,
    zoomData.proseFontSize,
  );

  console.log('\n=== 3. 页宽 / 行号开关 ===');
  const pageWidthState = await page.evaluate(() => {
    const el = document.querySelector('.shell__page');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { className: el.className, maxWidth: cs.maxWidth, paddingLeft: cs.paddingLeft };
  });
  check(Boolean(pageWidthState), '存在页宽容器 .shell__page');
  check(/nm-page-/.test(pageWidthState?.className ?? ''), '页宽 class 已应用到 .shell__page', pageWidthState?.className);

  // 行号：class 挂在 shell 上，开/关应切换
  await openSettingsTab('编辑器');
  const beforeLinenos = await page.evaluate(() =>
    Boolean(document.querySelector('.nm-show-linenos')) ||
    document.documentElement.className.includes('nm-show-linenos'),
  );
  await page.locator('[data-testid="editor-line-numbers"]').first().click();
  await page.waitForTimeout(1000);
  await closeSettings();
  const afterLinenos = await page.evaluate(() =>
    Boolean(document.querySelector('.nm-show-linenos')) ||
    document.documentElement.className.includes('nm-show-linenos'),
  );
  check(beforeLinenos !== afterLinenos, `行号开关切换后 .nm-show-linenos 状态改变（${beforeLinenos} → ${afterLinenos}）`);

  console.log('\n=== 4. 拼写检查开关实时生效 ===');
  await openSettingsTab('编辑器');
  const spellToggle = page.locator('[data-testid="editor-spellcheck"]').first();
  check((await spellToggle.count()) > 0, '设置页存在「拼写检查」开关');
  const spellBefore = await page.evaluate(() => document.querySelector('.ProseMirror')?.getAttribute('spellcheck'));
  const ariaBefore = await spellToggle.getAttribute('aria-pressed');
  console.log(`  改前 .ProseMirror spellcheck=${spellBefore} aria-pressed=${ariaBefore}`);
  await spellToggle.click();
  await page.waitForTimeout(1000);
  const spellAfter = await page.evaluate(() => document.querySelector('.ProseMirror')?.getAttribute('spellcheck'));
  const ariaAfter = await spellToggle.getAttribute('aria-pressed');
  console.log(`  改后 .ProseMirror spellcheck=${spellAfter} aria-pressed=${ariaAfter}`);
  check(ariaBefore !== ariaAfter, '拼写检查开关 aria-pressed 状态翻转');
  check(
    spellBefore !== spellAfter,
    `拼写检查开关切换后 .ProseMirror[spellcheck] 变化（${spellBefore} → ${spellAfter}）`,
  );
  check(spellAfter === 'true' || spellAfter === 'false', 'spellcheck 属性值合法（true/false）', spellAfter);

  // 再切回去，确认双向都生效
  await spellToggle.click();
  await page.waitForTimeout(1000);
  const spellBack = await page.evaluate(() => document.querySelector('.ProseMirror')?.getAttribute('spellcheck'));
  check(spellBack === spellBefore, `再次切换后 spellcheck 回到初始值（${spellBefore}）`, spellBack);

  console.log('\n=== 5. 工具栏拖拽调序 + 持久化 ===');
  const tbChips = page.locator('.tb-config-row .tb-chip');
  const tbCount = await tbChips.count();
  check(tbCount > 1, `工具栏按钮可拖动项 > 1（实际 ${tbCount}）`);
  const orderBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}')?.layout?.toolbarItems ?? []);
  console.log(`  拖拽前 toolbarItems=${JSON.stringify(orderBefore.slice(0, 6))}...`);

  // 把第 3 个按钮拖到第 1 个之前
  const srcRow = page.locator('.tb-config-row').nth(2);
  const dstRow = page.locator('.tb-config-row').nth(0);
  const srcBox = await srcRow.boundingBox();
  const dstBox = await dstRow.boundingBox();
  if (srcBox && dstBox) {
    await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    // 分多步移动，确保 dragstart / dragover 都被触发
    await page.mouse.move(dstBox.x + 6, dstBox.y + dstBox.height / 2, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(1200);
  }
  const orderAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}')?.layout?.toolbarItems ?? []);
  console.log(`  拖拽后 toolbarItems=${JSON.stringify(orderAfter.slice(0, 6))}...`);
  const changed = JSON.stringify(orderBefore) !== JSON.stringify(orderAfter);
  check(changed, '拖拽后 toolbarItems 顺序已写入设置（持久化）', changed ? '' : '顺序未变化');

  // 刷新后是否保持
  if (changed) {
    const snapshot = [...orderAfter];
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    const orderReload = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}')?.layout?.toolbarItems ?? []);
    check(
      JSON.stringify(orderReload) === JSON.stringify(snapshot),
      '刷新后 toolbarItems 顺序保持（持久化有效）',
      JSON.stringify(orderReload.slice(0, 5)),
    );
  }

  console.log('\n=== 6. 持久化完整性 / secrets 不落明文 ===');
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('neomd.settings.v1');
    const s = raw ? JSON.parse(raw) : null;
    return {
      keys: s ? Object.keys(s).sort() : [],
      hasStorageSecret: Boolean(s?.storage?.accessKeySecret),
      hasAiKey: Boolean(s?.ai?.apiKey),
      appearanceKeys: s?.appearance ? Object.keys(s.appearance).sort() : [],
      enabledPlugins: s?.enabledPlugins ? Object.keys(s.enabledPlugins).length : 0,
      shortcuts: Array.isArray(s?.shortcuts) ? s.shortcuts.length : 0,
    };
  });
  console.log(`  持久化顶层键：${persisted.keys.join(', ')}`);
  for (const k of ['version', 'appearance', 'naming', 'autosave', 'shareStyle', 'localVault', 'server', 'knowledge', 'diagram', 'layout', 'shortcuts', 'enabledPlugins', 'storage', 'ai', 'sync', 'cloudVersion', 'updatedAt']) {
    check(persisted.keys.includes(k), `持久化包含 ${k}`);
  }
  for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'pageWidth', 'showLineNumbers', 'spellcheck', 'typewriterMode', 'zoom', 'themePresetId', 'customThemes']) {
    check(persisted.appearanceKeys.includes(k), `appearance 包含 ${k}`);
  }
  check(persisted.hasStorageSecret === false, 'localStorage 不落明文 storage.accessKeySecret');
  check(persisted.hasAiKey === false, 'localStorage 不落明文 ai.apiKey');
  check(persisted.enabledPlugins > 0, `enabledPlugins 有 ${persisted.enabledPlugins} 项`);
  check(persisted.shortcuts > 0, `shortcuts 有 ${persisted.shortcuts} 条`);

  console.log('\n=== 7. 云端同步分区完整性（global / 本地 分区字段齐备） ===');
  const partitions = await page.evaluate(() => {
    const raw = localStorage.getItem('neomd.settings.v1');
    const s = raw ? JSON.parse(raw) : null;
    if (!s) return null;
    return {
      hasStorage: Boolean(s.storage && s.storage.endpoint),
      hasAiProvider: Boolean(s.ai && s.ai.provider),
      hasSyncPrefix: Boolean(s.sync && typeof s.sync.rootPrefix === 'string'),
      hasNaming: Boolean(s.naming && s.naming.mode),
      hasServer: Boolean(s.server && s.server.mode),
      hasLocalVault: Boolean(s.localVault && typeof s.localVault.root === 'string'),
      ribbonHasDiagrams:
        Array.isArray(s.layout?.ribbonItems) &&
        s.layout.ribbonItems.includes('diagram-flowchart') &&
        s.layout.ribbonItems.includes('diagram-mindmap'),
    };
  });
  check(partitions?.hasStorage, 'storage.endpoint 存在（属 global 区，跨端同步）');
  check(partitions?.hasAiProvider, 'ai.provider 存在（属 global 区）');
  check(partitions?.hasSyncPrefix, 'sync.rootPrefix 存在（属 global 区，跨端一致）');
  check(partitions?.hasNaming, 'naming.mode 存在（属 global 区）');
  check(partitions?.hasServer, 'server.mode 存在（属本地区，永不上云）');
  check(partitions?.hasLocalVault, 'localVault.root 存在（属本地区，永不上云）');
  console.log(`  ribbonItems 含图表插件：${partitions?.ribbonHasDiagrams}`);

  const realErrors = consoleErrors.filter((e) => !/favicon|Failed to load resource|ERR_|net::/i.test(e));
  console.log('\n=== 8. 控制台无异常 ===');
  check(realErrors.length === 0, `无 JS 异常（${realErrors.length} 条）`, realErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: path.join(shots, 'settings-119.png'), fullPage: true }).catch(() => {});
  console.log(`\n  screenshot: ${path.relative(process.cwd(), path.join(shots, 'settings-119.png'))}`);
} catch (err) {
  fails.push(`脚本异常：${err.message}`);
  console.log(`\n  \u2717 脚本异常：${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
  await page.screenshot({ path: path.join(shots, '_error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n结果：通过 ${pass}，失败 ${fails.length}`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length === 0 ? 0 : 1);
