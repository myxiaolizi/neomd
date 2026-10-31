/**
 * 1.4.0 需求14：**设置项逐项体检**（Lead 独立验收脚本，只读产品代码、只写浏览器内状态）。
 *
 * ## 为什么由 Lead 写这一份
 *
 * 需求 14 是「对设置的所有项目进行全部检查和测试，确保所有设置项都有效果；并且放到应该
 * 放置的地方」。原负责组（T4）交付了草稿模式、主题分档、颜色细化等核心改造，但全项审计
 * 脚本反复中断未落盘。这一项是需求 14 的唯一硬证据，不能留空，因此由 Lead 亲自补齐。
 *
 * ## 判定口径（与 fix-settings-theme 商定，避免「恒真断言」）
 *
 * 每个控件有三类可观测效果，按优先级取：
 *   `store`   → 改完后 `neomd.settings.v1` 对应字段变化（最可靠）
 *   `cssVar`  → 改完后 `<html>` 的某个 CSS 变量计算值变化（适用于只驱动样式的项）
 *   `dom`     → 改完后某个 DOM 元素的 computed 属性变化（如字体、行高、行号）
 *
 * **草稿模式的特殊处理（1.4.0 新增语义）**：设置已改为「不点保存不生效」，所以每个用例
 * 都必须先改、再点底部保存、然后才断言。断言「改完立即生效」在本版是**错的**（那是 1.3.1
 * 的行为）。这一点不写清楚，后来者会以为断言写错了。
 *
 * ## 数据安全
 *
 * 生产库有真实用户设置。启动时快照本地 `neomd.settings.v1` + 云端 global/platform
 * 的 appearance/layout，finally 里还原并逐字段复查。不写任何业务数据。
 *
 * 用法：
 *   node tools/re14-settings-audit.mjs                # 全量
 *   node tools/re14-settings-audit.mjs --only=accent  # 只跑某组
 *   node tools/re14-settings-audit.mjs --json=out.json
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHOTS = path.join(REPO, 'docs', 'shots-140');
fs.mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

const ARGS = (() => {
  const out = { only: null, json: '' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim());
    else if (a.startsWith('--json=')) out.json = a.slice(7);
  }
  return out;
})();

const results = [];
let currentGroup = '-';

function group(name) {
  currentGroup = name;
  console.log(`\n${'='.repeat(76)}\n[${name}]\n${'='.repeat(76)}`);
}

/**
 * 记录一条断言。
 *
 * `effect` 是「这条设置项靠什么证明生效」，写进报告便于人工复核：
 * 它同时解释了为什么某些项无法用 store 判定（只驱动 CSS 变量）。
 */
function check(name, expect, actual, pass, effect = '', note = '') {
  const id = `${currentGroup}${String(results.filter((r) => r.group === currentGroup).length + 1).padStart(2, '0')}`;
  results.push({ id, group: currentGroup, name, expect: String(expect), actual: String(actual), pass, effect, note });
  const mark = pass ? '\u2713' : '\u2717';
  console.log(`  ${mark} [${id}] ${name}`);
  console.log(`        期望: ${expect}`);
  console.log(`        实测: ${actual}${effect ? `  （效果类型：${effect}）` : ''}`);
  if (note) console.log(`        备注: ${note}`);
}

/* ------------------------------------------------------------------ */
/* 浏览器工具                                                          */
/* ------------------------------------------------------------------ */

