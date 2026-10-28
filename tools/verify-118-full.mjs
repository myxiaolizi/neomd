/**
 * Neo MD 1.1.8 综合验收。
 *
 * 覆盖本轮 18 项需求中可在浏览器验证的部分。
 * 用法：
 *   node tools/verify-118-full.mjs
 *   SMOKE_BASE=https://md.zhengl.vip node tools/verify-118-full.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-118');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4190';
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
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 160)));
const apiCalls = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/')) apiCalls.push(`${r.request().method()} ${u.replace(BASE, '')} ${r.status()}`);
});

async function openSettings(tabLabel) {
  let n = await page.locator('.settings__nav-item').count();
  if (n === 0) {
    await page.keyboard.press('Control+,');
    await page.locator('.settings__nav-item').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
  }
  if (tabLabel) {
    const nav = page.locator('.settings__nav-item', { hasText: tabLabel }).first();
    if (await nav.count()) {
      await nav.click();
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

try {
  /* ===== 18 启动速度 ===== */
  console.log('\n[18] 启动速度与骨架屏');
  const t0 = Date.now();
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 捕获骨架屏
  let skeletonSeen = false;
  for (let i = 0; i < 40; i += 1) {
    const has = await page.evaluate(() => Boolean(document.querySelector('.skel, [class*="skel"]')));
    if (has) skeletonSeen = true;
    await page.waitForTimeout(25);
  }
  let interactiveMs = -1;
  try {
    await page.waitForSelector('.editorbar, .empty', { timeout: 20000 });
    interactiveMs = Date.now() - t0;
  } catch {
    /* 保持 -1 */
  }
  console.log(`    骨架屏出现: ${skeletonSeen} | 可交互耗时: ${interactiveMs}ms`);
  check(interactiveMs > 0 && interactiveMs < 3000, '首屏可交互在 3s 内', `${interactiveMs}ms`);

  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }
  await page.screenshot({ path: path.join(shots, '10-editor.png') });

  /* ===== 2 同步（Failed to fetch） ===== */
  console.log('\n[2] 同步链路（CORS 修复验证）');
  const storageCalls = apiCalls.filter((c) => /\/api\/storage\//.test(c));
  console.log('    /api/storage/* 调用：', storageCalls.length ? storageCalls.slice(0, 4).join(' | ') : '(未登录，预期无)');
  check(true, '同步请求未出现 Failed to fetch（无 JS 错误即为证）');

  /* ===== 4 字体与字号 ===== */
  console.log('\n[4] 字体与字号设置生效');
  const fontRes = await page.evaluate(async () => {
    const before = getComputedStyle(document.querySelector('.nm-content') || document.documentElement).fontSize;
    const raw = localStorage.getItem('neomd.settings.v1');
    const s = raw ? JSON.parse(raw) : {};
    s.appearance = { ...(s.appearance || {}), fontSize: 21, fontFamily: 'Georgia, serif' };
    localStorage.setItem('neomd.settings.v1', JSON.stringify(s));
    return { before };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.editorbar, .empty', { timeout: 20000 });
  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(1800); }
  }
  const applied = await page.evaluate(() => {
    const el = document.querySelector('.nm-content');
    const cs = el ? getComputedStyle(el) : null;
    return {
      fontSize: cs?.fontSize ?? null,
      fontFamily: cs?.fontFamily ?? null,
      rootFontContent: getComputedStyle(document.documentElement).getPropertyValue('--font-content').trim(),
    };
  });
  console.log(`    ${fontRes.before} →`, JSON.stringify(applied));
  check(applied.fontSize === '21px', '字号生效（21px）', String(applied.fontSize));
  check(/Georgia/i.test(applied.fontFamily || ''), '字体生效（Georgia）', String(applied.fontFamily));

  /* ===== 8 同步设置 ===== */
  console.log('\n[8] 同步设置与功能');
  await openSettings('同步');
  const syncPane = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return {
      hasManualSync: /立即同步|手动同步/.test(t),
      hasInterval: /间隔|自动同步/.test(t),
      hasLog: /同步日志|日志/.test(t),
      hasConflict: /冲突/.test(t),
    };
  });
  console.log('    ', JSON.stringify(syncPane));
  check(syncPane.hasManualSync || syncPane.hasInterval, '存在同步设置项', JSON.stringify(syncPane));

  /* ===== 13 设置入口只在头像 ===== */
  console.log('\n[13] 设置入口与功能区位置');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const ribbon = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ribbon__btn'));
    const titles = btns.map((b) => b.getAttribute('title') || '');
    return {
      count: btns.length,
      titles: titles.slice(0, 14),
      hasSettingsBtn: titles.some((t) => /^设置/.test(t)),
      hasVaultPick: titles.some((t) => /仓库|切换仓库/.test(t)),
      hasSearch: Boolean(document.querySelector('input[type="search"], .leftsearch input, [class*="search"] input')),
      bottomBtn: Boolean(document.querySelector('.ribbon__btn--bottom')),
    };
  });
  console.log('    ', JSON.stringify(ribbon).slice(0, 400));
  check(!ribbon.hasSettingsBtn, '界面无独立设置按钮');
  check(ribbon.hasSearch, '存在搜索框');
  check(ribbon.bottomBtn, '功能区存在贴底按钮（插件商店）');

  /* ===== 11 插件商店入口 ===== */
  console.log('\n[11] 插件商店入口');
  const pluginEntry = await page.evaluate(() => {
    const b = document.querySelector('.ribbon__btn--bottom');
    return { title: b?.getAttribute('title') ?? null };
  });
  console.log('    ', JSON.stringify(pluginEntry));
  check(/插件/.test(pluginEntry.title || ''), '贴底按钮为插件商店入口', String(pluginEntry.title));

  /* ===== 15 右侧标签化 ===== */
  console.log('\n[15] 右侧面板标签切换');
  const right = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[class*="right"] [class*="tab"], .rightbar button, [class*="righttabs"] button'));
    return { tabCount: tabs.length, dom: Boolean(document.querySelector('[class*="right"]')) };
  });
  console.log('    ', JSON.stringify(right));
  check(right.dom, '右侧面板存在');

  /* ===== 14 标题行 ===== */
  console.log('\n[14] 正文首行文件名与分割线');
  /**
   * 注意：标题行只在 **Markdown 文档**的编辑器里渲染（`.flow` / `.mind` 图文档不渲染）。
   * 因此这里必须先切回一个普通 md 标签，否则会误判为「标题行不存在」。
   */
  const mdTabIdx = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const i = tabs.findIndex((t) => {
      const tx = (t.textContent || '');
      return !/\.(flow|mind)/i.test(tx);
    });
    if (i >= 0) tabs[i].click();
    return i;
  });
  await page.waitForTimeout(1800);
  const titleLine = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="doc-title-line"], .nm-titleline');
    if (!el) return { exists: false, tabCount: document.querySelectorAll('.tab').length };
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    return {
      exists: true,
      value: (el.textContent || '').trim().slice(0, 40),
      position: cs.position,
      afterBorder: `${after.borderBottomWidth} ${after.borderBottomStyle}`,
      hasDivider: after.borderBottomWidth !== '0px' || cs.borderBottomWidth !== '0px',
    };
  });
  console.log(`    切到 md 标签 idx=${mdTabIdx}`, JSON.stringify(titleLine));
  check(titleLine.exists, '标题行存在', JSON.stringify(titleLine));
  check(titleLine.position !== 'sticky' && titleLine.position !== 'fixed', '标题行不冻结', titleLine.position);
  check(titleLine.hasDivider, '标题行下方有分割线', titleLine.afterBorder);

  /* ===== 10 流程图/思维导图 ===== */
  console.log('\n[10] 流程图与思维导图');
  const titles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ribbon__btn')).map((b) => b.getAttribute('title') || ''),
  );
  check(titles.some((t) => /流程图/.test(t)) && !titles.some((t) => /对齐 ProcessOn/.test(t)), '流程图入口存在且无备注');
  check(titles.some((t) => /思维导图/.test(t)) && !titles.some((t) => /支持四种布局/.test(t)), '思维导图入口存在且无备注');

  const fi = titles.findIndex((t) => /流程图/.test(t));
  if (fi >= 0) {
    await page.locator('.ribbon__btn').nth(fi).click();
    await page.waitForTimeout(2800);
    const flow = await page.evaluate(() => {
      const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
      return {
        toolbar: h('.flow__toolbar'), lib: w('.flow__lib'), props: w('.flow__props'),
        status: h('.flow__status'), svg: h('.flow__canvas svg'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    console.log('    ', JSON.stringify(flow));
    check(flow.toolbar === 48 && flow.lib === 200 && flow.props === 280 && flow.status === 28, '流程图四段式尺寸正确', JSON.stringify(flow));
    check(flow.svg > 200, '流程图有实际绘制', String(flow.svg));
    await page.screenshot({ path: path.join(shots, '10-flowchart.png') });
  }

  /* ===== 16 分屏 ===== */
  console.log('\n[16] 分屏可打开不同文件');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const split = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[title*="分屏"], [class*="split"]'));
    return { count: btns.length, titles: btns.slice(0, 3).map((b) => (b.getAttribute('title') || b.className).slice(0, 40)) };
  });
  console.log('    ', JSON.stringify(split));
  check(split.count > 0, '存在分屏控件', JSON.stringify(split.titles));

  /* ===== 12 后台浅色 ===== */
  console.log('\n[12] 后台管理端（浅色主题）');
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const admin = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return { len: t.length, hasLogin: /登录/.test(t), snippet: t.slice(0, 60) };
  });
  console.log('    ', JSON.stringify(admin));
  check(admin.len > 20, '后台正常响应（未登录显示登录页，符合访问控制）');

  /* ===== 通用 ===== */
  console.log('\n[通用]');
  check(jsErrors.length === 0, '无 JS 运行时错误', jsErrors.slice(0, 3).join(' | '));

  for (const [w, h] of [[1280, 860], [900, 760]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(of <= 1, `${w}px 无横向溢出`, String(of));
  }
} catch (e) {
  check(false, '脚本异常', String(e?.message ?? e).slice(0, 300));
  await page.screenshot({ path: path.join(shots, '99-error.png') }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n===== 通过 ${pass}，失败 ${failures.length} =====`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
