/**
 * 1.4.0 设置与主题：**侦察探针**（只诊断、不改代码）。
 *
 * 目的：在动手修之前，把七项需求的现状用真实浏览器测出来：
 *   1. 主题范围（all / content / chrome）下 `--bg` / `--content-bg` 的实际计算值
 *      —— 用来判定「仅正文仍全局生效」的根因是 `themeVarAllowed` 白名单漏项，
 *      还是「removeProperty 之后回落到 themes.css 的同一套主题静态值」；
 *   2. 颜色细化（contentBg / accent）改动后，真实界面变量有没有跟着变
 *      —— 用来判定是否只改了预览、是否被 `appearance.accent` 覆盖逻辑吞掉；
 *   3. 5 套内置主题下 `--border` vs 背景的对比度（需求 11 的达标基线）；
 *   4. 「通用」页签的主色调（accent）点击后 `--accent` 是否变化；
 *   5. 设置标签页里是否渲染了 `.editorbar`（需求 15）。
 *
 * 生产库安全：启动时快照 `neomd.settings.v1`（本地）与云端 global/platform
 * 的 appearance，finally 里必须还原并逐字段复查。
 *
 * 用法：
 *   node tools/re14-settings-probe.mjs
 *   RE14_BASE=http://127.0.0.1:5178 node tools/re14-settings-probe.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-140-settings');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';
const PLATFORM = process.env.RE14_PLATFORM || 'web';
const GLOBAL_PROBE = '__re14_global_probe__';
const SNAPSHOT_FILE = path.join(here, '.re14-settings-snapshot.json');

let token = '';

async function apiJson(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function readRemoteAppearance(platform) {
  const { body } = await apiJson(`/api/settings?platform=${encodeURIComponent(platform)}`);
  const payload = body?.data?.payload ?? null;
  return { appearance: payload?.appearance ?? null, version: body?.data?.version ?? null };
}

const USER_DATA_DIR = path.join(here, '.re14-chrome-profile');
fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

const LAUNCH_ARGS = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

let ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: BROWSER,
  args: LAUNCH_ARGS,
  viewport: { width: 1600, height: 1000 },
});
let page = ctx.pages()[0] ?? (await ctx.newPage());

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});

const snapshot = { localStorage: null, globalAppearance: {}, platformAppearance: {} };

function log(...a) {
  console.log(...a);
}

/** 读关键 CSS 变量 + data 属性 + 部分元素 computed */
const READ_THEME = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const pick = (n) => cs.getPropertyValue(n).trim();
  const nav = document.querySelector('.settings__nav');
  const navCs = nav ? getComputedStyle(nav) : null;
  let store = null;
  try { store = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null'); } catch {}
  return {
    preset: root.dataset.themePreset || null,
    mode: root.dataset.theme || null,
    scope: root.dataset.themeScope || null,
    inline: {
      bg: root.style.getPropertyValue('--bg').trim(),
      contentBg: root.style.getPropertyValue('--content-bg').trim(),
      border: root.style.getPropertyValue('--border').trim(),
      accent: root.style.getPropertyValue('--accent').trim(),
      fg: root.style.getPropertyValue('--fg').trim(),
    },
    computed: {
      bg: pick('--bg'),
      contentBg: pick('--content-bg'),
      contentFg: pick('--content-fg'),
      border: pick('--border'),
      borderStrong: pick('--border-strong'),
      accent: pick('--accent'),
      fg: pick('--fg'),
      tableBorder: pick('--table-border'),
      codeBlockBg: pick('--code-block-bg'),
    },
    navBg: navCs ? navCs.backgroundColor : null,
    stored: {
      themePresetId: store?.appearance?.themePresetId ?? null,
      accent: store?.appearance?.accent ?? null,
      customThemesCount: Array.isArray(store?.appearance?.customThemes) ? store.appearance.customThemes.length : 0,
      themeScopeLs: localStorage.getItem('neomd.themeScope'),
    },
    editorbarCount: document.querySelectorAll('.editorbar').length,
    settingsPage: !!document.querySelector('.settings-page'),
  };
})()`;

const readTheme = () => page.evaluate(READ_THEME);

async function openSettingsTab(label) {
  if (!(await page.locator('.settings-page').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForTimeout(1500);
  }
  if (label) {
    const nav = page.locator('.settings__nav-item').filter({ hasText: label }).first();
    if (await nav.count()) {
      await nav.click();
      await page.waitForTimeout(600);
    }
  }
}

/* --------------------------------- 主流程 --------------------------------- */

try {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const loginBody = await loginRes.json();
  const d = loginBody.data ?? {};
  token = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  if (!token) throw new Error('登录响应里没有 accessToken');

  const globalView = await readRemoteAppearance(GLOBAL_PROBE);
  snapshot.globalAppearance = globalView.appearance ?? {};
  const platView = await readRemoteAppearance(PLATFORM);
  snapshot.platformAppearance = platView.appearance ?? {};
  fs.writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify({ savedAt: new Date().toISOString(), ...snapshot }, null, 2),
  );
  log(`快照已备份：${SNAPSHOT_FILE}`);
  log(`云 themePresetId=${JSON.stringify(snapshot.globalAppearance.themePresetId)} accent=${JSON.stringify(snapshot.globalAppearance.accent)}`);

  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [token, refresh],
  );
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  snapshot.localStorage = await page.evaluate(() => {
    const out = {};
    for (const k of [
      'neomd.settings.v1',
      'neomd.themeScope',
      'neomd.themeDirtySince',
      'neomd.layoutBaseline.v1',
      'neomd.appearanceBaseline.v1',
      'neomd.appearancePending.v1',
    ]) {
      out[k] = localStorage.getItem(k);
    }
    return out;
  });

  /* ============ 0. 设置标签页里是否出现 .editorbar（需求15） ============ */
  log('\n=== [0] 需求15：设置标签页里的 .editorbar 渲染情况 ===');
  await page.keyboard.press('Control+Comma');
  await page.waitForTimeout(1800);
  const st0 = await readTheme();
  log(`  设置页已打开=${st0.settingsPage}，.editorbar 数量=${st0.editorbarCount}`);
  await page.screenshot({ path: path.join(shots, '00-settings-editorbar.png') });
  const editorBarBox = await page.evaluate(() => {
    const el = document.querySelector('.editorbar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.height > 0 };
  });
  log(`  .editorbar 盒子=${JSON.stringify(editorBarBox)}`);

  /* ============ 1. 三档主题作用域实测（需求12） ============ */
  log('\n=== [1] 需求12：三档主题作用域的实际计算值 ===');
  await openSettingsTab('主题');
  /** 依次点「整体 / 仅正文 / 仅界面」，各读一次 */
  const scopeButtons = [
    { id: 'all', label: '整体' },
    { id: 'content', label: '仅正文' },
    { id: 'chrome', label: '仅界面' },
  ];
  for (const s of scopeButtons) {
    const btn = page.locator('[data-testid="theme-scope"] .seg__item').filter({ hasText: s.label }).first();
    if (!(await btn.count())) {
      log(`  [WARN] 找不到作用域按钮「${s.label}」`);
      continue;
    }
    await btn.click();
    await page.waitForTimeout(700);
    const t = await readTheme();
    log(
      `  scope=${s.id.padEnd(8)} preset=${t.preset} ` +
        `--bg=${t.computed.bg.padEnd(22)} --content-bg=${t.computed.contentBg.padEnd(22)} ` +
        `--border=${t.computed.border.padEnd(22)} navBg=${t.navBg}`,
    );
    log(`        inline: bg=${JSON.stringify(t.inline.bg)} contentBg=${JSON.stringify(t.inline.contentBg)} border=${JSON.stringify(t.inline.border)}`);
  }

  /* ============ 2. 5 套内置主题分割线对比度（需求11） ============ */
  log('\n=== [2] 需求11：5 套内置主题 --border vs 背景对比度 ===');
  // 先回到「整体」范围，否则 chrome 变量被清掉看不出主题本色
  await page
    .locator('[data-testid="theme-scope"] .seg__item')
    .filter({ hasText: '整体' })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(500);
  const themes = page.locator('[data-testid="theme-cards"] .theme-card');
  const themeCount = await themeCardsCount();
  async function themeCardsCount() {
    return themes.count();
  }
  log(`  主题卡片数=${themeCount}`);
  const contrastRows = [];
  for (let i = 0; i < themeCount; i += 1) {
    const card = themes.nth(i);
    const name = (await card.locator('.theme-card__name').innerText()).trim().split('\n')[0];
    await card.click();
    await page.waitForTimeout(650);
    const t = await readTheme();
    const c = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const toRgb = (v) => {
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(v || '');
        if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
        const h = /^#([0-9a-f]{6})$/i.exec((v || '').trim());
        if (h) return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)];
        return null;
      };
      return {
        border: toRgb(cs.getPropertyValue('--border')),
        bg: toRgb(cs.getPropertyValue('--bg')),
        contentBg: toRgb(cs.getPropertyValue('--content-bg')),
        borderStrong: toRgb(cs.getPropertyValue('--border-strong')),
        tableBorder: toRgb(cs.getPropertyValue('--table-border')),
        rawBorder: cs.getPropertyValue('--border').trim(),
        rawBg: cs.getPropertyValue('--bg').trim(),
      };
    });
    const lum = (rgb) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const ratio = (a, b) => {
      if (!a || !b) return null;
      const l1 = lum(a);
      const l2 = lum(b);
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    };
    const row = {
      name,
      preset: t.preset,
      border: c.rawBorder,
      bg: c.rawBg,
      borderVsBg: ratio(c.border, c.bg),
      borderVsContent: ratio(c.border, c.contentBg),
      tableBorderVsContent: ratio(c.tableBorder, c.contentBg),
    };
    contrastRows.push(row);
    log(
      `  ${name.padEnd(6)} preset=${String(t.preset).padEnd(14)} border=${String(row.border).padEnd(22)} ` +
        `vs bg=${row.borderVsBg} vs content=${row.borderVsContent} tableBorder=${row.tableBorderVsContent}`,
    );
  }
  fs.writeFileSync(path.join(here, '.re14-contrast.json'), JSON.stringify(contrastRows, null, 2));
  await page.screenshot({ path: path.join(shots, '02-themes.png') });

  /* ============ 3. 「通用」页签主色调（需求14 已知问题） ============ */
  log('\n=== [3] 需求14：「通用」页签主色调是否生效 ===');
  await openSettingsTab('通用');
  const accentBefore = await readTheme();
  const swatches = page.locator('.swatches .swatch');
  const swCount = await swatches.count();
  log(`  主色调色块数=${swCount}，当前 --accent=${accentBefore.computed.accent} store.accent=${JSON.stringify(accentBefore.stored.accent)}`);
  if (swCount > 1) {
    await swatches.nth(1).click();
    await page.waitForTimeout(800);
    const accentAfter = await readTheme();
    log(
      `  点击第 2 个色块后：--accent=${accentAfter.computed.accent} store.accent=${JSON.stringify(accentAfter.stored.accent)}`,
    );
    log(
      `  ${accentAfter.computed.accent !== accentBefore.computed.accent ? '✓ 生效' : '✗ 未生效 —— 这就是需求14 的「主色调不生效」'}`,
    );
  }

  /* ============ 4. 颜色细化是否生效（需求13） ============ */
  log('\n=== [4] 需求13：颜色细化改动是否影响真实界面 ===');
  await openSettingsTab('主题');
  const before13 = await readTheme();
  log(`  改前：preset=${before13.preset} --content-bg=${before13.computed.contentBg} --accent=${before13.computed.accent}`);
  const colorInputs = page.locator('[data-testid="theme-colors"] input[type="color"]');
  const colorCount = await colorInputs.count();
  log(`  颜色细化输入框数=${colorCount}`);
  if (colorCount >= 1) {
    // 改「正文背景」为一个很显眼的颜色
    const targetColor = '#ff00aa';
    await colorInputs.nth(0).evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, targetColor);
    await page.waitForTimeout(600);
    const afterEdit = await readTheme();
    log(`  仅改草稿后：--content-bg=${afterEdit.computed.contentBg}（期望仍是改前值，因为草稿不落盘）`);
    const previewPaper = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="theme-preview"] .theme-preview__paper');
      return el ? getComputedStyle(el).backgroundColor : null;
    });
    log(`  预览容器 paper 背景=${previewPaper}（期望已变成草稿色）`);
    // 点保存
    const saveBtn = page.locator('.color-grid >> xpath=../..').locator('button').filter({ hasText: /存为新主题|保存配色/ }).first();
    const saveCount = await saveBtn.count();
    log(`  保存按钮存在=${saveCount > 0}`);
    if (saveCount) {
      await saveBtn.click();
      await page.waitForTimeout(1200);
      const afterSave = await readTheme();
      log(
        `  保存后：preset=${afterSave.preset} --content-bg=${afterSave.computed.contentBg} --accent=${afterSave.computed.accent} ` +
          `customThemes=${afterSave.stored.customThemesCount}`,
      );
      log(`  ${afterSave.computed.contentBg === targetColor || afterSave.inline.contentBg === targetColor ? '✓ 生效' : '✗ 未生效'}`);
    }
  }

  /* ============ 5. 保存按钮语义现状（需求16 基线） ============ */
  log('\n=== [5] 需求16：现状有没有「保存」按钮 / 是否即时生效 ===');
  const saveBar = await page.evaluate(() => ({
    fixedSaveBar: document.querySelectorAll('[data-testid="settings-save-bar"]').length,
    hintText: document.querySelector('.settings-page__hint')?.textContent?.trim() ?? null,
    savedHintVisible: !!document.querySelector('.saved-hint'),
  }));
  log(`  固定保存栏=${saveBar.fixedSaveBar}；页面提示=${JSON.stringify(saveBar.hintText)}；即时反馈条=${saveBar.savedHintVisible}`);

  log('\n=== 控制台错误（前 10） ===');
  for (const e of consoleErrors.slice(0, 10)) log(`  - ${e}`);
  if (!consoleErrors.length) log('  （无）');
} catch (e) {
  log(`\n[ERROR] ${e?.stack ?? e}`);
} finally {
  let restoredOk = false;
  for (let attempt = 1; attempt <= 3 && !restoredOk; attempt += 1) {
    try {
      const ver = await apiJson('/api/settings/version');
      const currentVersion = Number(ver.body?.data?.version ?? 0);
      const put = await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          payload: {
            global: { appearance: snapshot.globalAppearance },
            platform: { [PLATFORM]: { appearance: snapshot.platformAppearance } },
          },
          version: currentVersion,
          platform: PLATFORM,
        }),
      });
      const after = await readRemoteAppearance(GLOBAL_PROBE);
      const afterFlat = await readRemoteAppearance(PLATFORM);
      const diffs = [];
      for (const [k, v] of Object.entries(snapshot.globalAppearance)) {
        if (JSON.stringify(after.appearance?.[k]) !== JSON.stringify(v)) {
          diffs.push(`global.${k}`);
        }
      }
      for (const [k, v] of Object.entries(snapshot.platformAppearance)) {
        if (JSON.stringify(afterFlat.appearance?.[k]) !== JSON.stringify(v)) {
          diffs.push(`platform.${k}`);
        }
      }
      restoredOk = diffs.length === 0;
      log(
        `\n还原（第 ${attempt} 次）：HTTP ${put.status}；${restoredOk ? '全部已还原' : `差异 ${diffs.length} 项：${diffs.join(',')}`}`,
      );
      if (!restoredOk) await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      log(`\n[WARN] 还原第 ${attempt} 次失败：${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!restoredOk) {
    log(`\n[!!] 还原未成功，快照在 ${SNAPSHOT_FILE}`);
  }
  try {
    if (snapshot.localStorage) {
      await page.evaluate((snap) => {
        for (const [k, v] of Object.entries(snap)) {
          if (v === null || v === undefined) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        }
      }, snapshot.localStorage);
      log('本机 localStorage 快照已回写。');
    }
  } catch {
    /* 页面已关闭 */
  }
  await ctx.close().catch(() => {});
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}