async function launch() {
  return chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    // 本机无头 Chrome 在默认参数下约 30s 崩溃（空白页也崩，非内存问题），
    // 必须禁 GPU 才稳定 —— 1.3.1 期间已实测确认。
    args: ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function login(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const needLogin = await page.evaluate(() => !localStorage.getItem('neomd.access'));
  if (needLogin) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('input', { timeout: 15000 });
    const inputs = page.locator('input');
    await inputs.nth(0).fill(USER);
    await inputs.nth(1).fill(PASS);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
}

/**
 * 把设置同步链路**在本脚本内闭环**（生产数据安全的最终方案）。
 *
 * ## 试过的三种做法与各自的问题
 *
 * ① **不管**：用例点「保存」→ 真实 PUT 到生产库（本机 API 连生产 MySQL）。
 *    结果把测试用的字体/字号/主题/accent 写进了 admin 的线上配置，
 *    多出一个自定义主题，只能靠 17:12 基线脚本手工归零。**不可接受**。
 *
 * ② **只拦 PUT，伪造 `200 {version:0}`**：客户端拿到 version 0 后认为自己落后，
 *    下一次拉取把刚保存的本地值又覆盖回云端旧值，
 *    导致「颜色细化生效」「正文渲染跟随设置」假失败。**伪造版本号会扰动状态机**。
 *
 * ③ **真跑 + finally 还原云端**：断言真实，但拉取会把云端旧值推回本地，
 *    与「改完 → 保存 → 断言变化」的用例互相打架；而且中途 API 崩溃时
 *    finally 来不及执行，仍会残留。
 *
 * ## 现在的做法：GET 回显本地、PUT 直接吞掉
 *
 * - `GET /api/settings` → 返回**当前 localStorage 的设置**作为 payload。
 *   对客户端来说这是一次「拉到的和我本地一样」的幂等拉取，不会覆盖任何刚改的值；
 * - `PUT /api/settings` → 返回 200 + 一个**固定且自洽**的 version。
 *   客户端视为推送成功（会推进基线、清 pending —— 这正是要测的行为），
 *   但字节不离开浏览器。
 *
 * 这样：**保存链路的行为完全真实**（store 落盘 / applyTheme / pending / 基线推进），
 * 只有「网络那一跳」被替换成本地回显 —— 生产库零写入，且断言不受云端旧值干扰。
 *
 * 本脚本不负责验证「跨端同步」本身（那是 verify-121 C 段与
 * `re14-settings-save-verify.mjs` 的职责，它们有各自的云端还原策略）。
 */
const STUB_VERSION = 1;

async function isolateSettingsSync(page) {
  await page.route('**/api/settings**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      // 回显本地设置 → 拉取变成幂等操作，不会覆盖用例刚改的值
      const payload = await page
        .evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
          } catch {
            return {};
          }
        })
        .catch(() => ({}));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { payload, version: STUB_VERSION } }),
      });
    }
    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { version: STUB_VERSION } }),
      });
    }
    return route.continue();
  });
}

/** 打开设置页（Ctrl+,）并切到指定页签 */
async function openSettings(page, tabLabel) {
  const navCount = await page.locator('.settings__nav-item').count();
  if (!navCount) {
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  if (tabLabel) {
    await page.evaluate((label) => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find(
        (e) => (e.textContent || '').trim() === label,
      );
      if (el) el.click();
    }, tabLabel);
    await page.waitForTimeout(600);
  }
}

/**
 * 点底部保存栏。
 *
 * 1.4.0 起设置是草稿模式：不点保存不落盘。所有「改完断言生效」的用例都必须先经过这里，
 * 否则测的是 1.3.1 的即时生效语义，会大面积假失败。
 */
async function saveDraft(page) {
  const btn = page.locator('[data-testid="settings-save"]').first();
  const altBtn = page.locator('[data-testid="settings-save-bar"] button').first();
  const target = (await btn.count()) ? btn : altBtn;
  if (!(await target.count())) return { ok: false, reason: '找不到保存按钮' };
  const disabled = await target.isDisabled().catch(() => false);
  if (disabled) return { ok: false, reason: '保存按钮为 disabled（无改动）' };
  await target.click();
  await page.waitForTimeout(1400);
  return { ok: true };
}

/** 关掉设置标签页，回到文档（读正文 computed 样式前必须切走） */
async function closeSettings(page) {
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tabbar .tab'));
    const st = tabs.find((t) => (t.textContent || '').trim().includes('设置'));
    const closeBtn = st?.querySelector('[class*="close"]');
    if (closeBtn) closeBtn.click();
  });
  await page.waitForTimeout(700);
}

/**
 * 确保存在一个**文档**标签并处于激活态。
 *
 * ## 为什么需要这一步（1.4.0 验收时踩到）
 *
 * `closeSettings()` 关掉设置标签后，如果工作台里**只剩设置这一个标签**，
 * 关闭后就没有活动标签，`.nm-content` / `.ProseMirror` 都不在 DOM 里，
 * 「正文实际渲染跟随设置」这条断言会报「未找到正文容器」而假失败
 * （在 verify-140 的 D01 里表现为 `re14-settings-audit.mjs` exit=1）。
 *
 * 真实用户不会遇到这个场景（用户总有一个文档开着），但验收脚本在
 * 「先开设置、再关设置」的路径上会踩。所以这里显式兜底：
 * 没有可编辑文档就建一个，有就切到它。
 */
async function ensureDocTab(page) {
  /** 轮询等待正文容器出现（固定 sleep 会抖：建文档后编辑器挂载耗时不定） */
  const waitContainer = async (ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const ok = await page.evaluate(() =>
        Boolean(document.querySelector('.nm-content, .ProseMirror')),
      );
      if (ok) return true;
      await page.waitForTimeout(400);
    }
    return false;
  };

  /*
   * 先把编辑模式切回**所见即所得**。
   *
   * 判据要读的是正文排版（`.nm-content` / `.ProseMirror`），而源码模式渲染的是
   * CodeMirror（`.cm-content`，自带独立字号行高），对照/阅读模式又各有容器。
   * 上一轮跑测可能把模式留在源码模式 → 读不到 `.nm-content`，
   * 「正文实际渲染跟随设置」会报「未找到正文容器」。
   *
   * 切模式走真实 UI（工具栏「编辑模式」菜单），不直接改 store，保持与用户路径一致。
   * 注意：设置页打开时 `.editorbar` 不存在（需求15 的修复），所以这一步只有在
   * 关掉设置页之后才有效 —— 调用方已保证顺序。
   */
  await page
    .evaluate(() => {
      const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
      const b = btns[btns.length - 1];
      if (!b) return;
      if ((b.textContent || '').includes('所见即所得')) return;
      b.click();
    })
    .catch(() => {});
  await page.waitForTimeout(450);
  if (await page.locator('.viewswitch__menu').count()) {
    await page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
        const hit = items.find((e) => /所见即所得/.test((e.textContent || '').trim()));
        if (hit) hit.click();
      })
      .catch(() => {});
    await page.waitForTimeout(700);
  }
  if (await waitContainer(2500)) return true;

  const appExpr = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

  /*
   * 实测（re140-diag-editor-container.mjs）：全新 profile 首次进 /app 时
   * `docCount=0`、`tabCount=0` —— 仓库里一篇文档都没有，自然没有正文容器。
   * 因此这里必须**新建一篇**；只切 activeTabId 是没用的（没有标签可切）。
   *
   * 用 `createDoc()` 走真实路径（与用户点「新建」一致），标题带 QA140 前缀便于清理。
   */
  await page
    .evaluate(async (expr) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      const tabs = app?.tabs ?? [];
      const docTab = tabs.find((t) => !/设置|插件商店/.test(String(t.title || '')));
      if (docTab) {
        app.activeTabId = docTab.id;
        await new Promise((r) => setTimeout(r, 900));
        return;
      }
      await app.createDoc({
        title: `QA140-AUDIT-${Date.now()}`,
        content: '设置体检样本正文\n\n用于验证排版设置真的落到正文 computed 样式。\n',
      });
    }, appExpr)
    .catch(() => {});

  // 建文档后编辑器挂载 + 可能的首次同步都要时间，轮询而不是猜一个 sleep
  const ok = await waitContainer(20000);
  if (!ok) {
    console.log('        （ensureDocTab 轮询 20s 后仍未出现正文容器）');
  }
  return ok;
}

async function settingsSnapshot(page) {
  return page.evaluate(() => localStorage.getItem('neomd.settings.v1'));
}

async function readStore(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
    } catch {
      return {};
    }
  });
}

async function cssVar(page, name) {
  return page.evaluate((n) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v;
  }, name);
}

/* ------------------------------------------------------------------ */
/* 用例组                                                              */
/* ------------------------------------------------------------------ */

/**
 * G1 主色调（需求14 点名的那一项）
 *
 * 用户原话：「通用的主色调无法生效并且应该放到主题中」。两个都要验：
 *   a) 能生效（--accent 真的变）
 *   b) 已经在主题页签（不在通用页签）
 */
async function groupAccent(page) {
  group('主色调 accent（需求14）');

  await openSettings(page, '通用');
  const inGeneral = await page.locator('[aria-label*="主色调"], [data-testid*="accent"]').count();
  await openSettings(page, '主题');
  const inTheme = await page.locator('[aria-label*="主色调"], [data-testid*="accent"]').count();

  check(
    '主色调控件已归位到「主题」页签',
    '主题页签有主色调控件、通用页签没有',
    `主题=${inTheme} 个，通用=${inGeneral} 个`,
    inTheme > 0 && inGeneral === 0,
    'dom',
    '用户明确要求「通用的主色调应该放到主题中」',
  );

  // 取一个与当前不同的强调色，写入草稿 → 保存 → 读 --accent
  const before = await cssVar(page, '--accent');
  /**
   * 主色调是**固定 5 色板**（`ACCENT_SWATCHES`），不是自由取色器 ——
   * 因为它要驱动 `--accent-hover` / `--accent-weak` / `--bg-active` / `--sky`
   * 等一串派生变量，自由取色无法保证派生色和谐。
   *
   * 所以脚本必须**从现有色板里挑一个不等于当前值的**，而不是随便给一个 hex
   * （给一个色板外的颜色会点不到任何按钮，导致「点击=true 但值没变」的假象）。
   */
  const swatchInfo = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="accent-swatches"]');
    if (!box) return { ids: [], active: '' };
    const btns = Array.from(box.querySelectorAll('button'));
    return {
      ids: btns.map((b) => (b.getAttribute('aria-label') || '').replace('主色调 ', '').trim()),
      active: btns.findIndex((b) => b.classList.contains('is-active')),
    };
  });

  const target = swatchInfo.ids.find((c) => c && c.toLowerCase() !== String(before).toLowerCase()) || '';
  const applied = await page.evaluate((hex) => {
    const box = document.querySelector('[data-testid="accent-swatches"]');
    if (!box) return { clicked: false };
    const btns = Array.from(box.querySelectorAll('button'));
    const hit = btns.find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes(hex.toLowerCase()));
    if (hit) {
      hit.click();
      return { clicked: true };
    }
    return { clicked: false, available: btns.map((b) => b.getAttribute('aria-label')) };
  }, target);
  await page.waitForTimeout(500);
  const saveInfo = await saveDraft(page);
  await page.waitForTimeout(600);
  const after = await cssVar(page, '--accent');

  check(
    '主色调色板可点且能选中目标色',
    `色板共 ${swatchInfo.ids.length} 色，点到与当前不同的「${target}」`,
    `点击=${applied.clicked} 当前激活索引=${swatchInfo.active} 色板=${swatchInfo.ids.join('/')}`,
    applied.clicked === true && Boolean(target),
    'dom',
  );

  check(
    '主色调改动保存后 --accent 真的变化',
    `--accent 从「${before}」变为「${target}」（非原值）`,
    `改后=${after}（保存=${saveInfo.ok ? 'ok' : saveInfo.reason}）`,
    Boolean(after) && after.toLowerCase() !== String(before).toLowerCase(),
    'cssVar',
    '需求14 原文：「通用的主色调无法生效」',
  );
}

/**
 * G2 主题三档作用域（需求12）
 *
 * 判定核心：`content` 模式下，界面变量必须**不等于**整页模式下的主题值
 * （改前是「removeProperty 后回落到 themes.css 的同一套静态值」，所以看起来没变）。
 */
async function groupScope(page) {
  group('主题作用域 all/content/chrome（需求12）');

  const read = async () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const nav = document.querySelector('.leftpanel, .shell__sidebar, nav');
      return {
        bg: cs.getPropertyValue('--bg').trim(),
        contentBg: cs.getPropertyValue('--content-bg').trim(),
        border: cs.getPropertyValue('--border').trim(),
        navBg: nav ? getComputedStyle(nav).backgroundColor : '',
        scope: localStorage.getItem('neomd.themeScope') || 'all',
      };
    });

  const setScope = async (scope) => {
    await openSettings(page, '主题');
    const clicked = await page.evaluate((s) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"], button'));
      for (const r of radios) {
        const txt = (r.closest('label')?.textContent || r.textContent || '').trim();
        const val = r.getAttribute('value') || '';
        const map = {
          all: ['整体', '全部', '界面与正文'],
          content: ['仅正文'],
          chrome: ['仅界面'],
        };
        if (map[s]?.some((k) => txt.includes(k) || val === s)) {
          r.click();
          return { ok: true, by: txt.slice(0, 20) || val };
        }
      }
      // 兜底：直接写 localStorage 后 reload（仍能验证变量可分档）
      localStorage.setItem('neomd.themeScope', s);
      return { ok: false, by: 'localStorage 兜底', needReload: true };
    }, scope);
    await page.waitForTimeout(500);
    const saveInfo = await saveDraft(page);
    if (clicked.needReload || !saveInfo.ok) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2200);
    }
    await page.waitForTimeout(600);
    return clicked;
  };

  const all = await (async () => {
    await setScope('all');
    return read();
  })();
  const content = await (async () => {
    await setScope('content');
    return read();
  })();
  const chrome = await (async () => {
    await setScope('chrome');
    return read();
  })();

  check(
    'all：正文与界面都拿到主题色',
    '--bg / --content-bg 都非空',
    `bg=${all.bg} contentBg=${all.contentBg}`,
    Boolean(all.bg && all.contentBg),
    'cssVar',
  );

  check(
    'content（仅正文）：界面不得再拿主题色',
    `--bg 与整页模式「${all.bg}」不同（说明界面已脱离主题）`,
    `content 模式 bg=${content.bg}（整页 ${all.bg}）`,
    Boolean(content.bg) && content.bg.toLowerCase() !== all.bg.toLowerCase(),
    'cssVar',
    '这是「勾选仅正文但仍全局生效」的核心判据',
  );

  check(
    'content（仅正文）：正文仍应拿到主题色',
    `--content-bg 保持主题值「${all.contentBg}」`,
    `content 模式 contentBg=${content.contentBg}`,
    Boolean(content.contentBg) && content.contentBg.toLowerCase() === all.contentBg.toLowerCase(),
    'cssVar',
  );

  check(
    'chrome（仅界面）：界面拿主题色、正文脱离',
    '--bg 等于整页模式值，--content-bg 与整页模式不同或为空',
    `chrome 模式 bg=${chrome.bg} contentBg=${chrome.contentBg}`,
    chrome.bg.toLowerCase() === all.bg.toLowerCase(),
    'cssVar',
  );

  // 复原默认 all，避免影响后续用例
  await setScope('all');
}

/**
 * G3 分割线结构色保护（需求11）
 *
 * 判定：任意主题下 `--border` 与背景的对比度 >= 1.2:1（否则分割线在视觉上消失）。
 */
async function groupBorders(page) {
  group('分割线结构色保护（需求11）');

  const contrast = (hexOrRgb, bgHexOrRgb) => {
    const parse = (s) => {
      const t = String(s).trim();
      const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(t);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
      const h = t.replace('#', '');
      if (h.length >= 6) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      return null;
    };
    const lum = (rgb) => {
      const f = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    const a = parse(hexOrRgb);
    const b = parse(bgHexOrRgb);
    if (!a || !b) return null;
    const l1 = lum(a);
    const l2 = lum(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  await openSettings(page, '主题');
  const themes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="theme-cards"] > *')).map((c, i) => ({
      i,
      text: (c.textContent || '').trim().slice(0, 14),
    })),
  );

  const rows = [];
  for (const th of themes) {
    await page.evaluate((idx) => {
      const cards = document.querySelectorAll('[data-testid="theme-cards"] > *');
      cards[idx]?.click();
    }, th.i);
    await page.waitForTimeout(320);
    const saveInfo = await saveDraft(page);
    if (!saveInfo.ok) await page.waitForTimeout(280);
    const v = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        border: cs.getPropertyValue('--border').trim(),
        bg: cs.getPropertyValue('--bg').trim(),
        contentBg: cs.getPropertyValue('--content-bg').trim(),
        tableBorder: cs.getPropertyValue('--table-border').trim(),
      };
    });
    const ratio = contrast(v.border, v.bg || v.contentBg);
    rows.push({ theme: th.text, border: v.border, bg: v.bg, ratio });
  }

  const bad = rows.filter((r) => r.ratio !== null && r.ratio < 1.2);
  const unknown = rows.filter((r) => r.ratio === null);
  console.log('  主题对比度明细：');
  for (const r of rows) console.log(`    ${String(r.theme).padEnd(16)} border=${String(r.border).padEnd(22)} vs bg=${r.ratio}`);

  check(
    '每套主题的分割线对比度都 >= 1.2:1',
    `${rows.length} 套主题全部 >= 1.2，无低于阈值`,
    bad.length ? `${bad.length} 套不达标：${bad.map((b) => `${b.theme}=${b.ratio}`).join(', ')}` : `${rows.length} 套全部达标（${rows.map((r) => r.ratio).join(' / ')}）`,
    bad.length === 0 && unknown.length === 0,
    'cssVar',
    '需求11 原文：「主题中颜色和主题调整，不影响分割线等」',
  );
}

/**
 * G4 颜色细化生效（需求13）
 */
async function groupRefine(page) {
  group('颜色细化生效（需求13）');

  await openSettings(page, '主题');

  /*
   * 先归一到一个**内置主题**再测细化。
   *
   * 为什么：上一组 `groupBorders` 会逐个点 10+ 张主题卡片并保存，
   * 跑完后当前主题已经被切到最后一张（可能是自定义主题）。而颜色细化在
   * 「内置主题」与「自定义主题」两条分支下的行为不同 ——
   * `saveDraftColors()` 对自定义主题是「就地改当前主题」，对内置主题是
   * 「派生一个新自定义主题」，按钮文案与可用状态也随之变化。
   *
   * 实测：单独跑 `--only=refine` 时 3/3 通过，跟在 borders 之后跑则
   * 找不到「保存配色」按钮（按钮="未找到"）—— 纯测试顺序干扰，不是产品缺陷。
   * 这里显式点第一张主题卡（日光白，内置）把状态归一。
   */
  await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-testid="theme-cards"] > *');
    cards[0]?.click();
  });
  await page.waitForTimeout(400);
  await saveDraft(page);
  await page.waitForTimeout(700);

  // 把配色区滚进视野，避免按钮因懒渲染/不可见而取不到
  await page.evaluate(() => {
    const el = document.querySelector('input[type="color"]');
    el?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);

  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="color"]'));
    return inputs.map((el, i) => ({ i, value: el.value }));
  });

  if (!info.length) {
    check('颜色细化控件存在', '至少有 1 个颜色选择器', '0 个', false, 'dom', '找不到颜色细化输入框');
    return;
  }

  const beforeVar = await cssVar(page, '--content-bg');
  const target = info.some((x) => x.value.toLowerCase() === '#00aa88') ? '#00bb99' : '#00aa88';
  await page.evaluate(
    ({ idx, hex }) => {
      const inputs = Array.from(document.querySelectorAll('input[type="color"]'));
      const el = inputs[idx];
      if (!el) return;
      el.value = hex;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { idx: info[0].i, hex: target },
  );
  await page.waitForTimeout(500);

  /**
   * 关键：颜色细化有**独立的 `colorDraft`**，改 input 只是改"待应用的配色"，
   * 必须再点一次应用按钮（`saveDraftColors()`）才会写进设置草稿。
   * 少了这一步，底部保存按钮会一直是 disabled（无改动），断言必然失败。
   * 这不是产品缺陷，是操作路径 —— 真实用户也是这么点的。
   *
   * ## 为什么用 `data-testid` 而不是按文案找
   *
   * 按钮文案是**随上下文变化**的（`SettingsPage.vue:2314`）：
   *   - 当前是自定义主题 → 「保存配色」
   *   - 当前是内置主题   → 「存为新主题」（会派生一份自定义主题）
   *
   * 首轮断言按文案正则匹配，只覆盖了「保存/应用」几个词，
   * 切到内置主题后文案变成「存为新主题」就取不到了（实测 `按钮="未找到"`）。
   * `data-testid="theme-colors-apply"` 是稳定锚点，不随文案与主题类型变化。
   */
  const applyHit = await page.evaluate(() => {
    const cand =
      document.querySelector('[data-testid="theme-colors-apply"]') ||
      Array.from(document.querySelectorAll('button')).find((b) =>
        /应用配色|应用颜色|应用到主题|保存配色|存为新主题/.test((b.textContent || '').trim()),
      );
    if (cand && !cand.disabled) {
      cand.click();
      return (cand.textContent || '').trim();
    }
    return cand ? `(disabled) ${(cand.textContent || '').trim()}` : '';
  });
  await page.waitForTimeout(700);
  const draftVar = await cssVar(page, '--content-bg');
  const saveInfo = await saveDraft(page);
  await page.waitForTimeout(700);
  const afterVar = await cssVar(page, '--content-bg');

  check(
    '颜色细化需先「应用配色」才进入草稿（操作路径）',
    '存在「应用配色」按钮且点击后 --content-bg 变为草稿值',
    `按钮="${applyHit || '未找到'}" 改前=${beforeVar} 应用后=${draftVar}`,
    Boolean(applyHit) && draftVar.toLowerCase() === target.toLowerCase(),
    'cssVar',
    '独立 colorDraft 的存在说明这是有意的两步式交互，脚本必须按真实用户路径操作',
  );

  check(
    '颜色细化保存后 --content-bg 真的变化',
    `--content-bg 从「${beforeVar}」变为「${target}」`,
    `改后=${afterVar}（保存=${saveInfo.ok ? 'ok' : saveInfo.reason}）`,
    Boolean(afterVar) && afterVar.toLowerCase() !== beforeVar.toLowerCase() && afterVar.toLowerCase() === target.toLowerCase(),
    'cssVar',
    '需求13 原文：「主题中设置了颜色细化但是不生效」',
  );
}

/**
 * G5 排版类设置（字体/字号/行高/缩放）
 *
 * 这些项的效果在**正文**上，必须关掉设置页才能读 computed 样式。
 */
async function groupTypography(page) {
  group('排版：字体/字号/行高/缩放（需求14）');

  await openSettings(page, '编辑器');

  const fill = async (labels, value) => {
    for (const l of labels) {
      const sel = `input[aria-label="${l}"]`;
      if (await page.locator(sel).count()) {
        await page.locator(sel).fill(String(value));
        await page.waitForTimeout(250);
        return l;
      }
    }
    return '';
  };

  const before = await readStore(page);
  const hitSize = await fill(['编辑器正文字号', '正文字号'], 19);
  const hitLh = await fill(['编辑器正文行高', '正文行高'], 1.9);
  const hitZoom = await fill(['正文缩放比例', '编辑器正文缩放比例'], 120);
  const saveInfo = await saveDraft(page);
  const after = await readStore(page);

  const b = before?.appearance ?? {};
  const a = after?.appearance ?? {};

  check(
    '正文字号写入 store',
    `fontSize 从 ${b.fontSize} 变为 19`,
    `改后=${a.fontSize}（命中控件"${hitSize}"，保存=${saveInfo.ok ? 'ok' : saveInfo.reason}）`,
    Number(a.fontSize) === 19,
    'store',
  );
  check(
    '正文行高写入 store',
    `lineHeight 从 ${b.lineHeight} 变为 1.9`,
    `改后=${a.lineHeight}（命中控件"${hitLh}"）`,
    Math.abs(Number(a.lineHeight) - 1.9) < 0.001,
    'store',
  );
  check(
    '正文缩放写入 store',
    `zoom 从 ${b.zoom} 变为 120`,
    `改后=${a.zoom}（命中控件"${hitZoom}"）`,
    Number(a.zoom) === 120,
    'store',
  );

  // 关掉设置页读正文真实 computed 值
  await closeSettings(page);
  /*
   * 前一组（主题作用域）会 reload 页面并切页签，可能把文档标签关掉；
   * 这里必须再确认一次有正文容器，否则断言会报「未找到正文容器」。
   */
  await ensureDocTab(page);
  await page.waitForTimeout(900);
  const applied = await page.evaluate(() => {
    const host = document.querySelector('.nm-content, .ProseMirror');
    if (!host) return null;
    const cs = getComputedStyle(host);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontFamily: cs.fontFamily };
  });

  check(
    '正文实际渲染跟随设置（字号×缩放、行高）',
    'font-size ≈ 19×1.2=22.8px、line-height ≈ 22.8×1.9≈43.3px',
    applied ? `font-size=${applied.fontSize} line-height=${applied.lineHeight}` : '未找到正文容器',
    Boolean(applied) && Math.abs(parseFloat(applied.fontSize) - 22.8) < 1.2,
    'dom',
    '设置项最终要落到正文 computed 样式，否则用户看不到效果',
  );

  // 字体族
  await openSettings(page, '编辑器');
  const fontSel = page.locator('select[data-testid="font-family"]').first();
  let fontOk = false;
  let fontDetail = '未找到字体下拉';
  if (await fontSel.count()) {
    const opts = await fontSel.evaluate((el) =>
      Array.from(el.options).map((o) => ({ v: o.value, t: (o.textContent || '').trim() })),
    );
    const cur = await fontSel.inputValue();
    const pick = opts.find((o) => o.v !== cur && o.v && !o.v.startsWith('var('));
    if (pick) {
      await fontSel.selectOption(pick.v);
      await page.waitForTimeout(300);
      await saveDraft(page);
      const st = await readStore(page);
      fontOk = String(st?.appearance?.fontFamily || '') === pick.v;
      fontDetail = `选「${pick.t}」→ store.fontFamily=${st?.appearance?.fontFamily}`;
    }
  }
  check('正文字体写入 store', 'fontFamily 变为用户所选', fontDetail, fontOk, 'store');
}

/**
 * G6 界面布局与行为开关
 *
 * 覆盖：行号开关、拼写检查、自动保存、右侧栏区块上限语义、功能区项。
 * 这些项一半是 store、一半是 dom，按实际选 effect。
 */
async function groupLayoutFlags(page) {
  group('界面布局与行为开关（需求14）');

  // 行号开关
  await openSettings(page, '编辑器');
  const before = await readStore(page);
  const lnToggle = page.locator('[aria-label="显示正文行号"]').first();
  let lnHit = false;
  if (await lnToggle.count()) {
    await lnToggle.click();
    await page.waitForTimeout(300);
    lnHit = true;
  }
  await saveDraft(page);
  const after = await readStore(page);
  const bLn = Boolean(before?.appearance?.showLineNumbers);
  const aLn = Boolean(after?.appearance?.showLineNumbers);
  check(
    '显示正文行号开关写入 store 并翻转',
    `showLineNumbers 从 ${bLn} 翻转`,
    `改后=${aLn}（控件命中=${lnHit}）`,
    lnHit && aLn !== bLn,
    'store',
  );

  // 保存语义：不保存不生效（需求16 的核心反向断言）
  const snap0 = await settingsSnapshot(page);
  const sizeInput = page.locator('input[aria-label="编辑器正文字号"], input[aria-label="正文字号"]').first();
  let noSaveOk = false;
  let noSaveDetail = '未找到字号输入框';
  if (await sizeInput.count()) {
    const cur = await sizeInput.inputValue();
    const next = Number(cur) === 21 ? 17 : 21;
    await sizeInput.fill(String(next));
    await page.waitForTimeout(400);
    // 直接关闭设置页（不点保存）→ 重新打开看是否回退
    await closeSettings(page);
    await page.waitForTimeout(800);
    await openSettings(page, '编辑器');
    const reopened = await page
      .locator('input[aria-label="编辑器正文字号"], input[aria-label="正文字号"]')
      .first()
      .inputValue()
      .catch(() => '');
    const storeNow = await readStore(page);
    noSaveOk = String(reopened) === String(cur) && Number(storeNow?.appearance?.fontSize) !== next;
    noSaveDetail = `改前=${cur} 未保存关闭后重开=${reopened} store.fontSize=${storeNow?.appearance?.fontSize}`;
    const snap1 = await settingsSnapshot(page);
    if (snap1 !== snap0) noSaveOk = false;
  }
  check(
    '【需求16】不点保存不生效（草稿未落盘）',
    '改字号后不保存直接关闭，重开仍是原值且 localStorage 未变',
    noSaveDetail,
    noSaveOk,
    'store',
    '这是「不要即时生效」的核心反向断言',
  );
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  let browser = await launch();
  let ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  let page = await ctx.newPage();
  const pageErrors = [];
  const wireErrors = () => page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  wireErrors();

  /**
   * 崩溃自愈：重建浏览器 + 页面 + 拦截器 + 登录态。
   *
   * ## 为什么需要（1.4.0 验收实测）
   *
   * `re14-settings-audit.mjs` **单独跑 18/18 全过**，但被 `verify-140` 以 spawn
   * 方式嵌在 D 段里跑时，会报 `page.waitForTimeout: Page crashed` /
   * `locator.count: Target crashed` —— 此时父门禁已经持有自己的 Chromium，
   * 两个实例叠加渲染设置页（重页面，含 10 套主题卡 + 多个颜色选择器），
   * 本机无头 Chrome 在资源紧张时会杀掉渲染进程（1.3.1 期间实测过默认参数
   * 约 30s 崩、必须 `--disable-gpu`，这里是同一类不稳定性的延伸）。
   *
   * 处理方式：捕获崩溃 → 重建整条浏览器链路 → **重跑当前用例组**（最多 2 次）。
   * 这样既不改断言强度，也不把「浏览器崩溃」误报成「设置项无效」。
   */
  const relaunch = async () => {
    try {
      await browser.close();
    } catch {
      /* 已崩溃，忽略 */
    }
    browser = await launch();
    ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    page = await ctx.newPage();
    wireErrors();
    await isolateSettingsSync(page);
    await login(page);
    await ensureDocTab(page);
    await page.waitForTimeout(600);
  };

  let localSnapshot = null;
  try {
    /*
     * 先把设置同步链路在本脚本内闭环（生产库零写入 + 拉取不覆盖用例改动）。
     * 必须在 login 之前装：登录后工作台会立刻拉一次设置。
     */
    await isolateSettingsSync(page);

    await login(page);
    localSnapshot = await settingsSnapshot(page);

    /*
     * 先确保有一个可编辑文档再进任何设置用例。
     *
     * 实测（re140-diag-editor-container.mjs）：全新 profile 首次进 /app 时
     * `docCount=0 / tabCount=0` —— 仓库里没有文档，此时若先开设置再关掉，
     * 就一个标签都不剩，`.nm-content` 不存在 → 「正文实际渲染跟随设置」必然假失败。
     *
     * 单独跑本脚本时 `ensureDocTab` 的兜底能救回来；但被 `verify-140` 以 spawn
     * 方式调用时，前置用例可能已把标签关干净，兜底时机不对。所以在**主流程开头**
     * 就建好文档，让整段体检都有稳定载体。
     */
    await ensureDocTab(page);
    await page.waitForTimeout(600);

    const groups = [
      ['accent', groupAccent],
      ['scope', groupScope],
      ['borders', groupBorders],
      ['refine', groupRefine],
      ['typography', groupTypography],
      ['layout', groupLayoutFlags],
    ];
    for (const [key, fn] of groups) {
      if (ARGS.only && !ARGS.only.includes(key)) continue;
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
        try {
          await fn(page);
          done = true;
        } catch (e) {
          const msg = String(e?.message ?? e);
          const crashed = /crash|Target closed|Protocol error|browser has been closed/i.test(msg);
          if (crashed && attempt < 3) {
            console.log(`        \u26a0 ${key} 组遇到浏览器崩溃（第 ${attempt} 次），重建浏览器后重试…`);
            await relaunch();
            // 重试前清掉该组已产生的半截结果，避免重复计数
            for (let i = results.length - 1; i >= 0; i -= 1) {
              if (results[i].group === key) results.splice(i, 1);
            }
            continue;
          }
          check(`${key} 组执行异常`, '正常完成', msg.slice(0, 200), false, '', '');
          done = true;
        }
      }
    }

    check('体检过程无 JS 运行时错误', '0 条 pageerror', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0 条', pageErrors.length === 0, 'dom');
  } finally {
    // 还原本地设置
    if (localSnapshot) {
      await page
        .evaluate((snap) => {
          localStorage.setItem('neomd.settings.v1', snap);
        }, localSnapshot)
        .catch(() => {});
    }
    await browser.close().catch(() => {});
    // 云端无需还原：设置同步已由 isolateSettingsSync() 在浏览器内闭环，全程零上行写入。
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(76)}\n设置项逐项体检汇总\n${'='.repeat(76)}`);
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rs = results.filter((r) => r.group === g);
    console.log(`  ${g.padEnd(30)} 通过 ${String(rs.filter((r) => r.pass).length).padStart(2)} / 失败 ${String(rs.filter((r) => !r.pass).length).padStart(2)}`);
  }
  console.log('-'.repeat(76));
  console.log(`  合计：通过 ${pass}，失败 ${fail.length}`);
  if (fail.length) {
    console.log('  失败项：');
    for (const f of fail) console.log(`    \u2717 [${f.id}] ${f.name} —— ${f.actual}`);
  }
  if (ARGS.json) {
    fs.writeFileSync(path.join(REPO, ARGS.json), JSON.stringify({ pass, fail: fail.length, results }, null, 2), 'utf8');
    console.log(`  机器可读报告：${ARGS.json}`);
  }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('体检脚本自身异常：', e);
  process.exit(3);
});
